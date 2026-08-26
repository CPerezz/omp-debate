// Adversarial debate — pure orchestration.
//
// This module deliberately contains NO value imports from @oh-my-pi/pi-ai, only
// type-only ones. That keeps it runnable under plain `bun` (the pi-natives addon
// is unavailable outside the omp host), which is what makes the self-check at the
// bottom of this file executable. Host wiring lives in ./index.ts.
//
// Spec: ~/dev/docs/superpowers/specs/2026-08-26-debate-extension-design.md
// Self-check: `bun core.ts` (from the repo root)

import { strict as assert } from "node:assert";

import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type Role = "proposer" | "critic" | "adjudicator";
export type Mode = "plan" | "review";

export interface DebateParams {
	mode: Mode;
	goal: string;
	briefing: string;
	files?: string[];
	rounds?: number;
}

export interface Turn {
	role: Role;
	text: string;
	modelId: string;
	/** ≤10-line delta summary; absent when summarisation was skipped or failed. */
	summary?: string;
	/** True when a summariser was supplied but threw. */
	summaryFailed?: boolean;
}

export interface DebateTurnView extends Turn {
	chars: number;
}

export interface DebateView {
	turns: DebateTurnView[];
	/** Present only while a turn is streaming. */
	current?: { role: Role; tail: string };
	aborted: boolean;
	error?: string;
	model: string;
}

export type Summarizer = (turn: Turn, prior: readonly Turn[]) => Promise<string>;

export interface RunDebateDeps {
	runTurn: TurnRunner;
	summarize?: Summarizer;
	/** Called on every chunk and at every turn boundary. */
	onUpdate: (view: DebateView, transcript: string) => void;
}

export interface DebateOutcome {
	plan: string;
	transcript: string;
	turns: Turn[];
	aborted: boolean;
	error?: string;
	view: DebateView;
}

export interface TurnRequest {
	role: Role;
	system: string;
	prompt: string;
	/** Called at the start of every attempt so a retry can discard partial output. */
	onAttemptStart: () => void;
	onChunk: (delta: string) => void;
	signal?: AbortSignal;
}

export type TurnRunner = (req: TurnRequest) => Promise<{ text: string; modelId: string }>;

export const LABEL: Record<Role, string> = {
	proposer: "Proposer",
	critic: "Critic",
	adjudicator: "Adjudicator",
};

export function turnOrder(rounds: number): Role[] {
	const seq: Role[] = [];
	for (let i = 0; i < Math.max(1, rounds); i++) seq.push("proposer", "critic");
	seq.push("adjudicator");
	return seq;
}

export function systemFor(role: Role, mode: Mode, rounds: number, turnNo = 1): string {
	const total = role === "adjudicator" ? 1 : Math.max(1, rounds);
	const subject = mode === "plan" ? "implementation plan" : "review of an implementation";
	const common =
		`You are one of three models in a structured adversarial debate about an ${subject}.\n` +
		`This is your turn ${turnNo} of ${total}. Turns are few and each is slow, so every message must be ` +
		`exhaustive: raise every material concern now. A concern deferred to a turn that never comes is lost.\n` +
		`Do not restate the other party's position. Do not hedge, summarise, or praise. Dense technical ` +
		`substance only.\n` +
		`You have no tools. Reason only from the briefing you are given. Do NOT assert facts about code you ` +
		`have not been shown — if a claim depends on unseen code, label it explicitly as an assumption ` +
		`requiring verification.`;
	if (role === "proposer")
		return turnNo === 1
			? `${common}\n\nYour role: PROPOSER. Produce the strongest ${subject} you can.`
			: `${common}\n\nYour role: PROPOSER. You have already made your proposal; it is in the transcript. ` +
				`Rebut the critic point by point. Concede explicitly and immediately wherever the critic is right. ` +
				`Do NOT rewrite the proposal from scratch unless the critic exposed a flaw that invalidates its ` +
				`foundation — in that case say so plainly and state the minimal restructure.`;
	if (role === "critic")
		return turnNo === 1
			? `${common}\n\nYour role: CRITIC. Find what is wrong: unstated assumptions, missed cases, wrong ` +
				`ordering, underspecified interfaces, work that will not survive contact with reality. Do not ` +
				`write a competing plan — attack this one. Quote the exact text you are attacking.`
			: `${common}\n\nYour role: CRITIC. Respond ONLY to the proposer's rebuttal. Where the rebuttal ` +
				`answers you, say so and drop the point. Press only the points that remain genuinely unresolved. ` +
				`Do NOT manufacture new findings to fill this turn — if nothing material remains, say exactly ` +
				`that in one or two sentences and stop. A short honest turn is correct here.`;
	return (
		`${common}\n\nYour role: ADJUDICATOR. You speak once, last. Read the whole debate and write the ` +
		`final ${subject}. Adopt what survived criticism, discard what did not, and resolve every open ` +
		`disagreement explicitly — state the resolution and the reason. Emit ONLY the final ${subject}: no ` +
		`preamble, no meta-commentary about the debate. Your output is what will be executed, so it must be ` +
		`complete and self-contained.`
	);
}

