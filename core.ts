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
/** Which seats are told to spend maximum reasoning effort. */
export type Ultrathink = "none" | "adjudicator" | "all";

export interface DebateParams {
	mode: Mode;
	goal: string;
	briefing: string;
	files?: string[];
	rounds?: number;
	/** Debating agents excluding the adjudicator (2–6). Default 2. */
	debaters?: number;
	ultrathink?: Ultrathink;
}

/** How `debaters` is split into speaking seats. */
export interface Seating {
	proposers: number;
	critics: number;
}

/** One participant. `seat` is 1-based within the role. */
export interface Speaker {
	role: Role;
	seat: number;
	label: string;
}

export interface Turn {
	role: Role;
	seat: number;
	/** Display/transcript name, e.g. "Proposer B". Unique within a debate. */
	label: string;
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
	/** Present only while a turn is in flight (streaming OR being summarised).
	 *  Carries no text: the renderer paints a thinking animation, not a tail. */
	current?: { role: Role; seat: number; label: string };
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
	label: string;
	system: string;
	prompt: string;
	/** True when this seat should run at maximum reasoning effort. */
	ultra: boolean;
	/** Called at the start of every attempt so a retry can discard partial output. */
	onAttemptStart: () => void;
	onChunk: (delta: string) => void;
	signal?: AbortSignal;
}

export type TurnRunner = (req: TurnRequest) => Promise<{ text: string; modelId: string }>;

const ROLE_BASE: Record<Role, string> = {
	proposer: "Proposer",
	critic: "Critic",
	adjudicator: "Adjudicator",
};

export const MIN_DEBATERS = 2;
export const MAX_DEBATERS = 6;

/**
 * Split `debaters` into proposers and critics.
 *
 * Two rival proposers are used whenever the budget allows, because a single
 * model arguing with itself concedes too readily; a genuine second proposal is
 * what forces the adjudicator to choose rather than rubber-stamp. Only the
 * 2-debater floor drops to one proposer (there would be no critic otherwise).
 */
export function seatingFor(debaters: number): Seating {
	const n = Math.min(MAX_DEBATERS, Math.max(MIN_DEBATERS, Math.trunc(debaters) || MIN_DEBATERS));
	const proposers = n <= 2 ? 1 : 2;
	return { proposers, critics: n - proposers };
}

/** Every speaker once, in speaking order: proposers, critics, then the adjudicator.
 *  Labels are unsuffixed when a role holds one seat and lettered when it holds
 *  several, so the transcript and every bubble header name a unique speaker. */
export function speakersFor(s: Seating): Speaker[] {
	const out: Speaker[] = [];
	for (const [role, seats] of [
		["proposer", s.proposers],
		["critic", s.critics],
	] as const)
		for (let i = 1; i <= seats; i++)
			out.push({
				role,
				seat: i,
				// charCode 65 is "A", so seat 1 → "A", seat 2 → "B".
				label: seats <= 1 ? ROLE_BASE[role] : `${ROLE_BASE[role]} ${String.fromCharCode(64 + i)}`,
			});
	out.push({ role: "adjudicator", seat: 1, label: ROLE_BASE.adjudicator });
	return out;
}

/** Per round every proposer then every critic; the adjudicator speaks once, last. */
export function turnOrder(rounds: number, s: Seating): Speaker[] {
	const all = speakersFor(s);
	const debaters = all.filter((sp) => sp.role !== "adjudicator");
	const seq: Speaker[] = [];
	for (let i = 0; i < Math.max(1, rounds); i++) seq.push(...debaters);
	seq.push(all[all.length - 1]);
	return seq;
}

/** Lens text keeps multiple critics from all reporting the same finding. Seats
 *  past the named lenses mop up whatever those two did not cover. */
const CRITIC_LENSES = [
	" Your assigned lens: correctness, completeness, and hidden coupling.",
	" Your assigned lens: over-engineering, simplicity (YAGNI), failure modes, and operational reality.",
];
const CRITIC_LENS_OVERFLOW =
	" Lens: anything material the other critics missed — do not duplicate their findings.";

