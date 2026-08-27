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
