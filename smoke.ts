#!/usr/bin/env bun
// Tiered smoke suite for the debate extension.
//
//   bun smoke.ts          free: pure self-checks + host tool/command registration (~5 s, no tokens)
//   bun smoke.ts --live   adds one real rounds:1 debate driven through /plan-debate (2-5 min)
//
// Plain-bun safe: imports only ./core.js and ./render.js (pure). The omp host is
// exercised as a subprocess, never imported (pi-natives cannot load out-of-host).
//
// Why RPC and not `omp -p`: the /plan-debate handler injects a steer via
// pi.sendUserMessage, which starts a *new* agent run. Print mode considers its
// own prompt resolved once the slash command is consumed, disposes the session,
// and kills that run at the dispose deadline ("Active agent run still settling
// at dispose deadline" in ~/.omp/logs) — no tool ever executes. An RPC session
// lives until stdin closes, so the injected run completes.

import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DebateView } from "./core.js";
import { fakeHelpers, fakeTheme, renderRows } from "./render.js";

interface Frame {
	type?: string;
	command?: string;
	success?: boolean;
	isTerminal?: boolean;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	error?: string;
	data?: { commands?: { name: string; source?: string; description?: string }[] };
	result?: { details?: unknown; content?: { type: string; text?: string }[] };
}

const HERE = import.meta.dir;
const FRAME_DUMP = join(tmpdir(), "omp-debate-live-frames.jsonl");
let failures = 0;
const pass = (m: string) => console.log(`PASS  ${m}`);
const warn = (m: string) => console.log(`WARN  ${m}`);
const fail = (m: string) => {
	failures++;
	console.log(`FAIL  ${m}`);
};

async function run(cmd: string[], cwd: string, timeoutMs: number): Promise<{ out: string; code: number }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const killer = setTimeout(() => proc.kill(), timeoutMs);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	clearTimeout(killer);
	return { out: stdout + stderr, code };
}

/** Drive one `omp --mode rpc` session: send `commands`, collect stdout frames
 *  until `stop` matches or the deadline passes, then shut the child down. */
async function rpc(
	commands: object[],
	stop: (f: Frame) => boolean,
	timeoutMs: number,
): Promise<{ frames: Frame[]; raw: string; timedOut: boolean }> {
	const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-session", "--auto-approve"], {
		cwd: tmpdir(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderrDrain = new Response(proc.stderr).text();
	for (const c of commands) proc.stdin.write(`${JSON.stringify(c)}\n`);
	proc.stdin.flush();

	const frames: Frame[] = [];
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	const TIMEOUT = Symbol("timeout");
	let raw = "";
	let buf = "";
	let timedOut = false;

	reading: while (true) {
		const left = deadline - Date.now();
		if (left <= 0) {
			timedOut = true;
			break;
		}
		const next = await Promise.race([reader.read(), Bun.sleep(left).then(() => TIMEOUT)]);
		if (next === TIMEOUT) {
			timedOut = true;
			break;
		}
		if (next.done) break;
		const chunk = decoder.decode(next.value, { stream: true });
		raw += chunk;
		buf += chunk;
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch {
				continue; // non-JSON line (never seen in practice; ignore defensively)
			}
			frames.push(frame);
			if (stop(frame)) break reading;
		}
	}

	proc.stdin.end();
	proc.kill();
	await proc.exited;
	raw += await stderrDrain;
	return { frames, raw, timedOut };
}

// ---- tier 0: pure self-checks --------------------------------------------
for (const file of ["core.ts", "render.ts"]) {
	const r = await run(["bun", file], HERE, 30_000);
	if (r.code === 0 && r.out.includes("self-check OK")) pass(`self-check ${file}`);
	else fail(`self-check ${file} (exit=${r.code}): ${r.out.slice(-400)}`);
}

