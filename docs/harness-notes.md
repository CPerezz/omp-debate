# Harness notes — extension-API gaps this extension hit

Observed while building `omp-debate` against **omp / `@oh-my-pi/pi-coding-agent` 18.0.6**. Every item is a
concrete thing the extension had to work around, with the evidence that pinned it and a proposed fix. Paths
are relative to `~/.bun/install/global/node_modules/@oh-my-pi/`.

Nothing here is a bug report about incorrect behaviour — the host works as documented. These are places where
the documented surface forced an extension into a workaround it should not need.

---

## 1. A role alias's thinking effort is unrecoverable, so extensions silently under-think

**Symptom.** `modelRoles.plan: anthropic/claude-fable-5:max` in `~/.omp/agent/config.yml` expresses "run the
planning role at maximum effort". An extension that resolves `@plan` and streams with it gets the base model
and **default** effort: the `:max` is parsed, applied to nothing, and discarded. Every debate ran at default
effort for as long as this extension existed, and nothing in the API could reveal it — the resolved `Model`
looks completely healthy.

**Evidence.** `pi-coding-agent/dist/types/extensibility/extensions/types.d.ts:281-287`, `ExtensionModelQuery.resolve`:

> Resolve a model string (`provider/id`, bare id) or role alias (`@slow`, a configured role) to a Model […]
> Thinking/routing suffixes are accepted and resolved to the base model (**pass effort separately**).

"Pass effort separately" is sound advice that cannot be followed: `ExtensionModelQuery` exposes only
`list()`, `current()`, `resolve(spec)`, and `family(model)` (same file, `:276-294`). There is no
`effortFor(spec)`, and `Model` carries no resolved-effort field, so the effort the user configured is
unreachable from an extension.

**Workaround in this repo.** Ultrathink sets `reasoning: "max"` explicitly on the seats the user picks
(`index.ts`, `makeTurnRunner`). That is a feature, not a fix: with ultrathink off, the configured `:max` is
still dropped.

**Proposed fix.** Either return the effort alongside the model — `resolve(spec): { model: Model; effort?: Effort }`
— or add `effortFor(spec: string): Effort | undefined`. Additive; the existing `resolve` shape can stay.

---

## 2. Extension tools cannot declare an animated partial result, so they must fake a repaint clock

**Symptom.** `ToolRenderResultOptions.spinnerFrame` is supplied so a tool can animate while it runs, but the
host only advances it when the tool *emits an update*. A tool whose work is "wait several minutes for a model
that is thinking and emitting nothing" has no way to keep an animation moving — which is precisely when a
progress indicator earns its keep.

**Evidence.** The host already models this exact property internally, for built-in renderers:
`pi-coding-agent/dist/types/tools/renderers.d.ts:53-57`

> `animatedPartialResult?: boolean | ((args: unknown) => boolean);`
> Whether the renderer's partial-result path visibly consumes `options.spinnerFrame`.

The extension-facing `ToolDefinition` (`extensibility/extensions/types.d.ts:444-484`) has no such field, and
`spinnerFrame` is documented as "only provided during partial results"
(`extensibility/custom-tools/types.d.ts:138-139`).

**Workaround in this repo.** A 300 ms `ctx.setInterval` re-emits the last view unchanged purely to trigger a
repaint (`index.ts`, `HEARTBEAT_MS`). It works, but every extension wanting an animation must reinvent it, and
each tick pushes a duplicate payload through the update channel (compounding item 4).

**Proposed fix.** Expose `animatedPartialResult` on `ToolDefinition` and schedule repaint ticks for tools that
set it. The plumbing already exists.

---

## 3. No capability ranking, so a cross-model critic cannot be chosen safely

**Symptom.** An adversarial debate is strongest when the critic is a *different lineage* from the proposer —
different training, different blind spots. Selecting one automatically is unsafe: the only comparison the API
offers is same-family-or-not, with no notion of tier. An early version of this extension tried it and paired a
small fast model against a top-tier one; the critic produced turns a third the length, no new findings on its
second turn, and two factual errors the proposer spent its rebuttal correcting.

**Evidence.** `extensibility/extensions/types.d.ts:288-293`, the whole of what is offered:

> Opaque lineage token for "are these the same family?" comparisons — every Claude point release shares a
> token, Claude and GPT differ. […] Compare it; do not persist it.

Useful for "is this the same model", useless for "is this model strong enough to be a peer".

**Workaround in this repo.** Every seat runs on `@plan` and the adversarial pressure comes from role prompts
and from seating two rival proposers. The tradeoff is explicit in `core.ts` (`pickModel`): a capability deficit
cannot be prompted away, sycophancy partly can.

