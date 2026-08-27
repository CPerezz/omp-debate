#!/usr/bin/env bun
// Screenshot source for the README.
//
//   bun shots.ts done        a finished 4-debater debate, including a user interjection
//   bun shots.ts streaming   a turn in flight, showing the thinking animation
//   bun shots.ts gate        a round gate open, waiting for the user
//
// Plain-bun safe: imports only ./core.js and ./render.js (pure), and paints with
// raw ANSI rather than the host theme so it runs outside omp. Piped through
// `freeze` to produce docs/*.png.
//
// Always regenerate with `bun run shots` after a layout change, never by invoking
// `freeze` directly: the scripts pass an explicit monospace `--font.family`
// because freeze's fallback font renders box-drawing characters at a different
// advance width and the bubbles visibly break.

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
	summary?: string[];
	/** Real body, for seats whose text is actually rendered (the verdict, and any
	 *  user turn). Everything else stays filler, since a collapsed bubble shows
	 *  only its summary. */
	text?: string;
	/** Seats a user turn was addressed to. */
	to?: string[];
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
		role: "user",
		seat: 1,
		label: "User",
		chars: 0,
		to: ["Critic B"],
		text: "Per-endpoint costs are a requirement, not a nice-to-have — billing depends on them. Does that kill the edge-only proposal?",
	},
	{
		role: "adjudicator",
		seat: 1,
		label: "Adjudicator",
		chars: 0,
		text: [
			"## Rate limiting",
			"",
			"1. Edge rules enforce a blunt per-IP ceiling. Zero application code, nothing to operate.",
			"2. A Redis token bucket enforces per-key budgets, because per-endpoint costs are a stated",
			"   requirement and edge rules cannot see the API key — auth rewrites the header downstream.",
			"3. Create the counter with `SET key 1 NX PX 60000`, never `INCR` then `EXPIRE`: the two-call",
			"   form can leave a key with no TTL and leak it forever.",
			"4. Fail closed when Redis times out. Log and alert; never silently allow.",
			"5. `Retry-After` is derived from the bucket refill time, not a fixed constant.",
			"",
			"One test: the Retry-After arithmetic and the fail-closed path. The fixed-versus-sliding",
			"window question is moot at 100 req/min and is not worth a test.",
		].join("\n"),
	},
];

const seatTurn = (s: SeatFixture) => {
	// Collapsed bubbles render the summary and the char count, never the body, so
	// filler only needs the right length; a rendered body must be real.
	const text = s.text ?? "body ".repeat(Math.ceil(s.chars / 5)).slice(0, s.chars);
	return {
		role: s.role,
		seat: s.seat,
		label: s.label,
		modelId: s.role === "user" ? "" : "claude-fable-5",
		chars: text.length,
		text,
		...(s.summary ? { summary: s.summary.join("\n") } : {}),
		...(s.to ? { to: s.to } : {}),
	};
};

const DONE: DebateView = {
	model: "claude-fable-5",
	aborted: false,
	turns: SEATS.map(seatTurn),
};

const STREAMING: DebateView = {
	...DONE,
	turns: DONE.turns.slice(0, 2),
	current: { role: "critic", seat: 1, label: "Critic A" },
};

/** A round gate holding the debate open. No `current`: nothing is thinking, which
 *  is exactly why the renderer paints a paused row instead of an animation. */
const GATE: DebateView = {
	...DONE,
	turns: DONE.turns.slice(0, 4),
	gate: { kind: "round", round: 1 },
};

const mode = process.argv[2] ?? "done";
const view = mode === "streaming" ? STREAMING : mode === "gate" ? GATE : DONE;
const opts: RenderOpts = { expanded: false, isPartial: mode !== "done", spinnerFrame: FRAME };
const rows = renderRows(view, WIDTH, opts, ansiTheme, fakeHelpers());
// Trailing padding is load-bearing inside the TUI but only inflates the PNG.
console.log(rows.map((r) => r.replace(/\s+$/, "")).join("\n"));
