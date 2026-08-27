// Adversarial debate — pure renderer.
//
// No value imports from pi-tui / pi-ai / pi-coding-agent: all three pull
// pi-natives, which cannot load outside the omp host. Width helpers are injected
// so this module stays runnable under plain `bun` and the layout is testable.
//
// Spec: ~/dev/docs/superpowers/specs/2026-08-26-debate-chat-rendering-design.md
// Self-check: `bun render.ts` (from the repo root)

import { strict as assert } from "node:assert";

import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { DebateView, Role } from "./core.js";

export interface RenderHelpers {
	visibleWidth(s: string): number;
	wrap(text: string, width: number): string[];
	truncate(text: string, width: number): string;
}

export interface RenderOpts {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
}

/** Strip ANSI so the fake helpers in the self-check measure like the real ones. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

type Colour = "accent" | "error" | "success" | "warning" | "muted";

/** Debaters get 70% of the width; the adjudicator's verdict is the artefact the
 *  user actually reads, so it spans everything but a thin margin. */
const SIDE_FRACTION = 0.7;
const ADJ_MARGIN = 2;
const MAX_SUMMARY_LINES = 10;
const FALLBACK_HEAD_LINES = 6;
const MIN_SIDES_WIDTH = 72;
const MIN_BOX_WIDTH = 24;

/** `" ".repeat(-1)` throws, and every padding computation here can go negative
 *  when a truncation lands exactly on the boundary. Clamping in one place keeps
 *  a rounding slip from taking down the whole TUI frame. */
const spaces = (n: number): string => " ".repeat(Math.max(0, n));

/**
 * Thinking animation: dots appear one by one, then disappear one by one.
 *
 * Exported as the test seam for the phase table — the host advances
 * `spinnerFrame` on every repaint, so this is what makes the bubble look alive
 * while a model is thinking and emitting nothing.
 */
const DOT_PHASES = ["•", "• •", "• • •", "• •", "•", ""];
export function dotsFor(frame: number): string {
	return DOT_PHASES[((frame % DOT_PHASES.length) + DOT_PHASES.length) % DOT_PHASES.length] ?? "";
}

/**
 * Bubble width for a role. Shared by the completed-turn and streaming paths so a
 * bubble cannot change width when its summary lands.
 */
function bubbleWidthFor(role: Role, width: number): number {
	if (role === "adjudicator") return Math.max(MIN_BOX_WIDTH, width - 2 * ADJ_MARGIN);
	return Math.max(MIN_BOX_WIDTH, Math.floor(width * SIDE_FRACTION));
}

/** Colour per speaker. Critics alternate so two of them are told apart at a
 *  glance; the user is dimmed because an interjection is not a debate position. */
function colourFor(role: Role, seat: number): Colour {
	if (role === "proposer") return "accent";
	if (role === "adjudicator") return "success";
	if (role === "user") return "muted";
	return seat % 2 === 1 ? "error" : "warning";
}

/** Left edge of a role's bubble. */
function offsetFor(role: Role, width: number, bubbleWidth: number): number {
	if (role === "proposer") return 0;
	if (role === "critic") return width - bubbleWidth;
	// Centred; an odd remainder gives the extra column to the right so a row is
	// never width + 1 cells.
	return Math.floor((width - bubbleWidth) / 2);
}

function boxed(
	title: string,
	right: string,
	body: string[],
	bubbleWidth: number,
	colour: Colour,
	theme: Theme,
	h: RenderHelpers,
): string[] {
	const inner = bubbleWidth - 4; // "│ " + text + " │"
	const head = `╭─ ${title} `;
	const tail = right ? ` ${right} ─╮` : "─╮";
	const dashes = Math.max(0, bubbleWidth - h.visibleWidth(head) - h.visibleWidth(tail));
	const rows = [theme.fg(colour, head + "─".repeat(dashes) + tail)];
	for (const line of body) {
		const cut = h.truncate(line, inner);
		rows.push(theme.fg(colour, "│ ") + cut + spaces(inner - h.visibleWidth(cut)) + theme.fg(colour, " │"));
	}
	rows.push(theme.fg(colour, `╰${"─".repeat(Math.max(0, bubbleWidth - 2))}╯`));
	return rows;
}