**Proposed fix.** Expose the catalog's tier/capability signal — even a coarse ordinal, or
`comparableTo(a, b): boolean` — so an extension can ask for "a peer of this model from another family" without
persisting anything version-specific.

---

## 4. `onUpdate` has no delta channel, so streaming a growing transcript is quadratic

**Symptom.** A tool that streams text must re-send its entire accumulated output on every update, because the
callback takes a whole result, not a patch. Streaming an *n*-token transcript costs O(n²) bytes over the RPC
socket.

**Evidence.** `pi-agent-core/dist/types/types.d.ts:605`:

> `export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;`

`AgentToolResult.content` is the full payload; `ToolExecutionUpdateEvent.partialResult`
(`extensibility/extensions/types.d.ts:570-576`) forwards it wholesale to RPC clients.

**Workaround in this repo.** Two mitigations, neither free. The rendered view (`details`) carries no text at
all — the thinking animation replaced the streamed tail, which was unreadable at generation speed anyway — and
per-token emits are coalesced onto the 300 ms heartbeat instead of forwarded one-for-one.

**Proposed fix.** Allow an append-only delta on the update payload (e.g. `appendContent`), leaving the final
result unchanged. Purely additive: tools that ignore it behave as today.

---

## 5. TUI built-in commands silently shadow extension commands, and the registry says otherwise

**Symptom.** This extension registered `/plan` and `/review`. `/review` worked; `/plan` never fired. The
interactive TUI owns a built-in `plan` command (the plan-mode toggle) that is dispatched first, so the
extension handler was unreachable — with no warning at registration and no diagnostic at dispatch.

The trap is that the *introspection* API disagrees with the *dispatch* path. The RPC
`get_available_commands` response listed `plan` with `source: "extension"`, so this repo's smoke suite
asserted the extension owned the command — and passed, on every run, while the command was dead in the TUI.
A test built specifically to catch shadowing could not see the shadowing.

**Evidence.** In `pi-coding-agent/dist/cli.js`:

> `{name:"plan",icon:"plan",description:"Toggle plan mode (agent plans before executing)",inlineHint:"[prompt]",allowArgs:!0,…}`

Compare `extensibility/extensions/types.d.ts` — nothing in `registerCommand`'s surface reports a collision.

**Workaround in this repo.** The commands are now `/plan-debate` and `/review-debate`, and the reason is
recorded at the registration site so nobody "tidies" the names back.

**Proposed fix.** Two independent improvements, both cheap:
1. Warn at registration when an extension command name collides with a built-in that outranks it — the
   collision is known at load time.
2. Include TUI built-ins in `get_available_commands` with their real precedence, so introspection matches
   dispatch and a shadowing test can actually fail.

---

## 6. Extensions cannot reach the native peer bus, and a tool call cannot leave the turn

**Symptom.** omp ships agent-to-agent messaging: `hub` (the former `irc` tool) over a process-global
`IrcBus`, routed through a process-global `AgentRegistry`. An extension that wants its own
participants on that bus — a debate whose seats are real agents that could hold tools and be
addressed by name from Agent Hub — has no documented way in. `ExtensionContext` offers `ui`, `mode`,
`hasUI`, `cwd`, `sessionManager`, `modelRegistry`, `model`, `models`, `isIdle`, `abort`, `compact`,
timers, `invokeTool`, `memory`, and the two usage snapshots. No registry, no bus, no spawn.

The second half compounds it. `ToolDefinition` has no async/background mode, so a tool call runs
inside the session's turn and blocks it. A `hub` message addressed to `Main` is therefore delivered
only "at the next step boundary" — i.e. **after** the tool returns. So even with bus access, a
tool-scoped run could not exchange messages with the user while it ran.

**Evidence.** `extensibility/extensions/types.d.ts`, `ExtensionContext` (`:297-381`) and
`ToolDefinition` (`:444-484`) — neither carries an agent, registry, messaging or async field. The
only route is importing internals from the package root: `runSubprocess` and `AgentRegistry`
(`sdk.d.ts:298`, `task/executor.d.ts`), whose `ExecutorOptions` is a ~50-field contract documented
for standalone embedders, not for in-process extensions. Delivery semantics are in
`session/irc-bridge.ts` (`deliver()`): parent→child becomes `agent.steer()` drained at a later step
boundary, sibling→sibling becomes a non-interrupting aside, and nothing interrupts a turn in flight.

