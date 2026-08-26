// Adversarial debate — host wiring.
//
// Static value imports from @oh-my-pi/pi-ai live here and nowhere else, so the
// pure orchestration in ./core.ts stays runnable under plain `bun`.
//
// Specs: ~/dev/docs/superpowers/specs/2026-08-26-debate-extension-design.md
//        ~/dev/docs/superpowers/specs/2026-08-26-debate-chat-rendering-design.md

import { retryTransientCompletion, streamSimple } from "@oh-my-pi/pi-ai";
import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

import type { Api, Model, TextContent } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import {
	type DebateParams,
	type DebateView,
	type Summarizer,
	type TurnRunner,
	pickModel,
	readFiles,
	runDebate,
} from "./core.js";
import { type RenderHelpers, renderDebate } from "./render.js";

/** Per-turn output cap. The exhaustiveness mandate makes turns long by design. */
const MAX_TURN_TOKENS = 32_000;

/** Real ANSI-aware helpers. Injected so render.ts stays host-free and testable. */
const HELPERS: RenderHelpers = {
	visibleWidth,
	wrap: wrapTextWithAnsi,
	// `ellipsisKind` is the Ellipsis enum re-exported by pi-tui, not a string.
	truncate: (text, width) => truncateToWidth(text, width, Ellipsis.Unicode),
};

const SUMMARY_MAX_TOKENS = 700;
/** Belt-and-braces cap; the renderer also slices, but a runaway summary should
 *  not bloat `details` on every streamed update. */
const MAX_SUMMARY_LINES_GUARD = 10;

/**
 * Delta summariser. `@smol` first, then a haiku match; `undefined` when neither
 * resolves, which makes summarisation a no-op rather than an error.
 *
 * `signal` is captured per execution so aborting a debate also abandons an
 * in-flight summary instead of leaving it running.
 */
export function makeSummarizer(ctx: ExtensionContext, signal?: AbortSignal): Summarizer | undefined {
	const model = ctx.models.resolve("@smol") ?? ctx.models.list().find((m) => /haiku/i.test(m.id));
	if (!model) return undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	return async (turn, prior) => {
		const context = prior.length
			? prior.map((t) => `## ${t.role}\n\n${t.text}`).join("\n\n")
			: "(this is the opening turn)";
		const s = streamSimple(
			model,
			{
				systemPrompt: [
					"You compress one turn of a technical debate into at most 10 short lines. " +
						"State only what this turn CHANGED relative to the debate so far: what it " +
						"conceded, what it is still pressing, what is new. No preamble, no restatement " +
						"of the opponent, no praise. Bullet lines starting with '• '. Never exceed 10 lines.",
				],
				messages: [
					{
						role: "user",
						content: `# Debate so far\n\n${context}\n\n# The turn to compress (${turn.role})\n\n${turn.text}`,
					},
				],
			},
			{
				apiKey: ctx.modelRegistry.resolver(model, sessionId),
				maxTokens: SUMMARY_MAX_TOKENS,
				signal,
			},
		);
		// Drain so the stream completes; only the final message is needed.
		for await (const _event of s) void _event;
		const msg = await s.result();
		return msg.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("")
			.split("\n")
			.slice(0, MAX_SUMMARY_LINES_GUARD)
			.join("\n")
			.trim();
	};
}

export function makeTurnRunner(ctx: ExtensionContext, model: Model<Api>): TurnRunner {
	return async (req) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const msg = await retryTransientCompletion(async () => {
			// Re-entered on every retry attempt; resets this turn's partial output.
			req.onAttemptStart();
			const s = streamSimple(
				model,
				{ systemPrompt: [req.system], messages: [{ role: "user", content: req.prompt }] },
				{
					apiKey: ctx.modelRegistry.resolver(model, sessionId),
					maxTokens: MAX_TURN_TOKENS,
					signal: req.signal,
				},
			);
			for await (const ev of s) if (ev.type === "text_delta") req.onChunk(ev.delta);
			return await s.result();
		});
		const text = msg.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
		// A `length` stop means maxTokens truncated this turn. Silently returning a
		// half-written adjudicator plan as if complete is the worst failure this
		// tool has, so it is surfaced as an error rather than swallowed.
		if (msg.stopReason === "length")
			throw new Error(
				`debate: ${req.role} turn hit the ${MAX_TURN_TOKENS}-token output cap and was ` +
					`truncated; re-run with a shorter briefing or fewer files`,
			);
		return { text, modelId: model.id };
	};
}