// ---- tier 1a: tool registration ------------------------------------------
// An invalid --tools value makes the CLI enumerate the live registry and exit.
// `debate` in that list proves the host loaded this repo and ran the factory.
{
	const r = await run(["omp", "--tools=__nope__", "-p", "x", "--no-session"], tmpdir(), 60_000);
	const m = r.out.match(/Valid tools:([^\n]+)/);
	if (!m) fail(`tool registration: no "Valid tools:" line: ${r.out.slice(-400)}`);
	else {
		const tools = m[1].split(",").map((s) => s.trim().replace(/\.$/, ""));
		const count = tools.filter((t) => t === "debate").length;
		if (count === 1) pass("tool registration: debate present exactly once");
		else fail(`tool registration: expected exactly one 'debate', got ${count} in [${tools.join(", ")}]`);
	}
}

// ---- tier 1b: command registration ---------------------------------------
// get_available_commands is first-wins across built-ins, skills, extensions and
// file commands, so `source: "extension"` here also proves nothing shadows the
// names — the failure mode that silently swallowed the original `/plan`, which
// the interactive TUI owns as its plan-mode toggle.
{
	const { frames, raw, timedOut } = await rpc(
		[{ id: "c1", type: "get_available_commands" }],
		(f) => f.command === "get_available_commands",
		60_000,
	);
	const cmds = frames.find((f) => f.command === "get_available_commands")?.data?.commands ?? [];
	if (timedOut || cmds.length === 0) fail(`command registration: no command list (timedOut=${timedOut}): ${raw.slice(-400)}`);
	else {
		for (const name of ["plan-debate", "review-debate"]) {
			const hits = cmds.filter((c) => c.name === name);
			if (hits.length === 1 && hits[0].source === "extension" && hits[0].description?.includes("adversarial"))
				pass(`command registration: /${name} owned by the extension`);
			else fail(`command registration: /${name} → ${JSON.stringify(hits)}`);
		}
	}
}