**Workaround in this repo.** The seats stay stateless `streamSimple()` completions, and the user
participates through `ctx.ui` dialogs at round boundaries (`makeGateRunner` in `index.ts`). That is
not a workaround for a missing feature so much as evidence the feature would not have helped: the
blocking-turn constraint rules the bus out for this shape of tool regardless.

**Proposed fix.** Two independent additions. (1) A narrow extension-facing seam for named
participants — spawn a subagent, address it, await its reply — rather than exposing the executor's
internal option bag. (2) An opt-in async tool mode, so a long-running tool can leave the turn and
therefore become reachable over the bus at all.

---

## 7. A timed-out ask dialog answers itself with the recommended option

**Symptom.** `ExtensionUIDialogOptions.timeout` reads like "give up after N seconds". It is not:
the implementation fills every unanswered question with its `recommended` option and submits with
`timedOut: true`. An extension that treats a timeout as cancellation — as this one did, with a
comment saying `undefined` = cancelled or timed out — silently runs whatever it happened to
recommend. Here that meant an unattended pre-flight dialog could start a **maximum-effort** debate
while the README promised cheap defaults on timeout.

**Evidence.** `modes/components/ask-dialog.ts`, `#handleTimeout`: for each unanswered question it
resolves a `fallbackIndex` from `question.recommended`, adds that label to `selectedOptions`, sets
`state.timedOut = true`, and submits. Nothing in `ExtensionUIDialogOptions` documents this.

**Workaround in this repo.** `resolvePreflight` and the gate runner both check
`results.some(r => r.timedOut)` and treat it as a cancel, restoring the documented behaviour.

**Proposed fix.** Document the auto-submit on the `timeout` field, or add an explicit
`timeoutBehaviour: "submit" | "cancel"` so the caller states which it wants.

---

## 8. `ctx.ui.editor` silently ignores `timeout`

**Symptom.** `select`, `confirm` and `input` all honour `ExtensionUIDialogOptions.timeout`. The
multi-line `editor` accepts the same options object and drops it: only submit, Esc, or an aborted
signal ever closes it. An extension that relies on a timeout to keep an unattended surface moving
gets an unbounded wait instead, with nothing at the type level to warn it.

**Evidence.** `modes/controllers/extension-ui-controller.ts`: `showHookInput` and
`showHookSelector` pass `timeout`/`onTimeout` into their components; `showHookEditor` constructs
`HookEditorComponent` with title, prefill, submit and cancel callbacks plus `editorOptions`, and
never forwards `dialogOptions.timeout`.

**Workaround in this repo.** The gate flow puts its timeout on the menu dialog, which does honour
it, and treats the editor as unbounded on purpose — a half-typed challenge should not vanish on a
clock. The reason is recorded at the call site so nobody "fixes" it by adding a `timeout` that does
nothing.

**Proposed fix.** Wire `timeout`/`onTimeout` through `showHookEditor`, or mark them unsupported for
`editor` in the type.

---

## 9. `ExtensionUIDialogOptions.timeout` is milliseconds, and nothing says so

**Symptom.** The field is documented as "UI dialog options for extensions" with `timeout?: number` and
no unit. It is milliseconds. This extension passed seconds for its entire existence
(`PREFLIGHT_TIMEOUT_S = 120`), so every pre-flight dialog expired after **120 ms** — before a human
could read it, let alone answer. Combined with item 7 (a timed-out dialog submits its `recommended`
option rather than cancelling), the advertised "the tool asks you how many agents should debate"
silently answered itself with the recommended option on every run. The README documented behaviour
the code could not deliver, and no test could see it: the RPC smoke tier has no UI, so the dialog
path never executes there.

**Evidence.** `modes/components/ask-dialog.ts:424-433` passes `options.timeout` straight into
`new CountdownTimer(timeoutMs, …)`, and `modes/components/countdown-timer.ts:13-21` names the
parameter `timeoutMs`, uses it as `setTimeout(…, this.#initialMs)`, and renders
`Math.ceil(timeoutMs / 1000)` as the countdown. `extensibility/extensions/types.d.ts` documents
neither the unit nor the auto-submit.

**How it surfaced.** A live TUI run of the interactive gates: both gates reported
`gate timed out; the debate continued` within seconds of opening, and the dialog frame rendered
`╭─ Ask (1s) ─` — a one-second countdown for what was meant to be five minutes.

**Workaround in this repo.** Every dialog budget is now named `*_MS` and passed in milliseconds,
with the unit and its history recorded at the constant.

**Proposed fix.** Rename the field `timeoutMs`, or document the unit on it. A dialog budget is
exactly the kind of value where a silent unit mismatch produces plausible-looking behaviour instead
of an error.