function guttered(
	title: string,
	right: string,
	body: string[],
	width: number,
	colour: Colour,
	theme: Theme,
	h: RenderHelpers,
): string[] {
	const bar = theme.fg(colour, "▏");
	const headText = right ? `${title}  ${right}` : title;
	const headCut = h.truncate(headText, width - 2);
	const rows = [`${bar} ${theme.fg(colour, theme.bold(headCut))}${spaces(width - 2 - h.visibleWidth(headCut))}`];
	for (const line of body) {
		const cut = h.truncate(line, width - 2);
		rows.push(`${bar} ${cut}${spaces(width - 2 - h.visibleWidth(cut))}`);
	}
	return rows;
}

/**
 * Wrap bullet text with a hanging indent so a continuation line cannot be
 * mistaken for a new item. Bullets are wrapped two columns narrower to leave
 * room for the indent, so every returned line still fits `width`.
 */
function wrapBullets(text: string, width: number, h: RenderHelpers): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const isBullet = raw.trimStart().startsWith("•");
		const parts = h.wrap(raw, isBullet ? width - 2 : width);
		out.push(parts[0] ?? "");
		for (const cont of parts.slice(1)) out.push(isBullet ? `  ${cont}` : cont);
	}
	return out;
}

/**
 * Cap rendered height without ending mid-bullet: rewind to the last line that
 * completes one. Rewinding is floored at half the cap, because showing two
 * lines of a ten-line summary is worse than one clipped sentence.
 */
function capAtBullet(lines: string[]): string[] {
	if (lines.length <= MAX_SUMMARY_LINES) return lines;
	const startsBullet = (i: number) => lines[i]?.trimStart().startsWith("•") ?? false;
	const floor = Math.ceil(MAX_SUMMARY_LINES / 2);
	let cut = MAX_SUMMARY_LINES;
	while (cut > floor && !startsBullet(cut)) cut--;
	if (!startsBullet(cut)) cut = MAX_SUMMARY_LINES;
	return lines.slice(0, cut);
}

/** Body lines for one completed turn, honouring collapse/expand and failures.
 *  `full` is set for the adjudicator's verdict once the debate is final: the plan
 *  is the artefact the user came for, so it is never left behind a toggle. */
function bodyFor(
	turn: DebateView["turns"][number],
	innerWidth: number,
	expanded: boolean,
	h: RenderHelpers,
	full = false,
): string[] {
	if (expanded || full) return h.wrap(turn.text, innerWidth);
	// A user turn has no summary and needs none — it is short by construction — so
	// it is shown verbatim, under the same height cap the summaries use.
	if (turn.role === "user") {
		const lines = h.wrap(turn.text, innerWidth);
		return lines.length <= MAX_SUMMARY_LINES
			? lines
			: [...lines.slice(0, MAX_SUMMARY_LINES), `▸ ${turn.chars} chars — expand to read in full`];
	}
	if (turn.summary) {
		const lines = capAtBullet(wrapBullets(turn.summary, innerWidth, h));
		return [...lines, `▸ ${turn.chars} chars — expand to read in full`];
	}
	const head = h.wrap(turn.text, innerWidth).slice(0, FALLBACK_HEAD_LINES);
	const note = turn.summaryFailed ? "(summary unavailable)" : "(no summary)";
	return [...head, `${note} ▸ ${turn.chars} chars — expand to read in full`];
}