const ULTRA_SUFFIX =
	"\n\nultrathink: engage maximum reasoning effort. Think through every branch, edge case, and " +
	"counterargument exhaustively before writing your answer.";

export function systemFor(
	sp: Speaker,
	mode: Mode,
	rounds: number,
	turnNo: number,
	s: Seating,
	ultra: boolean,
): string {
	const total = sp.role === "adjudicator" ? 1 : Math.max(1, rounds);
	const subject = mode === "plan" ? "implementation plan" : "review of an implementation";
	const models = s.proposers + s.critics + 1;
	const rivals = s.proposers === 2;
	const common =
		`You are one of ${models} models in a structured adversarial debate about an ${subject}.\n` +
		`You are ${sp.label}; the transcript labels every turn by speaker.\n` +
		`This is your turn ${turnNo} of ${total}. Turns are few and each is slow, so every message must be ` +
		`exhaustive: raise every material concern now. A concern deferred to a turn that never comes is lost.\n` +
		`Do not restate the other party's position. Do not hedge, summarise, or praise. Dense technical ` +
		`substance only.\n` +
		`You have no tools. Reason only from the briefing you are given. Do NOT assert facts about code you ` +
		`have not been shown — if a claim depends on unseen code, label it explicitly as an assumption ` +
		`requiring verification.`;

	let body: string;
	if (sp.role === "proposer") {
		if (turnNo === 1)
			body =
				sp.seat === 1
					? `Your role: PROPOSER. Produce the strongest ${subject} you can.`
					: `Your role: PROPOSER. A rival proposal already exists in the transcript. Produce a ` +
						`genuinely different strongest alternative — different architecture, ordering, or tradeoffs ` +
						`where defensible. Do not restate or lightly edit the rival; if after honest analysis the ` +
						`rival's foundation is the only sound one, say so and propose the strongest variant that ` +
						`differs in the decisions that remain open.`;
		else
			body =
				`Your role: PROPOSER. You have already made your proposal; it is in the transcript. ` +
				`Rebut the critic point by point. Concede explicitly and immediately wherever the critic is right. ` +
				`Do NOT rewrite the proposal from scratch unless the critic exposed a flaw that invalidates its ` +
				`foundation — in that case say so plainly and state the minimal restructure.` +
				(rivals
					? ` Where the rival proposal handles a criticism better than yours, concede and adopt it ` +
						`explicitly.`
					: "");
	} else if (sp.role === "critic") {
		body =
			turnNo === 1
				? `Your role: CRITIC. Find what is wrong: unstated assumptions, missed cases, wrong ` +
					`ordering, underspecified interfaces, work that will not survive contact with reality. Do not ` +
					`write a competing plan — attack this one. Quote the exact text you are attacking.` +
					(rivals
						? ` Attack every proposal on the table; compare them where the comparison is instructive.`
						: "") +
					(s.critics <= 1 ? "" : (CRITIC_LENSES[sp.seat - 1] ?? CRITIC_LENS_OVERFLOW))
				: `Your role: CRITIC. Respond ONLY to the proposer's rebuttal. Where the rebuttal ` +
					`answers you, say so and drop the point. Press only the points that remain genuinely unresolved. ` +
					`Do NOT manufacture new findings to fill this turn — if nothing material remains, say exactly ` +
					`that in one or two sentences and stop. A short honest turn is correct here.`;
	} else {
		body =
			`Your role: ADJUDICATOR. You speak once, last. Read the whole debate and write the ` +
			`final ${subject}. Adopt what survived criticism, discard what did not, and resolve every open ` +
			`disagreement explicitly — state the resolution and the reason. Emit ONLY the final ${subject}: no ` +
			`preamble, no meta-commentary about the debate. Your output is what will be executed, so it must be ` +
			`complete and self-contained.` +
			(rivals
				? ` Two rival proposals were debated. Choose the stronger foundation or merge them ` +
					`explicitly — state what you adopted from each and why.`
				: "");
	}
	return `${common}\n\n${body}${ultra ? ULTRA_SUFFIX : ""}`;
}

