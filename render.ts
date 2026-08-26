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
import { LABEL, type DebateView, type Role } from "./core.js";

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

const COLOUR: Record<Role, "accent" | "error" | "success"> = {
	proposer: "accent",
	critic: "error",
	adjudicator: "success",
};
const FRACTION: Record<Role, number> = { proposer: 0.6, critic: 0.6, adjudicator: 0.5 };
const MAX_SUMMARY_LINES = 10;
const STREAM_TAIL_LINES = 6;
const FALLBACK_HEAD_LINES = 6;
const MIN_SIDES_WIDTH = 72;
const MIN_BOX_WIDTH = 24;

/** `" ".repeat(-1)` throws, and every padding computation here can go negative
 *  when a truncation lands exactly on the boundary. Clamping in one place keeps
 *  a rounding slip from taking down the whole TUI frame. */
const spaces = (n: number): string => " ".repeat(Math.max(0, n));

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
	colour: "accent" | "error" | "success",
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
	colour: "accent" | "error" | "success",
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

/** Body lines for one completed turn, honouring collapse/expand and failures. */
function bodyFor(
	turn: DebateView["turns"][number],
	innerWidth: number,
	expanded: boolean,
	h: RenderHelpers,
): string[] {
	if (expanded) return h.wrap(turn.text, innerWidth);
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
			if (plain) {
				for (const line of bodyFor(turn, width, opts.expanded, h)) {
					const cut = h.truncate(line, width);
					rows.push(cut + spaces(width - h.visibleWidth(cut)));
				}
				continue;
			}
			if (!sides) {
				const body = bodyFor(turn, width - 2, opts.expanded, h);
				rows.push(...guttered(LABEL[turn.role], turn.modelId, body, width, COLOUR[turn.role], theme, h));
				rows.push(spaces(width));
				continue;
			}
			const bw = Math.floor(width * FRACTION[turn.role]);
			const off = offsetFor(turn.role, width, bw);
			const body = bodyFor(turn, bw - 4, false, h);
			for (const r of boxed(LABEL[turn.role], turn.modelId, body, bw, COLOUR[turn.role], theme, h))
				rows.push(spaces(off) + r + spaces(width - off - h.visibleWidth(r)));
			rows.push(spaces(width));
		}

		if (view.current && !plain) {
			const role = view.current.role;
			const frames = theme.spinnerFrames;
			const spin = frames[(opts.spinnerFrame ?? 0) % frames.length] ?? "";
			const bw = sides ? Math.floor(width * FRACTION[role]) : width;
			const tail = h.wrap(view.current.tail, sides ? bw - 4 : width - 2).slice(-STREAM_TAIL_LINES);
			if (sides) {
				const off = offsetFor(role, width, bw);
				for (const r of boxed(LABEL[role], spin, tail, bw, COLOUR[role], theme, h))
					rows.push(spaces(off) + r + spaces(width - off - h.visibleWidth(r)));
			} else {
				rows.push(...guttered(LABEL[role], spin, tail, width, COLOUR[role], theme, h));
			}
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
				text: "P ".repeat(400).trim(),
				summary: "proposes a flag\nvalidated early",
				modelId: "claude-fable-5",
				chars: 799,
			},
			{
				role: "critic",
				text: "C ".repeat(300).trim(),
				summary: "still pressing set -e\nconceded systemctl",
				modelId: "claude-fable-5",
				chars: 599,
			},
			{
				role: "adjudicator",
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

	// 2. side placement: proposer flush left, critic right-aligned, adjudicator centred
	const rows = renderRows(view, 100, collapsed, theme, h);
	const pRow = rows.find((r) => r.includes("Proposer"));
	const cRow = rows.find((r) => r.includes("Critic"));
	const aRow = rows.find((r) => r.includes("Adjudicator"));
	assert.ok(pRow && cRow && aRow, "a header row exists for each role");
	assert.equal(pRow.search(/\S/), 0, "proposer flush left");
	assert.equal(stripAnsi(cRow).trimEnd().length, 100, "critic right edge at width");
	const aLeft = aRow.search(/\S/);
	const aRight = 100 - stripAnsi(aRow).trimEnd().length;
	assert.ok(Math.abs(aLeft - aRight) <= 1, "adjudicator centred within one column");

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

	// 5. headers name the role and the model
	assert.ok(
		stripAnsi(pRow).includes("Proposer") && stripAnsi(pRow).includes("claude-fable-5"),
		"header content",
	);

	// 6. streaming shows a tail and a spinner, no summary
	const live: DebateView = {
		...view,
		turns: view.turns.slice(0, 1),
		current: { role: "critic", tail: "x ".repeat(200).trim() },
	};
	const liveRows = renderRows(live, 100, { expanded: false, isPartial: true, spinnerFrame: 1 }, theme, h);
	for (const row of liveRows) assert.equal(h.visibleWidth(row), 100, "streaming row width");
	assert.ok(stripAnsi(liveRows.join("\n")).includes("/"), "spinner frame rendered");
	assert.ok(stripAnsi(liveRows.join("\n")).includes("x x"), "live tail rendered");

	// 7. a failed summary falls back to head lines with a marker
	const failed: DebateView = {
		...view,
		turns: [
			{
				role: "proposer",
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

	// 10. the Component wrapper re-renders at the host's width
	const comp = renderDebate(view, collapsed, theme, h);
	assert.ok(comp.render(80).length > 0, "component renders");
	for (const row of comp.render(80)) assert.equal(h.visibleWidth(row), 80, "component row width");

	console.log("debate render self-check OK");
}

if (import.meta.main) await demo();