export function renderRows(
	view: DebateView,
	width: number,
	opts: RenderOpts,
	theme: Theme,
	h: RenderHelpers,
): string[] {
	// A renderer must never throw: an exception here breaks the whole TUI frame,
	// not just this pane.
	try {
		const turns = Array.isArray(view?.turns) ? view.turns : [];
		if (!turns.length && !view?.current) return [spaces(width)];

		const plain = width < MIN_BOX_WIDTH;
		const sides = width >= MIN_SIDES_WIDTH && !opts.expanded && !plain;
		const rows: string[] = [];

		for (const turn of turns) {
			// The verdict is what the user came for: once the debate is final it is
			// shown in full rather than as a ten-line summary behind a toggle.
			const full = turn.role === "adjudicator" && !opts.isPartial;
			// A user turn has no model to name, so the right slot names its targets.
			const right =
				turn.role === "user" ? (turn.to?.length ? `→ ${turn.to.join(", ")}` : "") : turn.modelId;
			if (plain) {
				for (const line of bodyFor(turn, width, opts.expanded, h, full)) {
					const cut = h.truncate(line, width);
					rows.push(cut + spaces(width - h.visibleWidth(cut)));
				}
				continue;
			}
			const colour = colourFor(turn.role, turn.seat);
			if (!sides) {
				const body = bodyFor(turn, width - 2, opts.expanded, h, full);
				rows.push(...guttered(turn.label, right, body, width, colour, theme, h));
				rows.push(spaces(width));
				continue;
			}
			const bw = bubbleWidthFor(turn.role, width);
			const off = offsetFor(turn.role, width, bw);
			const body = bodyFor(turn, bw - 4, false, h, full);
			for (const r of boxed(turn.label, right, body, bw, colour, theme, h))
				rows.push(spaces(off) + r + spaces(width - off - h.visibleWidth(r)));
			rows.push(spaces(width));
		}

		if (view.current && !plain) {
			// No text: a turn in flight is a header plus the thinking animation. The
			// streamed body used to be shown here and was unreadable at this speed.
			const { role, seat, label } = view.current;
			const colour = colourFor(role, seat);
			const frames = theme.spinnerFrames;
			const spin = frames[(opts.spinnerFrame ?? 0) % frames.length] ?? "";
			const dots = dotsFor(opts.spinnerFrame ?? 0);
			if (sides) {
				const bw = bubbleWidthFor(role, width);
				const off = offsetFor(role, width, bw);
				const inner = bw - 4;
				const line = spaces(Math.floor((inner - h.visibleWidth(dots)) / 2)) + dots;
				for (const r of boxed(label, spin, [line], bw, colour, theme, h))
					rows.push(spaces(off) + r + spaces(width - off - h.visibleWidth(r)));
			} else {
				const inner = width - 2;
				const line = spaces(Math.floor((inner - h.visibleWidth(dots)) / 2)) + dots;
				rows.push(...guttered(label, spin, [line], width, colour, theme, h));
			}
		}

		// Paused on a gate. Nothing is thinking, so the animation above is absent
		// and this row says why — same shape as the abort note below.
		if (view.gate && !view.current) {
			const note =
				view.gate.kind === "verdict"
					? "⏸ verdict delivered — waiting for your input"
					: `⏸ round ${view.gate.round} complete — waiting for your input`;
			const cut = h.truncate(note, width);
			const pad = Math.floor((width - h.visibleWidth(cut)) / 2);
			rows.push(spaces(pad) + theme.fg("muted", cut) + spaces(width - pad - h.visibleWidth(cut)));
		}

		if (view.aborted || view.error) {
			const note = view.error ? `Debate failed: ${view.error}` : "Debate aborted; transcript is partial.";
			const cut = h.truncate(note, width);
			rows.push(theme.fg("muted", cut) + spaces(width - h.visibleWidth(cut)));
		}
		return rows;
	} catch {
		return [spaces(width)];
	}
}

export function renderDebate(
	view: DebateView,
	opts: RenderOpts,
	theme: Theme,
	h: RenderHelpers,
): { render(width: number): readonly string[] } {
	let cachedWidth = -1;
	let cached: readonly string[] = [];
	return {
		render(width: number) {
			// The host may call render repeatedly at one width; an unchanged
			// component should return the same array reference (pi-tui/tui.d.ts:72-74).
			if (width !== cachedWidth) {
				cachedWidth = width;
				cached = renderRows(view, width, opts, theme, h);
			}
			return cached;
		},
	};
}

/** ASCII-only stand-ins for the host's pi-tui helpers — test seam shared by the
 *  self-check and smoke.ts. Width maths matches the real helpers for ASCII
 *  because the fake theme adds no escape sequences. */
