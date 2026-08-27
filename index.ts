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
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	ExtensionAPI,
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import {
	MAX_DEBATERS,
	MIN_DEBATERS,
	type DebateOutcome,
	type DebateParams,
	type DebateView,
	type GateAnswer,
	type GateIO,
	type GateRunner,
	type Summarizer,
	type TurnRunner,
	type Ultrathink,
	neededFiles,
	pickModel,
	readFiles,
	runDebate,
	runGateDialogs,
	seatingFor,
} from "./core.js";
import { type RenderHelpers, renderDebate } from "./render.js";

/** Per-turn output cap. The exhaustiveness mandate makes turns long by design. */
const MAX_TURN_TOKENS = 32_000;
/** Thinking tokens are drawn from the same output budget, so an ultrathink turn
 *  that spends 30k reasoning would otherwise trip the `length` stop below. */
const MAX_TURN_TOKENS_ULTRA = 64_000;

/** `Effort` is an ambient `declare const enum`: naming a member as a value emits
 *  a reference bun cannot resolve out-of-host, so the literal is cast instead. */
const MAX_EFFORT = "max" as Effort;

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
			? prior.map((t) => `## ${t.label}\n\n${t.text}`).join("\n\n")
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
						content: `# Debate so far\n\n${context}\n\n# The turn to compress (${turn.label})\n\n${turn.text}`,
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
		const maxTokens = req.ultra ? MAX_TURN_TOKENS_ULTRA : MAX_TURN_TOKENS;
		const msg = await retryTransientCompletion(async () => {
			// Re-entered on every retry attempt; resets this turn's partial output.
			req.onAttemptStart();
			const s = streamSimple(
				model,
				{ systemPrompt: [req.system], messages: [{ role: "user", content: req.prompt }] },
				{
					apiKey: ctx.modelRegistry.resolver(model, sessionId),
					maxTokens,
					// The `@plan` role may carry a `:max` suffix, but `models.resolve()`
					// strips it and the effort is not recoverable from the Model — so a
					// requested ultrathink turn must state the effort explicitly here.
					...(req.ultra ? { reasoning: MAX_EFFORT } : {}),
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
				`debate: ${req.label} turn hit the ${maxTokens}-token output cap and was ` +
					`truncated; re-run with a shorter briefing or fewer files`,
			);
		return { text, modelId: model.id };
	};
}

/** `ExtensionUIDialogOptions.timeout` is MILLISECONDS, though nothing in its type
 *  says so (`CountdownTimer(timeoutMs)` in ask-dialog.ts). Passing seconds here
 *  made every pre-flight dialog self-answer with its recommended option in a
 *  tenth of a second — see docs/harness-notes.md item 9. */
const PREFLIGHT_TIMEOUT_MS = 120_000;
const CUSTOM_COUNT_TIMEOUT_MS = 60_000;

const DEBATER_OPTIONS = [
	{ label: "2 — proposer vs critic", description: "Cheapest: 3 model calls at rounds=1." },
	{ label: "3 — 2 proposers + 1 critic", description: "Two rival plans, one critic." },
	{
		label: "4 — 2 proposers + 2 critics",
		description: "Two rival plans; critics split correctness vs simplicity.",
	},
	{ label: "Custom…", description: `Any count from ${MIN_DEBATERS} to ${MAX_DEBATERS}.` },
];
const ULTRA_OPTIONS = [
	{ label: "Adjudicator only", description: "Maximum effort where the decision is actually made." },
	{ label: "All agents", description: "Every seat at maximum effort. Slowest and most expensive." },
	{ label: "No ultrathink", description: "Provider defaults for every seat." },
];
const INTERACTIVE_OPTIONS = [
	{ label: "No — run it start to finish", description: "The debate never stops to ask." },
	{
		label: "Yes — stop after each round for my questions (experimental)",
		description: "You may question or challenge any agent; each answer costs one model call.",
	},
];
const ULTRA_BY_LABEL: Record<string, Ultrathink> = {
	"Adjudicator only": "adjudicator",
	"All agents": "all",
	"No ultrathink": "none",
};

interface Preflight {
	debaters: number;
	ultrathink: Ultrathink;
	/** Whether to pause at round boundaries for the user's questions. */
	interactive: boolean;
	/** True when the user answered the dialog, so the notes can say so. */
	asked: boolean;
}

/**
 * Ask the user how to run this debate, unless the caller already decided or
 * there is no interactive surface to ask through.
 *
 * A cancelled or timed-out dialog resolves to the cheap defaults rather than
 * failing: the user asked for a debate, and refusing to run one because a
 * picker timed out would be the more surprising outcome.
 */
async function resolvePreflight(
	params: DebateParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<Preflight> {
	const haveDebaters = typeof params.debaters === "number";
	const haveUltra = typeof params.ultrathink === "string";
	const haveInteractive = typeof params.interactive === "boolean";
	const fallback: Preflight = {
		debaters: params.debaters ?? MIN_DEBATERS,
		ultrathink: params.ultrathink ?? "none",
		interactive: params.interactive ?? false,
		asked: false,
	};
	// Never block an unattended run (print/RPC/ACP) on a dialog nobody can answer.
	if ((haveDebaters && haveUltra && haveInteractive) || !ctx.hasUI || !ctx.ui.askDialog) return fallback;

	const questions: ExtensionAskDialogQuestion[] = [];
	if (!haveDebaters)
		questions.push({
			id: "debaters",
			header: "Debate size",
			question: "How many agents should debate? An adjudicator is always added on top.",
			options: DEBATER_OPTIONS,
			recommended: 0,
		});
	if (!haveUltra)
		questions.push({
			id: "ultrathink",
			header: "Ultrathink",
			question: "Force maximum reasoning effort?",
			options: ULTRA_OPTIONS,
			recommended: 0,
		});
	if (!haveInteractive)
		questions.push({
			id: "interactive",
			header: "Your turn",
			question:
				"Join the debate? You would be asked after every round, and after the verdict, whether to " +
				"question or challenge any agent.",
			options: INTERACTIVE_OPTIONS,
			recommended: 0,
		});

	const answer = await ctx.ui.askDialog(questions, { signal, timeout: PREFLIGHT_TIMEOUT_MS });
	// `undefined` = cancelled; `kind: "chat"` = the user redirected to chat.
	if (!answer || answer.kind !== "submit") return fallback;
	// A timeout does NOT resolve `undefined`: the host fills every unanswered
	// question with its `recommended` option and submits with `timedOut: true`
	// (`ask-dialog.ts`, `#handleTimeout`). Without this an unattended dialog would
	// silently start a max-effort debate, contradicting the documented contract
	// that a timeout runs the cheap defaults.
	if (answer.results.some((r) => r.timedOut)) return fallback;

	const out: Preflight = { ...fallback, asked: true };
	for (const item of answer.results) {
		const picked = item.selectedOptions[0] ?? item.customInput ?? "";
		if (item.id === "ultrathink") {
			out.ultrathink = ULTRA_BY_LABEL[picked] ?? "none";
			continue;
		}
		if (item.id === "interactive") {
			out.interactive = picked.startsWith("Yes");
			continue;
		}
		if (item.id !== "debaters") continue;
		const typed = picked.startsWith("Custom")
			? await ctx.ui.input(`Debaters (${MIN_DEBATERS}–${MAX_DEBATERS})`, "4", {
					signal,
					timeout: CUSTOM_COUNT_TIMEOUT_MS,
				})
			: picked;
		const n = Number.parseInt(typed ?? "", 10);
		// seatingFor clamps too, but keeping `debaters` honest keeps the notes line
		// from advertising a count the debate never used.
		out.debaters = Number.isNaN(n) ? MIN_DEBATERS : Math.min(MAX_DEBATERS, Math.max(MIN_DEBATERS, n));
	}
	return out;
}

/** Dialog budget at a gate, in milliseconds (see PREFLIGHT_TIMEOUT_MS). Generous,
 *  because the user is being asked to think — bounded, because the debate holds
 *  the session's turn open while it waits. */
const GATE_TIMEOUT_MS = 300_000;

/**
 * The interactive gate: supplies the two host calls `runGateDialogs` needs and
 * nothing else. All sequencing, copy and target resolution live in `core.ts`,
 * where they run — and are asserted — under plain `bun`.
 *
 * `undefined` when there is no interactive surface. That is the single switch the
 * whole feature hangs off: `runDebate` skips every gate when the runner is
 * absent, so an unattended run cannot stall on a dialog nobody can see.
 */
export function makeGateRunner(
	ctx: ExtensionContext,
	ultrathink: Ultrathink,
	signal?: AbortSignal,
): GateRunner | undefined {
	if (!ctx.hasUI || !ctx.ui.askDialog) return undefined;
	const askDialog = ctx.ui.askDialog.bind(ctx.ui);
	const io: GateIO = {
		ask: (q) =>
			askDialog(
				[
					{
						id: q.id,
						header: q.header,
						question: q.question,
						options: q.options as ExtensionAskDialogOption[],
						...(q.multi === undefined ? {} : { multi: q.multi }),
						...(q.recommended === undefined ? {} : { recommended: q.recommended }),
					},
				],
				{ signal, timeout: GATE_TIMEOUT_MS },
			) as Promise<GateAnswer>,
		edit: (title) =>
			ctx.ui.editor(
				title,
				"",
				{
					// No `timeout`: the host never wires one into the editor
					// (`extension-ui-controller.ts`, showHookEditor), and a half-typed
					// challenge should not vanish on a clock anyway.
					signal,
				},
				// Enter submits, Shift+Enter inserts a newline. The default (hook-style)
				// chord is Ctrl+Q / Ctrl+Enter, which is the wrong bet for a paid action:
				// driving a real TUI, a raw Ctrl+Q never reached the editor, and the
				// host's own source notes some terminals cannot deliver a distinct
				// Ctrl+Enter at all. Prompt-style also matches the ask dialog's own
				// free-text overlay, so the whole gate flow submits on one key.
				{ promptStyle: true },
			),
	};
	return (info) => runGateDialogs(info, io, ultrathink, signal);
}

/** Repaint cadence for the thinking animation. The host only advances
 *  `spinnerFrame` when a tool emits an update, so without a heartbeat the dots
 *  freeze exactly when a model is thinking hardest and streaming nothing. */
const HEARTBEAT_MS = 300;

export default function debateExtension(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "debate",
		label: "Adversarial Debate",
		description:
			"Convene multiple models (default three) in a proposer/critic/adjudicator debate over a plan " +
			"or an implementation review, and return the adjudicated plan. Expensive: rounds × debaters + 1 " +
			"model calls with long messages, plus one per agent the user addresses at an interactive gate. " +
			"When `debaters`/`ultrathink`/`interactive` are omitted and a TUI " +
			"is present, the tool asks the user directly before starting — only pass them when the user " +
			"already specified.",
		// Deliberately NOT "read": this can spend rounds × debaters + 1 max-effort
		// calls, plus one per agent addressed at a gate, so it belongs behind the
		// same gate as other consequential operations.
		// Top-level rather than the extension default of "discoverable":
		// /plan-debate and /review-debate instruct the orchestrator to call this by
		// name, so it must always be in the active set.
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
				.describe("Proposer/critic exchanges before adjudication (default 1; each adds a call per debater)"),
			debaters: z
				.number()
				.int()
				.min(MIN_DEBATERS)
				.max(MAX_DEBATERS)
				.optional()
				.describe(
					"Debating agents, excluding the adjudicator (2 = proposer vs critic; 3 = 2 proposers + " +
						"1 critic; 4 = 2 proposers + 2 critics). Omit to let the tool ask the user.",
				),
			ultrathink: z
				.enum(["none", "adjudicator", "all"])
				.optional()
				.describe(
					"Force maximum reasoning effort for the named agents. Omit to let the tool ask the user.",
				),
			interactive: z
				.boolean()
				.optional()
				.describe(
					"Pause after every round, and after the verdict, so the user can question or challenge " +
						"individual agents. Omit to let the tool ask the user.",
				),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const p = params as DebateParams;
			const { debaters, ultrathink, interactive, asked } = await resolvePreflight(p, ctx, signal);
			const model = pickModel(ctx);
			const fileText = await readFiles(p.files);
			const summarize = makeSummarizer(ctx, signal);
			const gate = interactive ? makeGateRunner(ctx, ultrathink, signal) : undefined;

			let latest: { view: DebateView; transcript: string } | undefined;
			let dirty = false;
			let prevKey = "";
			const forward = () => {
				if (!latest) return;
				dirty = false;
				onUpdate?.({
					// `content` is the model-visible payload and stays plain text.
					content: [{ type: "text", text: latest.transcript }],
					// `details` carries the view the renderer paints; shallow-copied so a
					// host that reference-compares sees a changed object each repaint.
					details: {
						...latest.view,
						current: latest.view.current && { ...latest.view.current },
						gate: latest.view.gate && { ...latest.view.gate },
					},
				});
			};
			const timer = ctx.setInterval(() => {
				if (dirty || latest?.view.current) forward();
			}, HEARTBEAT_MS);

			let out: DebateOutcome;
			try {
				out = await runDebate(
					{ ...p, debaters, ultrathink },
					{
						runTurn: makeTurnRunner(ctx, model),
						summarize,
						gate,
						onUpdate: (view, transcript) => {
							// Turn boundaries paint immediately; per-token chunks only mark
							// the view dirty so the heartbeat coalesces them — re-sending the
							// whole transcript per token is O(n²) bytes over RPC. A gate
							// opening or closing paints at once too: nothing is streaming
							// then, so the heartbeat would not repaint it on its own.
							const key = `${view.current?.label ?? ""}|${view.turns.length}|${view.aborted}|${view.error ?? ""}|${view.gate?.kind ?? ""}${view.gate?.round ?? ""}`;
							latest = { view, transcript };
							if (key !== prevKey) {
								prevKey = key;
								forward();
							} else dirty = true;
						},
					},
					fileText,
					signal,
				);
			} finally {
				ctx.clearTimer(timer);
			}

			const seating = seatingFor(debaters);
			const notes: string[] = [];
			if (out.aborted) notes.push("Debate aborted; transcript is partial.");
			if (out.error) notes.push(`Debate failed: ${out.error}`);
			notes.push(`All roles ran on ${model.id} (the \`@plan\` role).`);
			notes.push(
				`Debaters: ${seating.proposers} proposer(s) + ${seating.critics} critic(s); ` +
					`ultrathink: ${ultrathink}${asked ? " (chosen interactively)" : ""}.`,
			);
			notes.push(...out.notes);
			const interjections = out.turns.filter((t) => t.role === "user").length;
			if (interjections)
				notes.push(`You interjected ${interjections} time(s); your turns are in the transcript above.`);
			if (interactive && !gate)
				notes.push(
					"Interactive gates were requested, but this run has no TUI to ask through; the debate ran " +
						"straight through.",
				);
			if (!summarize) notes.push("No cheap model resolved for summaries; bubbles show head lines.");
			if (p.mode === "review") {
				notes.push(
					"Review performed by toolless models over the supplied briefing only. They could not " +
						"read the codebase; findings AND omissions are bounded by what was pasted in.",
				);
				// Turns the toolless-review gap from silent into actionable: the critics
				// name what they were not shown, so the caller can re-run with it.
				const missing = neededFiles(out.turns);
				if (missing.length)
					notes.push(
						`Critics flagged files they were not shown: ${missing.join(", ")}. Re-run with these ` +
							"in `files` for a deeper review.",
					);
			}

			const body = out.plan || out.transcript || "(no output)";
			return {
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

	// ponytail: /review-debate debaters are toolless and can only discuss the
	// briefing they are handed — they cannot grep for a missed callsite, which is
	// the defect class review most needs to catch. Partly mitigated: critics are
	// asked to emit a `NEEDED FILES:` trailer and the tool surfaces it as a note,
	// so a second run can carry what the first was missing. Upgrade path, if that
	// proves too weak: let a critic emit `NEED: <path>` and re-run its turn once
	// with those files — realpath-resolved and confined to the repo root, dotfiles
	// excluded, existing 64 KB/256 KB caps applied. A read-only scout subagent is
	// NOT the upgrade path: the extension API exposes no spawn primitive (see
	// docs/harness-notes.md item 6).
	//
	// Names are suffixed `-debate` because the interactive TUI owns a built-in
	// `/plan` (the plan-mode toggle) that intercepts the name before extension
	// dispatch — a bare `/plan` registration here never fires.
	for (const mode of ["plan", "review"] as const) {
		pi.registerCommand(`${mode}-debate`, {
			description: `Convene an adversarial ${mode} debate`,
			handler: async (args) => {
				const focus = args.trim();
				pi.sendUserMessage(
					`Convene the adversarial debate for this ${mode}. Call the \`debate\` tool with ` +
						`mode="${mode}", and a \`briefing\` you curate: the constraints, the decisions already ` +
						`settled, and the code shape the debaters need. They have no tools and see only what you ` +
						`write. For \`goal\`: use my original request verbatim if this conversation has one; ` +
						(focus
							? `otherwise the following text IS the goal: ${focus}. `
							: `if there is no prior request, ask me for one rather than inventing it. `) +
						`Leave the \`debaters\`, \`ultrathink\` and \`interactive\` parameters unset — the tool ` +
						`asks me directly; pass them only if I already specified them. ` +
						(mode === "review"
							? `Before you call it: grep for the callsites and usages of the code under review and ` +
								`paste them into the briefing, because the debaters cannot look anything up. When it ` +
								`returns, verify any file:line claim yourself before acting on it. `
							: "") +
						`When the tool returns, do not just tell me a plan exists — I cannot read a path. Write ` +
						`the adjudicated plan verbatim to a markdown file OUTSIDE this repo (e.g. under ` +
						`~/dev/docs/superpowers/specs/), never commit it, then run ` +
						`\`plannotator annotate <path> --gate\` if that binary is on PATH so I can approve or ` +
						`annotate it in the browser; if it is not, print the plan in full in your reply.`,
				);
			},
		});
	}
}