// ---- tier 2: one real debate through /plan-debate (opt-in) ----------------
if (process.argv.includes("--live")) {
	// Driving the slash command (not a "call the debate tool" instruction) covers
	// the whole chain: command dispatch → injected steer → orchestrator → tool.
	const message =
		"/plan-debate Add a --dry-run flag to deploy.sh. Context for the briefing: bash script, ~50 lines, " +
		"rsync then systemctl restart, no tests exist. Use rounds=1. Do not read any files; " +
		"the briefing above is the whole context. When calling the debate tool pass debaters=2 and " +
		"ultrathink=\"none\" so this unattended run never waits on the pre-flight dialog.";
	const { frames, raw, timedOut } = await rpc(
		[{ id: "p1", type: "prompt", message }],
		(f) => f.type === "agent_end" && f.isTerminal !== false,
		900_000,
	);
	await Bun.write(FRAME_DUMP, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);

	if (timedOut) fail("live: timed out before agent_end");
	const ends = frames.filter((f) => f.type === "tool_execution_end" && f.toolName === "debate");
	if (ends.length !== 1) {
		fail(
			`live: expected exactly 1 debate tool_execution_end, got ${ends.length} — /plan-debate did not ` +
				`dispatch, ` +
				`quota is exhausted, or the extension failed to load; frames: ${FRAME_DUMP}, raw tail: ${raw.slice(-400)}`,
		);
	} else {
		pass("live: /plan-debate dispatched and the debate tool executed");
		const end = ends[0];
		const view = end.result?.details as DebateView | undefined;
		const bodyText = end.result?.content?.[0]?.text ?? "";
		const updates = frames.filter(
			(f) => f.type === "tool_execution_update" && f.toolCallId === end.toolCallId,
		).length;

		if (end.isError) fail("live: isError=true");
		else pass("live: debate returned without error");

		if (!view || !Array.isArray(view.turns)) {
			fail("live: details is not a DebateView");
		} else {
			const roles = view.turns.map((t) => t.role).join(",");
			if (roles === "proposer,critic,adjudicator") pass("live: turn order proposer→critic→adjudicator");
			else fail(`live: wrong turn order: ${roles}`);

			const labels = view.turns.map((t) => t.label).join(",");
			if (labels === "Proposer,Critic,Adjudicator") pass("live: one seat per role, unsuffixed labels");
			else fail(`live: wrong speaker labels: ${labels}`);

			const ids = new Set(view.turns.map((t) => t.modelId));
			if (ids.size === 1 && !ids.has("")) pass(`live: all roles on one model (${[...ids][0]})`);
			else fail(`live: expected one shared model id, got [${[...ids].join("|")}]`);

			if (view.turns.every((t) => t.text.length > 0 && t.chars === t.text.length))
				pass("live: every turn has text and an accurate chars count");
			else fail("live: empty turn text or wrong chars");

			if (!("transcript" in (view as object)) && view.aborted === false && !view.error && view.current == null)
				pass("live: details contract (no transcript duplication, clean finish)");
			else fail("live: details payload contract violated");

			if (bodyText.includes("All roles ran on")) pass("live: notes footer present");
			else fail("live: notes footer missing from content");

			if (bodyText.includes("Debaters: 1 proposer(s) + 1 critic(s)"))
				pass("live: notes state the resolved seating");
			else fail("live: notes missing the resolved seating line");

			// Updates arrive at turn boundaries plus the 300 ms heartbeat, so a
			// healthy three-turn debate clears this floor comfortably.
			if (updates >= 6) pass(`live: progressive streaming observed (${updates} updates)`);
			else fail(`live: only ${updates} update events — streaming path broken?`);

			// Summary degradation contract: every turn summarised, OR flagged
			// summaryFailed, OR the no-summariser note present with none flagged.
			const flagged = view.turns.filter((t) => t.summaryFailed === true).length;
			const missing = view.turns.filter((t) => !t.summary && t.summaryFailed !== true).length;
			if (view.turns.every((t) => t.summary)) pass("live: all turns summarised");
			else if (missing > 0 && bodyText.includes("No cheap model resolved"))
				warn("live: no summariser model resolved; head-line fallback active");
			else if (missing === 0) warn(`live: ${flagged} summaries failed; degradation contract held`);
			else fail("live: turn with neither summary nor summaryFailed — contract breached");

			// Geometry against the real captured view (ASCII-fake helpers; the
			// real-Unicode split is documented in the rendering spec).
			const h = fakeHelpers();
			const th = fakeTheme();
			for (const w of [100, 60]) {
				const rows = renderRows(view, w, { expanded: false, isPartial: false }, th, h);
				const bad = rows.filter((row) => h.visibleWidth(row) !== w).length;
				if (bad === 0 && rows.length > 0) pass(`live: renderRows uniform at width ${w} (${rows.length} rows)`);
				else fail(`live: ${bad} rows off-width at ${w}`);
			}
			const rows100 = renderRows(view, 100, { expanded: false, isPartial: false }, th, h);
			const joined = rows100.join("\n");
			if (["Proposer", "Critic", "Adjudicator"].every((n) => joined.includes(n)))
				pass("live: all three role headers rendered");
			else fail("live: missing role header in rendered output");

			// Layout contract: the adjudicator's verdict spans everything but a
			// 2-column margin; debaters stay at 70% so the sides read as a chat.
			const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
			const adjHead = rows100.find((r) => strip(r).includes("Adjudicator") && strip(r).includes("╭"));
			if (!adjHead) {
				fail("live: no adjudicator bubble header at width 100");
			} else {
				const lead = strip(adjHead).search(/\S/);
				const end = strip(adjHead).trimEnd().length;
				if (lead === 2 && end >= 96) pass(`live: adjudicator spans cols ${lead}–${end} of 100`);
				else fail(`live: adjudicator geometry wrong (lead=${lead}, end=${end})`);
			}
			const propHead = rows100.find((r) => strip(r).includes("Proposer") && strip(r).includes("╭"));
			const propWidth = propHead ? strip(propHead).trimEnd().length : -1;
			if (propWidth === 70) pass("live: proposer bubble is 70% of width");
			else fail(`live: proposer bubble width ${propWidth}, expected 70`);
		}
	}
	if (failures) console.log(`\nframes dumped to ${FRAME_DUMP}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL SMOKE CHECKS PASSED");
process.exit(failures ? 1 : 0);