export function promptFor(p: DebateParams, turns: Turn[], fileText: string): string {
	const parts = [`# Original request\n\n${p.goal}`, `# Briefing from the orchestrator\n\n${p.briefing}`];
	if (fileText) parts.push(`# Files\n\n${fileText}`);
	if (turns.length)
		parts.push(`# Debate so far\n\n${turns.map((t) => `## ${t.label}\n\n${t.text}`).join("\n\n")}`);
	return parts.join("\n\n");
}

export async function runDebate(
	p: DebateParams,
	deps: RunDebateDeps,
	fileText = "",
	signal?: AbortSignal,
): Promise<DebateOutcome> {
	const turns: Turn[] = [];
	const spoken = new Map<string, number>();
	let transcript = "";
	const view: DebateView = { turns: [], aborted: false, model: "" };
	// Eight lockstep call sites below must all emit the same (view, transcript) pair.
	const emit = () => deps.onUpdate(view, transcript);

	// Default 1 (3 calls), not 2: with fixed rounds the second exchange was
	// observed to add no new findings, so the extra 2 calls bought nothing.
	const rounds = p.rounds ?? 1;
	const seating = seatingFor(p.debaters ?? MIN_DEBATERS);
	const ultrathink = p.ultrathink ?? "none";
	for (const sp of turnOrder(rounds, seating)) {
		if (signal?.aborted) {
			view.aborted = true;
			view.current = undefined;
			emit();
			return { plan: "", transcript, turns, aborted: true, view };
		}
		const before = transcript;
		const header = `${before ? "\n\n" : ""}## ${sp.label}\n\n`;
		const key = `${sp.role}#${sp.seat}`;
		const turnNo = (spoken.get(key) ?? 0) + 1;
		spoken.set(key, turnNo);
		const ultra =
			ultrathink === "all" || (ultrathink === "adjudicator" && sp.role === "adjudicator");
		try {
			const { text, modelId } = await deps.runTurn({
				role: sp.role,
				label: sp.label,
				system: systemFor(sp, p.mode, rounds, turnNo, seating, ultra),
				prompt: promptFor(p, turns, fileText),
				ultra,
				onAttemptStart: () => {
					transcript = before + header;
					view.current = { role: sp.role, seat: sp.seat, label: sp.label };
					emit();
				},
				onChunk: (d) => {
					// The transcript feeds the model-visible `content`; the view carries no
					// text, so a chunk changes only the transcript.
					transcript += d;
					emit();
				},
				signal,
			});
			view.model = modelId;
			const turn: Turn = { role: sp.role, seat: sp.seat, label: sp.label, text, modelId };
			if (deps.summarize) {
				try {
					turn.summary = await deps.summarize(turn, turns);
				} catch {
					// A summary is a reading aid. Losing it must not discard a turn
					// that already cost a model call.
					turn.summaryFailed = true;
				}
			}
			// Cleared only now — summarisation takes seconds, and clearing before it
			// would blank the thinking animation and leave a visibly empty gap.
			view.current = undefined;
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
 * prompted away; sycophancy partly can — which is why two rival proposers are
 * seated whenever the debater budget allows.
 */
export function pickModel(ctx: ExtensionContext): Model<Api> {
	// The docs demonstrate `@slow`; that a custom `modelRoles` entry takes the
	// same `@` prefix is unverified, hence the explicit fallback.
	const model = ctx.models.resolve("@plan") ?? ctx.models.current();
	if (!model) throw new Error("debate: no authenticated model available");
	return model;
}

/** Per-file and whole-request caps. A debate that silently ships 4 MB of files
 *  blows the context window mid-debate, which surfaces as an opaque provider
 *  error several minutes and several paid turns in. */
export const MAX_FILE_BYTES = 65_536;
export const MAX_TOTAL_FILE_BYTES = 262_144;

export async function readFiles(paths?: string[]): Promise<string> {
	if (!paths?.length) return "";
	const out: string[] = [];
	let total = 0;
	for (const p of paths) {
		if (total >= MAX_TOTAL_FILE_BYTES) {
			out.push(`## ${p}\n\n(skipped: total file budget exhausted)`);
			continue;
		}
		try {
			const raw = await Bun.file(p).text();
			const body =
				raw.length > MAX_FILE_BYTES
					? `${raw.slice(0, MAX_FILE_BYTES)}\n… (truncated at 64KB)`
					: raw;
			total += body.length;
			out.push(`## ${p}\n\n\`\`\`\n${body}\n\`\`\``);
		} catch (err) {
			// An unreadable path must not sink a debate that already cost model calls.
			out.push(`## ${p}\n\n(could not read: ${String(err)})`);
		}
	}
	return out.join("\n\n");
}

export async function demo(): Promise<void> {
	// 0. seating: two rival proposers whenever the budget allows, one at the floor
	assert.deepEqual(seatingFor(2), { proposers: 1, critics: 1 }, "2 debaters → 1P+1C");
	assert.deepEqual(seatingFor(3), { proposers: 2, critics: 1 }, "3 debaters → 2P+1C");
	assert.deepEqual(seatingFor(4), { proposers: 2, critics: 2 }, "4 debaters → 2P+2C");
	assert.deepEqual(seatingFor(6), { proposers: 2, critics: 4 }, "6 debaters → 2P+4C");
	assert.deepEqual(seatingFor(1), { proposers: 1, critics: 1 }, "below the floor clamps to 2");
	assert.deepEqual(seatingFor(9), { proposers: 2, critics: 4 }, "above the ceiling clamps to 6");
	assert.deepEqual(seatingFor(Number.NaN), { proposers: 1, critics: 1 }, "NaN falls back to the floor");

	// 0b. labels are unsuffixed when a role has one seat, lettered when it has several
	assert.deepEqual(
		speakersFor(seatingFor(2)).map((s) => s.label),
		["Proposer", "Critic", "Adjudicator"],
		"single-seat labels carry no letter",
	);
	assert.deepEqual(
		turnOrder(1, seatingFor(4)).map((s) => s.label),
		["Proposer A", "Proposer B", "Critic A", "Critic B", "Adjudicator"],
		"4-debater turn order and labels",
	);
	assert.deepEqual(
		turnOrder(2, seatingFor(3)).map((s) => s.label),
		[
			"Proposer A",
			"Proposer B",
			"Critic",
			"Proposer A",
			"Proposer B",
			"Critic",
			"Adjudicator",
		],
		"rounds repeat the debaters and the adjudicator still speaks once, last",
	);

	// 1. turn order
	const seen: Role[] = [];
	const prompts: Record<string, string> = {};
	const plain: TurnRunner = async (req) => {
		seen.push(req.role);
		prompts[req.label] = req.prompt;
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
	assert.ok(prompts.Critic?.includes("[proposer-said]"), "critic context carries proposer text");

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
	const duo = seatingFor(2);
	const sp1 = { role: "proposer" as Role, seat: 1, label: "Proposer" };
	const sc1 = { role: "critic" as Role, seat: 1, label: "Critic" };
	const p1 = systemFor(sp1, "plan", 2, 1, duo, false);
	const p2 = systemFor(sp1, "plan", 2, 2, duo, false);
	const c1 = systemFor(sc1, "plan", 2, 1, duo, false);
	const c2 = systemFor(sc1, "plan", 2, 2, duo, false);
	assert.notEqual(p1, p2, "proposer turn 2 differs from turn 1");
	assert.notEqual(c1, c2, "critic turn 2 differs from turn 1");
	assert.ok(p2.includes("Rebut"), "proposer turn 2 rebuts");
	assert.ok(!p2.includes("Produce the strongest"), "proposer turn 2 does not re-draft");
	assert.ok(c2.includes("manufacture"), "critic turn 2 is told not to invent findings");
	assert.ok(p1.includes("turn 1 of 2") && p2.includes("turn 2 of 2"), "turn index stated");
	assert.ok(p1.includes("one of 3 models"), "2 debaters + adjudicator = 3 models");

	// 4d. rival-proposal wiring only appears with two proposers
	const quad = seatingFor(4);
	const pa = { role: "proposer" as Role, seat: 1, label: "Proposer A" };
	const pb = { role: "proposer" as Role, seat: 2, label: "Proposer B" };
	const firstA = systemFor(pa, "plan", 1, 1, quad, false);
	const firstB = systemFor(pb, "plan", 1, 1, quad, false);
	assert.ok(firstA.includes("Produce the strongest"), "seat 1 drafts");
	assert.ok(!firstA.includes("A rival proposal already exists"), "seat 1 is not told about a rival");
	assert.ok(firstB.includes("A rival proposal already exists"), "seat 2 answers a rival");
	assert.ok(!firstB.includes("Produce the strongest"), "seat 2 does not get the seat-1 brief");
	assert.ok(firstA.includes("one of 5 models"), "4 debaters + adjudicator = 5 models");
	assert.ok(firstB.includes("You are Proposer B"), "speaker identity stated");
	assert.ok(
		systemFor(pa, "plan", 2, 2, quad, false).includes("rival proposal handles a criticism better"),
		"rebuttals must concede to a better rival",
	);
	assert.ok(
		!systemFor(sp1, "plan", 2, 2, duo, false).includes("rival proposal handles a criticism"),
		"no rival language with a single proposer",
	);
	const adjSolo = systemFor(
		{ role: "adjudicator", seat: 1, label: "Adjudicator" },
		"plan",
		1,
		1,
		duo,
		false,
	);
	const adjRival = systemFor(
		{ role: "adjudicator", seat: 1, label: "Adjudicator" },
		"plan",
		1,
		1,
		quad,
		false,
	);
	assert.ok(!adjSolo.includes("Two rival proposals"), "single-proposer adjudicator has nothing to pick");
	assert.ok(adjRival.includes("Two rival proposals"), "two-proposer adjudicator must choose or merge");

	// 4e. critic lenses are seat-specific and absent when there is only one critic
	const cA = systemFor({ role: "critic", seat: 1, label: "Critic A" }, "plan", 1, 1, quad, false);
	const cB = systemFor({ role: "critic", seat: 2, label: "Critic B" }, "plan", 1, 1, quad, false);
	const cC = systemFor({ role: "critic", seat: 3, label: "Critic C" }, "plan", 1, 1, seatingFor(6), false);
	assert.ok(cA.includes("correctness, completeness, and hidden coupling"), "critic A lens");
	assert.ok(cB.includes("over-engineering, simplicity (YAGNI)"), "critic B lens");
	assert.ok(cC.includes("the other critics missed"), "critic C mops up");
	assert.ok(!c1.includes("assigned lens"), "a lone critic gets no lens");
	assert.ok(cA.includes("Attack every proposal on the table"), "two proposals are both attacked");

	// 4f. ultrathink suffix is opt-in and, in adjudicator mode, adjudicator-only
	assert.ok(!firstA.includes("ultrathink:"), "no ultra suffix by default");
	assert.ok(systemFor(pa, "plan", 1, 1, quad, true).includes("ultrathink:"), "ultra suffix appended");
	const ultraSeen: Record<string, boolean> = {};
	const ultraRunner: TurnRunner = async (req) => {
		ultraSeen[req.label] = req.ultra;
		req.onAttemptStart();
		req.onChunk("x");
		return { text: "x", modelId: "fake" };
	};
	await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1, debaters: 4, ultrathink: "adjudicator" },
		{ runTurn: ultraRunner, onUpdate: () => {} },
	);
	assert.deepEqual(
		ultraSeen,
		{ "Proposer A": false, "Proposer B": false, "Critic A": false, "Critic B": false, Adjudicator: true },
		"ultrathink=adjudicator marks only the adjudicator",
	);
	const ultraAll: Record<string, boolean> = {};
	const allRunner: TurnRunner = async (req) => {
		ultraAll[req.label] = req.ultra;
		req.onAttemptStart();
		req.onChunk("x");
		return { text: "x", modelId: "fake" };
	};
	await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1, debaters: 3, ultrathink: "all" },
		{ runTurn: allRunner, onUpdate: () => {} },
	);
	assert.ok(
		Object.values(ultraAll).every((v) => v === true) && Object.keys(ultraAll).length === 4,
		"ultrathink=all marks every seat",
	);

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

	// 7b. oversized files are truncated, and the whole request has a ceiling
	const big = `${import.meta.dir}/.debate-selfcheck-big.txt`;
	await Bun.write(big, "z".repeat(MAX_FILE_BYTES + 4_096));
	const capped = await readFiles([big]);
	assert.ok(capped.includes("… (truncated at 64KB)"), "per-file cap marks the truncation");
	assert.ok(capped.length < MAX_FILE_BYTES + 2_048, "per-file cap actually shortens the payload");
	const many = Array.from({ length: 6 }, () => big);
	const budgeted = await readFiles(many);
	assert.ok(
		budgeted.includes("(skipped: total file budget exhausted)"),
		"total budget stops later files",
	);
	await Bun.file(big).delete();

	// 8. the emitted view tracks turns, summaries and the live speaker
	const views: DebateView[] = [];
	const summarised: TurnRunner = async (req) => {
		req.onAttemptStart();
		req.onChunk(`body-${req.role}`);
		return { text: `body-${req.role}`, modelId: "m1" };
	};
	const okSummary: Summarizer = async (turn, prior) => `delta for ${turn.label} after ${prior.length} prior`;
	const vOut = await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1 },
		{ runTurn: summarised, summarize: okSummary, onUpdate: (v) => views.push(structuredClone(v)) },
	);
	assert.equal(vOut.view.turns.length, 3, "view has every turn");
	assert.equal(vOut.view.turns[0].summary, "delta for Proposer after 0 prior", "summary stored");
	assert.equal(vOut.view.turns[1].summary, "delta for Critic after 1 prior", "prior passed to summariser");
	assert.equal(vOut.view.turns[0].chars, "body-proposer".length, "chars recorded");
	assert.equal(vOut.view.turns[0].seat, 1, "seat recorded");
	assert.equal(vOut.view.turns[0].label, "Proposer", "label recorded");
	assert.equal(vOut.view.model, "m1", "model recorded");
	assert.equal(vOut.view.current, undefined, "no live speaker once finished");
	assert.ok(
		views.some((v) => v.current?.label === "Critic"),
		"a mid-debate view exposed the live speaker",
	);
	assert.ok(
		views.every((v) => !("tail" in (v.current ?? {}))),
		"the view carries no streamed text — the renderer animates instead",
	);

	// 8a. the live speaker stays set while its summary is being written, so the
	// thinking animation does not blink out between the turn and its bubble
	let sawCurrentDuringSummary: boolean | undefined;
	let lastEmitted: DebateView | undefined;
	const watchingSummary: Summarizer = async (turn) => {
		sawCurrentDuringSummary = lastEmitted?.current !== undefined;
		return `s-${turn.label}`;
	};
	await runDebate(
		{ mode: "plan", goal: "G", briefing: "B", rounds: 1 },
		{
			runTurn: summarised,
			summarize: watchingSummary,
			onUpdate: (v) => {
				lastEmitted = v;
			},
		},
	);
	assert.equal(sawCurrentDuringSummary, true, "current survives until the summary lands");

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