export default function debateExtension(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "debate",
		label: "Adversarial Debate",
		description:
			"Convene three models in a proposer/critic/adjudicator debate over a plan or an implementation " +
			"review, and return the adjudicated plan. Expensive: 2*rounds+1 model calls with long messages.",
		// Deliberately NOT "read": this can spend 2*rounds+1 max-effort calls, so it
		// belongs behind the same gate as other consequential operations.
		approval: "exec",
		// Top-level rather than the extension default of "discoverable": /plan and
		// /review instruct the orchestrator to call this by name, so it must always
		// be in the active set.
		loadMode: "essential",
		parameters: z.object({
			mode: z.enum(["plan", "review"]).describe("plan = design a plan; review = critique an implementation"),
			goal: z.string().describe("The user's original request, verbatim and unsummarised"),
			briefing: z
				.string()
				.describe(
					"Curated context the debaters need: constraints, decisions already made, relevant code " +
						"shape. They have no tools and see nothing but this.",
				),
			files: z.array(z.string()).optional().describe("Paths to include verbatim"),
			rounds: z
				.number()
				.int()
				.min(1)
				.max(4)
				.optional()
				.describe("Proposer/critic exchanges before adjudication (default 1; each adds 2 calls)"),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const model = pickModel(ctx);
			const fileText = await readFiles(params.files);
			const summarize = makeSummarizer(ctx, signal);
			const out = await runDebate(
				params as DebateParams,
				{
					runTurn: makeTurnRunner(ctx, model),
					summarize,
					onUpdate: (view, transcript) =>
						onUpdate?.({ content: [{ type: "text", text: transcript }], details: view }),
				},
				fileText,
				signal,
			);

			const notes: string[] = [];
			if (out.aborted) notes.push("Debate aborted; transcript is partial.");
			if (out.error) notes.push(`Debate failed: ${out.error}`);
			notes.push(`All roles ran on ${model.id} (the \`@plan\` role).`);
			if (!summarize) notes.push("No cheap model resolved for summaries; bubbles show head lines.");
			if (params.mode === "review")
				notes.push(
					"Review performed by toolless models over the supplied briefing only. They could not " +
						"read the codebase; findings AND omissions are bounded by what was pasted in.",
				);

			const body = out.plan || out.transcript || "(no output)";
			return {
				// `content` is the model-visible payload and stays plain text.
				// `details` carries the view the renderer paints; the transcript is
				// not duplicated into it, which halves the bytes streamed per chunk.
				content: [{ type: "text", text: notes.length ? `${body}\n\n---\n${notes.join("\n")}` : body }],
				details: out.view,
				isError: Boolean(out.error),
			};
		},
		renderResult(result, options, theme) {
			return renderDebate(
				result.details as DebateView,
				{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
				theme,
				HELPERS,
			);
		},
	});

	// ponytail: /review debaters are toolless and can only discuss the briefing
	// they are handed — they cannot grep for a missed callsite, which is the
	// defect class review most needs to catch. Upgrade path: give the critic a
	// read-only scout subagent for that role only.
	for (const mode of ["plan", "review"] as const) {
		pi.registerCommand(mode, {
			description: `Convene an adversarial ${mode} debate`,
			handler: async (args) => {
				const focus = args.trim();
				pi.sendUserMessage(
					`Convene the adversarial debate for this ${mode}. Call the \`debate\` tool with ` +
						`mode="${mode}", and a \`briefing\` you curate: the constraints, the decisions already ` +
						`settled, and the code shape the debaters need. They have no tools and see only what you ` +
						`write. For \`goal\`: use my original request verbatim if this conversation has one; ` +
						(focus
							? `otherwise the following text IS the goal: ${focus}`
							: `if there is no prior request, ask me for one rather than inventing it.`),
				);
			},
		});
	}
}
