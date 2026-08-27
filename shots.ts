#!/usr/bin/env bun
// Screenshot source for the README.
//
//   bun shots.ts done        a finished 4-debater debate
//   bun shots.ts streaming   a turn in flight, showing the thinking animation
//
// Plain-bun safe: imports only ./core.js and ./render.js (pure), and paints with
// raw ANSI rather than the host theme so it runs outside omp. Piped through
// `freeze` to produce docs/*.png — see the README's Development section.

import type { Theme } from "@oh-my-pi/pi-coding-agent";

import type { DebateView, Role } from "./core.js";
import { type RenderOpts, fakeHelpers, renderRows } from "./render.js";

const WIDTH = 100;
/** Frame 2 of the dot cycle: all three dots visible. */
const FRAME = 2;

const COLOURS: Record<string, number> = {
	accent: 75,
	error: 203,
	warning: 179,
	success: 114,
	muted: 245,
};

/** 256-colour stand-in for the host theme. `fakeHelpers().visibleWidth` strips
 *  these escapes, so the layout measures exactly as it does in omp. */
const ansiTheme = {
	fg: (colour: string, s: string) => {
		const code = COLOURS[colour];
		return code === undefined ? s : `\x1b[38;5;${code}m${s}\x1b[39m`;
	},
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
	spinnerFrames: ["⠋", "⠙", "⠹", "⠸"],
} as unknown as Theme;

interface SeatFixture {
	role: Role;
	seat: number;
	label: string;
	chars: number;
	summary: string[];
}

const SEATS: SeatFixture[] = [
	{
		role: "proposer",
		seat: 1,
		label: "Proposer A",
		chars: 8421,
		summary: [
			"• Token bucket in middleware: 100 req/min per API key.",
			"• Counter state in Redis so it survives a deploy — INCR + EXPIRE, one round trip.",
			"• 429 with Retry-After derived from the bucket refill time.",
		],
	},
	{
		role: "proposer",
		seat: 2,
		label: "Proposer B",
		chars: 7150,
		summary: [
			"• Rival: enforce at the edge with CDN rules, zero application code.",
			"• Per-key budgets live in committed config, so there is no datastore to operate.",
			"• Concedes: cannot express per-endpoint costs, only request counts.",
		],
	},
	{
		role: "critic",
		seat: 1,
		label: "Critic A",
		chars: 9034,
		summary: [
			"• A's INCR+EXPIRE races: a key can be created without a TTL and then leak forever.",
			"• Neither proposal states the behaviour when Redis is unreachable.",
			"• B's edge rules cannot see the API key — auth rewrites the header downstream.",
		],
	},
	{
		role: "critic",
		seat: 2,
		label: "Critic B",
		chars: 6612,
		summary: [
			"• A is over-built: at 100 req/min a fixed window is indistinguishable from sliding.",
			"• The Retry-After arithmetic is the only part that genuinely needs a test.",
			"• B ships in an afternoon and covers the abuse actually observed in the logs.",
		],
	},
	{
		role: "adjudicator",
		seat: 1,
		label: "Adjudicator",
		chars: 11480,
		summary: [
			"• Adopt B's edge rules for the blunt per-IP ceiling — it costs nothing to run.",
			"• Adopt A's Redis bucket for per-key budgets, with SET NX PX to close the TTL race.",
			"• Fail closed when Redis times out; log and alert rather than silently allowing.",
			"• One test: Retry-After arithmetic plus the fail-closed path.",
		],
	},
];

const DONE: DebateView = {
	model: "claude-fable-5",
	aborted: false,
	turns: SEATS.map((s) => ({
		role: s.role,
		seat: s.seat,
		label: s.label,
		modelId: "claude-fable-5",
		chars: s.chars,
		// Collapsed bubbles render the summary and the char count, never the body,
		// so the filler only needs the right length.
		text: "body ".repeat(Math.ceil(s.chars / 5)).slice(0, s.chars),
		summary: s.summary.join("\n"),
	})),
};

const STREAMING: DebateView = {
	...DONE,
	turns: DONE.turns.slice(0, 2),
	current: { role: "critic", seat: 1, label: "Critic A" },
};

const streaming = process.argv[2] === "streaming";
const opts: RenderOpts = { expanded: false, isPartial: streaming, spinnerFrame: FRAME };
const rows = renderRows(streaming ? STREAMING : DONE, WIDTH, opts, ansiTheme, fakeHelpers());
// Trailing padding is load-bearing inside the TUI but only inflates the PNG.
console.log(rows.map((r) => r.replace(/\s+$/, "")).join("\n"));