export function fakeHelpers(): RenderHelpers {
	return {
		visibleWidth: (s) => stripAnsi(s).length,
		wrap: (text, width) => {
			const out: string[] = [];
			for (const para of text.split("\n")) {
				let line = "";
				for (const word of para.split(" ")) {
					if (line && line.length + 1 + word.length > width) {
						out.push(line);
						line = word;
					} else line = line ? `${line} ${word}` : word;
				}
				out.push(line);
			}
			return out;
		},
		truncate: (text, width) =>
			stripAnsi(text).length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`,
	};
}

/** Identity-colour theme: assertions read plainly and width maths is unaffected
 *  because the real theme only adds zero-width escapes. */
export function fakeTheme(): Theme {
	return {
		fg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		spinnerFrames: ["|", "/", "-", "\\"],
	} as unknown as Theme;
}

export async function demo(): Promise<void> {
	const h = fakeHelpers();
	const theme = fakeTheme();

	const view: DebateView = {
		model: "claude-fable-5",
		aborted: false,
		turns: [
			{
				role: "proposer",
				seat: 1,
				label: "Proposer",
				text: "P ".repeat(400).trim(),
				summary: "proposes a flag\nvalidated early",
				modelId: "claude-fable-5",
				chars: 799,
			},
			{
				role: "critic",
				seat: 1,
				label: "Critic",
				text: "C ".repeat(300).trim(),
				summary: "still pressing set -e\nconceded systemctl",
				modelId: "claude-fable-5",
				chars: 599,
			},
			{
				role: "adjudicator",
				seat: 1,
				label: "Adjudicator",
				text: "A ".repeat(200).trim(),
				summary: "adopts rsync -n",
				modelId: "claude-fable-5",
				chars: 399,
			},
		],
	};
	const collapsed: RenderOpts = { expanded: false, isPartial: false };

	// 1. every row is exactly `width` visible cells
	for (const w of [72, 100, 140]) {
		for (const row of renderRows(view, w, collapsed, theme, h))
			assert.equal(h.visibleWidth(row), w, `row width at ${w}`);
	}

	// 2. geometry: debaters take 70% and hug their side; the adjudicator spans
	// everything but a 2-column margin
	const rows = renderRows(view, 100, collapsed, theme, h);
	const pRow = rows.find((r) => r.includes("Proposer"));
	const cRow = rows.find((r) => r.includes("Critic"));
	const aRow = rows.find((r) => r.includes("Adjudicator"));
	assert.ok(pRow && cRow && aRow, "a header row exists for each role");
	const side = Math.floor(100 * 0.7);
	assert.equal(side, 70, "70% of 100 columns");
	assert.equal(pRow.search(/\S/), 0, "proposer flush left");
	assert.equal(stripAnsi(pRow).trimEnd().length, side, "proposer bubble is 70% wide");
	assert.equal(stripAnsi(cRow).trimEnd().length, 100, "critic right edge at width");
	assert.equal(cRow.search(/\S/), 100 - side, "critic bubble is 70% wide, right-aligned");
	assert.equal(aRow.search(/\S/), 2, "adjudicator starts at the 2-column margin");
	assert.equal(stripAnsi(aRow).trimEnd().length, 98, "adjudicator ends at the 2-column margin");

	// 3. collapsed caps content lines; expanded carries the full text
	const bodyLines = rows.filter((r) => r.includes("│")).length;
	assert.ok(bodyLines <= 3 * 11, "collapsed bodies capped");
	const expandedRows = renderRows(view, 100, { expanded: true, isPartial: false }, theme, h);
	assert.ok(stripAnsi(expandedRows.join(" ")).includes("P P P"), "expanded shows full text");

	// 4. narrow width drops sides
	const narrow = renderRows(view, 60, collapsed, theme, h);
	for (const row of narrow) assert.equal(h.visibleWidth(row), 60, "narrow row width");
	assert.ok(
		narrow.every((r) => r.search(/\S/) <= 0),
		"no side offsets below 72 columns",
	);

	// 5. headers name the speaker and the model
	assert.ok(
		stripAnsi(pRow).includes("Proposer") && stripAnsi(pRow).includes("claude-fable-5"),
		"header content",
	);

	// 6. a turn in flight renders a header + one animated line, and NO text
	const live: DebateView = {
		...view,
		turns: [],
		current: { role: "critic", seat: 1, label: "Critic" },
	};
	const liveRows = renderRows(live, 100, { expanded: false, isPartial: true, spinnerFrame: 2 }, theme, h);
	assert.equal(liveRows.length, 3, "streaming bubble is head + dots + foot");
	for (const row of liveRows) assert.equal(h.visibleWidth(row), 100, "streaming row width");
	assert.ok(stripAnsi(liveRows[0]).includes("Critic"), "streaming header names the speaker");
	assert.ok(stripAnsi(liveRows[0]).includes("-"), "spinner frame 2 rendered in the header");
	assert.equal(
		stripAnsi(liveRows[1]).replace(/[│╭╮╰╯─]/g, "").trim(),
		"• • •",
		"frame 2 shows all three dots and nothing else",
	);

	// 6b. the animation cycles up and back down, and never breaks row width
	assert.deepEqual(
		[0, 1, 2, 3, 4, 5].map(dotsFor),
		["•", "• •", "• • •", "• •", "•", ""],
		"dots appear then disappear one by one",
	);
	assert.equal(dotsFor(6), "•", "cycle wraps");
	assert.equal(dotsFor(-1), "", "negative frames stay in range");
	for (const frame of [0, 1, 2, 3, 4, 5]) {
		const phaseRows = renderRows(live, 100, { expanded: false, isPartial: true, spinnerFrame: frame }, theme, h);
		assert.equal(phaseRows.length, 3, `phase ${frame} keeps the bubble 3 rows tall`);
		for (const row of phaseRows) assert.equal(h.visibleWidth(row), 100, `phase ${frame} row width`);
	}

	// 6c. a streaming turn never leaks the previous turns' body text into its box
	const liveAfter: DebateView = { ...view, current: { role: "proposer", seat: 2, label: "Proposer B" } };
	const afterRows = renderRows(liveAfter, 100, { expanded: false, isPartial: true, spinnerFrame: 0 }, theme, h);
	const streamHead = afterRows.findIndex((r) => stripAnsi(r).includes("Proposer B"));
	assert.ok(streamHead >= 0, "streaming bubble present after completed turns");
	assert.equal(afterRows.length - streamHead, 3, "streaming bubble is the last 3 rows");
	assert.equal(afterRows[streamHead].search(/\S/), 0, "second proposer is still flush left");

	// 6d. a second critic renders (a different colour, same geometry)
	const twoCritics: DebateView = {
		...view,
		turns: [{ ...view.turns[1], seat: 2, label: "Critic B" }],
	};
	const twoRows = renderRows(twoCritics, 100, collapsed, theme, h);
	for (const row of twoRows) assert.equal(h.visibleWidth(row), 100, "critic B row width");
	assert.ok(stripAnsi(twoRows.join("\n")).includes("Critic B"), "critic B header rendered");

	// 7. a failed summary falls back to head lines with a marker
	const failed: DebateView = {
		...view,
		turns: [
			{
				role: "proposer",
				seat: 1,
				label: "Proposer",
				text: "line one\nline two\nline three",
				summaryFailed: true,
				modelId: "m",
				chars: 28,
			},
		],
	};
	const failedText = stripAnsi(renderRows(failed, 100, collapsed, theme, h).join("\n"));
	assert.ok(failedText.includes("summary unavailable"), "failure marker shown");
	assert.ok(failedText.includes("line one"), "head lines shown instead");

	// 8. malformed details never throw
	for (const junk of [undefined, null, {}, { turns: "nope" }]) {
		const out = renderRows(junk as unknown as DebateView, 100, collapsed, theme, h);
		assert.ok(Array.isArray(out), "malformed view yields rows, not an exception");
		for (const row of out) assert.equal(h.visibleWidth(row), 100, "fallback row width");
	}

	// 9. below 24 columns, plain unstyled lines
	const tiny = renderRows(view, 20, collapsed, theme, h);
	assert.ok(
		tiny.every((r) => !r.includes("│") && !r.includes("╭")),
		"no box drawing below 24 columns",
	);

	// 9b. bullet continuations get a hanging indent, and the cap never ends
	// mid-bullet
	const bulleted: DebateView = {
		model: "m",
		aborted: false,
		turns: [
			{
				role: "proposer",
				seat: 1,
				label: "Proposer",
				text: "full",
				modelId: "m",
				chars: 4,
				summary: Array.from(
					{ length: 8 },
					(_, i) => `• bullet ${i} with enough words to certainly wrap past the inner width limit`,
				).join("\n"),
			},
		],
	};
	const bRows = renderRows(bulleted, 100, collapsed, theme, h);
	for (const row of bRows) assert.equal(h.visibleWidth(row), 100, "bullet row width");
	const inner = bRows
		.filter((r) => r.includes("│"))
		.map((r) => stripAnsi(r).replace(/^\s*│ ?/, "").replace(/\s*│\s*$/, ""));
	const bodyOnly = inner.filter((l) => !l.startsWith("▸"));
	assert.ok(
		bodyOnly.some((l) => l.startsWith("  ") && !l.trimStart().startsWith("•")),
		"continuation lines are indented",
	);
	assert.ok(bodyOnly.length <= 10, "cap respected");
	// The last body line must complete a bullet: the following source bullet was
	// dropped whole rather than clipped mid-sentence.
	const lastBody = bodyOnly[bodyOnly.length - 1] ?? "";
	assert.ok(lastBody.length > 0 && !lastBody.endsWith("…"), "cap did not clip mid-sentence");

	// 10. a user turn: centred, dimmed, 70% wide, and it names its targets
	const withUser: DebateView = {
		...view,
		turns: [
			view.turns[0],
			{
				role: "user",
				seat: 1,
				label: "User",
				text: "why not X? the retry budget is per-host, not global",
				modelId: "",
				to: ["Critic A", "Proposer"],
				chars: 51,
			},
			view.turns[1],
		],
	};
	for (const w of [72, 100, 140]) {
		for (const row of renderRows(withUser, w, collapsed, theme, h))
			assert.equal(h.visibleWidth(row), w, `user-turn row width at ${w}`);
	}
	const uRows = renderRows(withUser, 100, collapsed, theme, h);
	const uHead = uRows.find((r) => stripAnsi(r).includes("User"));
	assert.ok(uHead, "the user turn has a header row");
	assert.equal(uHead.search(/\S/), Math.floor((100 - 70) / 2), "user bubble is centred");
	assert.equal(stripAnsi(uHead).trim().endsWith("─╮"), true, "and closes its box");
	assert.ok(stripAnsi(uHead).includes("→ Critic A, Proposer"), "the header names the targets");
	const uBody = uRows
		.filter((r) => r.includes("│") && stripAnsi(r).includes("retry budget"))
		.map((r) => stripAnsi(r));
	assert.equal(uBody.length, 1, "short user text renders verbatim on one line");
	assert.ok(
		!uRows.some((r) => stripAnsi(r).includes("(no summary)")),
		"a user turn is not a turn whose summary failed",
	);
	const longUser: DebateView = {
		...withUser,
		turns: [{ ...withUser.turns[1], text: "word ".repeat(400).trim(), chars: 1999 }],
	};
	const luRows = renderRows(longUser, 100, collapsed, theme, h);
	assert.ok(
		luRows.some((r) => stripAnsi(r).includes("1999 chars — expand")),
		"an overlong user turn is capped with the standard hint",
	);
	assert.ok(luRows.filter((r) => r.includes("│")).length <= MAX_SUMMARY_LINES + 1, "cap respected");

	// 11. the verdict is rendered in full once the debate is final, and only then
	const finalRows = renderRows(view, 100, collapsed, theme, h);
	const partialRows = renderRows(view, 100, { expanded: false, isPartial: true }, theme, h);
	assert.ok(
		stripAnsi(finalRows.join(" ")).includes("A A A A"),
		"a finished debate shows the whole verdict, not a summary behind a toggle",
	);
	assert.ok(
		!stripAnsi(partialRows.join(" ")).includes("A A A A"),
		"while the debate is still running the verdict stays summarised",
	);
	assert.ok(
		stripAnsi(partialRows.join(" ")).includes("adopts rsync -n"),
		"the running view shows the verdict summary",
	);
	for (const row of finalRows) assert.equal(h.visibleWidth(row), 100, "full-verdict row width");

	// 12. a gate pauses the pane: one dimmed centred row, never alongside a
	// thinking animation, and never a throw on a malformed gate
	const paused: DebateView = { ...view, gate: { kind: "round", round: 2 } };
	const pRows = renderRows(paused, 100, collapsed, theme, h);
	assert.ok(
		pRows.some((r) => stripAnsi(r).includes("⏸ round 2 complete — waiting for your input")),
		"a round gate says which round it is waiting on",
	);
	for (const row of pRows) assert.equal(h.visibleWidth(row), 100, "paused row width");
	const verdictPaused = renderRows(
		{ ...view, gate: { kind: "verdict", round: 1 } },
		100,
		collapsed,
		theme,
		h,
	);
	assert.ok(
		verdictPaused.some((r) => stripAnsi(r).includes("⏸ verdict delivered")),
		"the verdict gate says the plan is already in hand",
	);
	const busy = renderRows(
		{ ...paused, current: { role: "critic", seat: 1, label: "Critic" } },
		100,
		{ expanded: false, isPartial: true, spinnerFrame: 1 },
		theme,
		h,
	);
	assert.ok(
		!busy.some((r) => stripAnsi(r).includes("waiting for your input")),
		"a live speaker wins over a stale gate flag",
	);
	for (const w of [30, 60, 100]) {
		const narrowPaused = renderRows(paused, w, collapsed, theme, h);
		for (const row of narrowPaused) assert.equal(h.visibleWidth(row), w, `paused row width at ${w}`);
	}
	assert.doesNotThrow(
		() => renderRows({ ...view, gate: {} as DebateView["gate"] }, 100, collapsed, theme, h),
		"a malformed gate never breaks the frame",
	);

	// 13. the Component wrapper re-renders at the host's width
	const comp = renderDebate(view, collapsed, theme, h);
	assert.ok(comp.render(80).length > 0, "component renders");
	for (const row of comp.render(80)) assert.equal(h.visibleWidth(row), 80, "component row width");

	console.log("debate render self-check OK");
}

if (import.meta.main) await demo();