export function promptFor(p: DebateParams, turns: Turn[], fileText: string): string {
	const parts = [`# Original request\n\n${p.goal}`, `# Briefing from the orchestrator\n\n${p.briefing}`];
	if (fileText) parts.push(`# Files\n\n${fileText}`);
	if (turns.length)
		parts.push(`# Debate so far\n\n${turns.map((t) => `## ${LABEL[t.role]}\n\n${t.text}`).join("\n\n")}`);
	return parts.join("\n\n");
}

export async function runDebate(
	p: DebateParams,
	deps: RunDebateDeps,
	fileText = "",
	signal?: AbortSignal,
): Promise<DebateOutcome> {
	const turns: Turn[] = [];
	const spoken: Record<Role, number> = { proposer: 0, critic: 0, adjudicator: 0 };
	let transcript = "";
	const view: DebateView = { turns: [], aborted: false, model: "" };
	// Eight lockstep call sites below must all emit the same (view, transcript) pair.
	const emit = () => deps.onUpdate(view, transcript);

	// Default 1 (3 calls), not 2: with fixed rounds the second exchange was
	// observed to add no new findings, so the extra 2 calls bought nothing.
	const rounds = p.rounds ?? 1;
	for (const role of turnOrder(rounds)) {
		if (signal?.aborted) {
			view.aborted = true;
			view.current = undefined;
			emit();
			return { plan: "", transcript, turns, aborted: true, view };
		}
		const before = transcript;
		const header = `${before ? "\n\n" : ""}## ${LABEL[role]}\n\n`;
		const turnNo = ++spoken[role];
		try {
			const { text, modelId } = await deps.runTurn({
				role,
				system: systemFor(role, p.mode, rounds, turnNo),
				prompt: promptFor(p, turns, fileText),
				onAttemptStart: () => {
					transcript = before + header;
					view.current = { role, tail: "" };
					emit();
				},
				onChunk: (d) => {
					transcript += d;
					if (view.current) view.current.tail += d;
					emit();
				},
				signal,
			});
			view.current = undefined;
			view.model = modelId;
			const turn: Turn = { role, text, modelId };
			if (deps.summarize) {
				try {
					turn.summary = await deps.summarize(turn, turns);
				} catch {
					// A summary is a reading aid. Losing it must not discard a turn
					// that already cost a model call.
					turn.summaryFailed = true;
				}
			}
			turns.push(turn);
			view.turns = turns.map((t) => ({ ...t, chars: t.text.length }));
			emit();
		} catch (err) {
			// Discard the failed turn entirely: a header with a truncated body reads
			// as a completed turn and would corrupt any transcript the caller keeps.
			transcript = before;
			view.current = undefined;
			// An abort surfaces here as a thrown AbortError. Labelling it `error`
			// would misreport a deliberate user interrupt as a failure.
			if (signal?.aborted) {
				view.aborted = true;
				emit();
				return { plan: "", transcript, turns, aborted: true, view };
			}
			view.error = String(err);
			emit();
			return { plan: "", transcript, turns, aborted: false, error: String(err), view };
		}
	}
	const last = turns.at(-1);
	return {
		plan: last?.role === "adjudicator" ? last.text : "",
		transcript,
		turns,
		aborted: false,
		view,
	};
}

/**
 * Every role runs on the `@plan` model.
 *
 * The role configuration in omp setup is deliberately chosen, so `@plan` is the
 * top tier available. Selecting a cross-lineage critic automatically was tried
 * and removed: with no capability ranking in the API it handed the critic a
 * `gemini-2.5-flash` against a `claude-fable-5:max` proposer, producing turns a
 * third the length, no new findings on the second turn, and two factual errors
 * the proposer had to spend its rebuttal correcting.
 *
 * Tradeoff accepted: one model argues with itself, so premature agreement is
 * guarded only by the adversarial role prompts. A capability deficit cannot be
 * prompted away; sycophancy partly can.
 */
export function pickModel(ctx: ExtensionContext): Model<Api> {
	// The docs demonstrate `@slow`; that a custom `modelRoles` entry takes the
	// same `@` prefix is unverified, hence the explicit fallback.
	const model = ctx.models.resolve("@plan") ?? ctx.models.current();
	if (!model) throw new Error("debate: no authenticated model available");
	return model;
}

export async function readFiles(paths?: string[]): Promise<string> {
	if (!paths?.length) return "";
	const out: string[] = [];
	for (const p of paths) {
		try {
			out.push(`## ${p}\n\n\`\`\`\n${await Bun.file(p).text()}\n\`\`\``);
		} catch (err) {
			// An unreadable path must not sink a debate that already cost model calls.
			out.push(`## ${p}\n\n(could not read: ${String(err)})`);
		}
	}
	return out.join("\n\n");
}

export async function demo(): Promise<void> {
	// 1. turn order
	const seen: Role[] = [];
	const prompts: Partial<Record<Role, string>> = {};
	const plain: TurnRunner = async (req) => {
		seen.push(req.role);
		prompts[req.role] = req.prompt;
		req.onAttemptStart();
		const text = `[${req.role}-said]`;
		req.onChunk(text);
		return { text, modelId: "fake" };
	};
	const p: DebateParams = { mode: "plan", goal: "G", briefing: "B", rounds: 2 };
	let live = "";
	const out = await runDebate(p, {
		runTurn: plain,
		onUpdate: (_v, t) => {
			live = t;
		},
	});
	assert.deepEqual(seen, ["proposer", "critic", "proposer", "critic", "adjudicator"], "turn order");
	assert.equal(out.plan, "[adjudicator-said]", "plan is adjudicator output");
	assert.equal(out.aborted, false);
	assert.equal(out.turns.length, 5);

	// 2. critic sees the proposer's text
	assert.ok(prompts.critic?.includes("[proposer-said]"), "critic context carries proposer text");

	// 3. abort mid-debate preserves completed turns
	const ac = new AbortController();
	let n = 0;
	const aborting: TurnRunner = async (req) => {
		if (++n === 3) ac.abort();
		req.onAttemptStart();
		req.onChunk(`[${req.role}-${n}]`);
		return { text: `[${req.role}-${n}]`, modelId: "fake" };
	};
	const a = await runDebate(p, { runTurn: aborting, onUpdate: () => {} }, "", ac.signal);
	assert.equal(a.aborted, true, "aborted flag");
	assert.ok(
		a.transcript.includes("[proposer-1]") && a.transcript.includes("[critic-2]"),
		"keeps paid-for turns",
	);
	assert.equal(a.plan, "", "no plan when aborted");

	// 4. a throwing turn preserves prior turns AND discards its own partial.
	// The fake emits a chunk before throwing: without that, the missing rollback
	// in the catch was invisible to this check.
	let m = 0;
	const failing: TurnRunner = async (req) => {
		req.onAttemptStart();
		if (++m === 2) {
			req.onChunk("HALF-WRITTEN");
			throw new Error("boom");
		}
		req.onChunk("[ok]");
		return { text: "[ok]", modelId: "fake" };
	};
	const f = await runDebate(p, { runTurn: failing, onUpdate: () => {} });
	assert.match(f.error ?? "", /boom/, "error surfaced");
	assert.equal(f.turns.length, 1, "prior turn kept");
	assert.ok(f.transcript.includes("[ok]"), "completed turn kept");
	assert.ok(!f.transcript.includes("HALF-WRITTEN"), "failed turn's partial discarded");
	assert.ok(!f.transcript.includes("## Critic"), "failed turn's header discarded too");
	assert.equal(f.aborted, false, "a genuine throw is not an abort");

	// 4b. an abort surfacing as a thrown error is labelled aborted, not error
	const ac2 = new AbortController();
	const abortThrower: TurnRunner = async (req) => {
		req.onAttemptStart();
		ac2.abort();
		throw new Error("AbortError: operation cancelled");
	};
	const ab = await runDebate(p, { runTurn: abortThrower, onUpdate: () => {} }, "", ac2.signal);
	assert.equal(ab.aborted, true, "mid-turn abort labelled aborted");
	assert.equal(ab.error, undefined, "mid-turn abort carries no error");

	// 4c. prompts are turn-indexed: turn 2 must not repeat turn 1's instruction
	const p1 = systemFor("proposer", "plan", 2, 1);
	const p2 = systemFor("proposer", "plan", 2, 2);
	const c1 = systemFor("critic", "plan", 2, 1);
	const c2 = systemFor("critic", "plan", 2, 2);
	assert.notEqual(p1, p2, "proposer turn 2 differs from turn 1");
	assert.notEqual(c1, c2, "critic turn 2 differs from turn 1");
	assert.ok(p2.includes("Rebut"), "proposer turn 2 rebuts");
	assert.ok(!p2.includes("Produce the strongest"), "proposer turn 2 does not re-draft");
	assert.ok(c2.includes("manufacture"), "critic turn 2 is told not to invent findings");
	assert.ok(p1.includes("turn 1 of 2") && p2.includes("turn 2 of 2"), "turn index stated");

	// 5. retry rolls the transcript back — text appears exactly once per turn
	const retrying: TurnRunner = async (req) => {
		req.onAttemptStart();
		req.onChunk("PARTIAL-"); // failed attempt leaves junk
		req.onAttemptStart(); // retry must discard it
		req.onChunk("WHOLE");
		return { text: "WHOLE", modelId: "fake" };
	};
	const r = await runDebate({ ...p, rounds: 1 }, { runTurn: retrying, onUpdate: () => {} });
	assert.equal(r.transcript.split("WHOLE").length - 1, 3, "one WHOLE per turn (3 turns)");
	assert.ok(!r.transcript.includes("PARTIAL"), "failed partial discarded");

	// 6. every role runs on the @plan model, with a fallback when it is unset
	const withPlanRole = {
		models: {
			resolve: (s: string) => (s === "@plan" ? { id: "claude-fable-5" } : undefined),
			current: () => ({ id: "something-else" }),
		},
	} as unknown as ExtensionContext;
	assert.equal(pickModel(withPlanRole).id, "claude-fable-5", "@plan role wins");

	const noPlanRole = {
		models: {
			resolve: () => undefined,
			current: () => ({ id: "session-model" }),
		},
	} as unknown as ExtensionContext;
	assert.equal(pickModel(noPlanRole).id, "session-model", "falls back to the session model");

	const noModels = {
		models: { resolve: () => undefined, current: () => undefined },
	} as unknown as ExtensionContext;
	assert.throws(() => pickModel(noModels), /no authenticated model/, "fails loudly with no model");

	// 7. unreadable path is reported inline, not thrown
	const missing = await readFiles(["/definitely/not/a/real/path.txt"]);
	assert.ok(missing.includes("could not read"), "unreadable file inlined");

	// 8. the emitted view tracks turns, summaries and the live speaker
	const views: DebateView[] = [];
	const summarised: TurnRunner = async (req) => {
		req.onAttemptStart();
		req.onChunk(`body-${req.role}`);
		return { text: `body-${req.role}`, modelId: "m1" };
	};
	const okSummary: Summarizer = async (turn, prior) => `delta for ${turn.role} after ${prior.length} prior`;
	const vOut = await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1 },
		{ runTurn: summarised, summarize: okSummary, onUpdate: (v) => views.push(structuredClone(v)) },
	);
	assert.equal(vOut.view.turns.length, 3, "view has every turn");
	assert.equal(vOut.view.turns[0].summary, "delta for proposer after 0 prior", "summary stored");
	assert.equal(vOut.view.turns[1].summary, "delta for critic after 1 prior", "prior passed to summariser");
	assert.equal(vOut.view.turns[0].chars, "body-proposer".length, "chars recorded");
	assert.equal(vOut.view.model, "m1", "model recorded");
	assert.equal(vOut.view.current, undefined, "no live speaker once finished");
	assert.ok(
		views.some((v) => v.current?.role === "critic" && v.current.tail.length > 0),
		"a mid-debate view exposed the live speaker and its tail",
	);

	// 8b. a failing summariser degrades without failing the debate
	const boomSummary: Summarizer = async () => {
		throw new Error("haiku down");
	};
	const degraded = await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1 },
		{ runTurn: summarised, summarize: boomSummary, onUpdate: () => {} },
	);
	assert.equal(degraded.error, undefined, "summariser failure does not fail the debate");
	assert.equal(degraded.view.turns.length, 3, "all turns still present");
	assert.equal(degraded.view.turns[0].summary, undefined, "no summary text");
	assert.equal(degraded.view.turns[0].summaryFailed, true, "failure flagged");

	// 8c. omitting the summariser entirely is legal
	const noSum = await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1 },
		{ runTurn: summarised, onUpdate: () => {} },
	);
	assert.equal(noSum.view.turns[0].summary, undefined, "no summariser, no summary");
	assert.equal(noSum.view.turns[0].summaryFailed, undefined, "and no failure flag either");

	assert.ok(live.length > 0, "onTranscript was called");
	console.log("debate core self-check OK");
}

if (import.meta.main) await demo();
