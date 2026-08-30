# Design: RPC surface + in-pi panes dashboard

**Goal.** Remove the hard tmux dependency from pi-interactive-subagents. Child pi agents can
run as headless `pi --mode rpc` processes (JSONL over stdio) instead of processes typed into
tmux panes. An optional, toggleable in-pi "panes" dashboard renders live views of every
running subagent (rpc *and* tmux) inside the parent pi TUI, with the ability to type into a
focused pane and steer the child.

**Non-goals.**

- No changes to the Claude-CLI agent backend (`pi-subagents:claude`); it stays tmux-only.
- No changes to child-side behavior (`subagent-done.ts` needs zero modifications).
- No changes to the tmux code path's byte-level output — it must remain a drop-in.
- No xterm emulation. Panes are pi-tui components, not terminal emulators.

---

## 1. Surface abstraction

Today `tmux.ts` exports the five surface primitives and `index.ts` calls them directly.
We keep `tmux.ts` exactly as-is and add `rpc.ts` implementing the same five primitives for
child processes spawned over RPC. Surface ids are namespaced:

- tmux: existing raw pane id (`%3`), unchanged.
- rpc: `rpc:<uuid>` — the `rpc:` prefix is unambiguous (tmux ids start with `%`).

Dispatch lives in a new `surface.ts`:

```ts
export type SurfaceId = string;                    // "%3" | "rpc:<uuid>"
export function isRpcSurface(id: SurfaceId): boolean { return id.startsWith("rpc:"); }
```

The launch path builds a **raw, structured child launch spec** (new function in `index.ts`,
extracted from the current command-string construction):

```ts
interface ChildLaunchSpec {
    agentType: "pi" | "claude";
    argv: string[];        // full CLI argv for the child, no shell quoting applied
    env: Record<string, string>;
    cwd: string;
    prompts: string[];     // positional messages, in CLI submission order
}
```

Two renderers consume it:

- **tmux renderer** — produces the exact shell string `sendLongCommand` receives today
  (`cdPrefix + envPrefix + argv.join(" ") + sentinel echo`). Byte-identical output is a hard
  requirement; the construction code is moved, not rewritten. `prompts` become trailing
  positional args, quoted with the existing `shellEscape`.
- **rpc renderer** (`rpc.ts`) — spawns `argv[0]` with `argv.slice(1)` via `child_process.spawn`
  (no shell), sets `env`, `cwd`, pipes stdio, and delivers `prompts` as sequential RPC
  `prompt` commands (§3).

**Backend selection** (`config.json`, backward compatible — old configs keep working):

```jsonc
{
  "surface": {
    "backend": "auto" | "tmux" | "rpc",   // default "auto"
    "panes": { "enabled": true }           // dashboard on by default; toggleable at runtime
  }
}
```

`auto` = tmux when the parent itself runs inside tmux (`TMUX` env set and tmux binary
available), else rpc. Explicit `tmux`/`rpc` overrides. Claude agent type forces tmux
regardless (documented; if tmux missing → existing error path).

**pi binary resolution** (rpc backend), in order:
1. `PI_SUBAGENT_BIN` env var (explicit override)
2. `pi` found on PATH (which pi)
3. Derive from the running parent: the host pi package dir
   (`createRequire(import.meta.url).resolve("@mariozechner/pi-coding-agent/package.json")`
   walking up, with the legacy `pi-coding-agent` / current `@earendil-works/*` names tried)
   → `<dir>/dist/pi.js` run with `process.execPath`; if the package ships a bin shim, use it.

## 2. RPC protocol notes (floor: pi ≥ 0.65, recommend ≥ 0.80.4)

`pi --mode rpc` reads JSONL commands on stdin, writes JSONL events on stdout. All flags the
tmux path passes on the CLI (`--session`, `-e KEY=V`, `--tools`, `--no-extensions`,
`--system-prompt`) are honored identically in rpc mode — the rpc renderer reuses the *same*
`argv`, only prepending `--mode rpc` and adjusting stdio.

Framing rules for our client (`rpc-client.ts`):

- **Never use Node's `readline`** — it splits on U+2028/U+2029. Hand-roll an LF-only
  line splitter over a growing buffer.
- One JSON object per line, both directions.
- Commands carry an incrementing `id`; responses reference it. A `prompt` response may be
  emitted *immediately* (before the agent run) on pi ≥ 0.57 — never treat a response as
  "run finished".

Version-dependent behavior (runtime feature detection, never version parsing):

| Concern | pi ≥ 0.80.4 | pi 0.65 – 0.80.3 |
|---|---|---|
| Run-settled signal | `agent_settled` event | infer from `agent_end` + "final-looking" heuristic + reap-nudge |
| Auto-exit child (`PI_SUBAGENT_AUTO_EXIT=1` + subagent-done) | exits on its own after final turn | `ctx.shutdown()` flag only consumed after next handled command → **reap-nudge** |
| Prompt queueing | queue next prompt on `agent_settled` | queue next on `agent_end`, plus nudge |

**Reap-nudge**: ~2s after observing what looks like a final `agent_end` on an auto-exit
child, send `{"type":"get_last_assistant_text"}`. The child handles it (any handled command
works), consumes the shutdown flag, and exits. Harmless on newer pi (the child has usually
already exited; send is a no-op / EPIPE we swallow).

**Exit detection** is unchanged for both backends: the child-side extension
(`subagent-done.ts`) writes the `.exit` sidecar file on stop and `.ask` for questions, then
calls `ctx.shutdown()`. `pollForExit` already prefers the sidecar. For rpc children we add a
second belt: the child stdio `close` event. The existing poll priority order is preserved:
`.exit` sidecar (deleted on read) → `sentinelFile` → (rpc only) process exit code, which we
report as the exit code, or 1 if killed.

**`@file` task args**: RPC `prompt` does not expand `@path` references (CLI arg parsing
does). The rpc renderer inlines `@path` file content into the prompt text itself (read at
spawn time, before the process exists — the file always exists because the parent wrote it).
Other prompt words pass through verbatim, except empty separator args (`""` from
`buildPiPromptArgs`) which are dropped — they are a CLI-quoting artifact.

**Prompt semantics** (matches CLI positional-arg behavior verified in pi source:
`buildInitialMessage` joins the first positional + @file text into the initial message;
remaining positionals are submitted serially, each awaited —
`interactive-mode.ts:1171-1180`). The rpc renderer delivers the same logical sequence as a
prompts queue: one `{"type":"prompt"}` per entry, serialized — the next is only sent after
the previous run settles (`agent_settled`, or `agent_end` + nudge on old pi). Skill prompts
(`/skill:name`) are queued after the task message, matching the CLI's submission order.

## 3. `rpc.ts` — surface implementation

Structure:

```ts
interface RpcSurfaceOptions { /* spec, sessionFile, sentinelFile, artifactDir, id, name */ }
createRpcSurface(spec, opts): Promise<SurfaceId>   // spawn + handshake + return "rpc:<uuid>"
sendRpcCommand(id, text): void                       // queue a prompt command
sendRpcLongCommand(id, parts): void                  // same, for parity (joins parts)
readRpcScreen(id): string                            // last render of transcript buffer
closeRpcSurface(id): void                            // kill process tree
pollRpcForExit(id, {interval, sessionFile, sentinelFile, onTick}): Promise<{exitCode, reason?}>
```

Internal pieces:

- **`RpcClient`** (in `rpc-client.ts`): hand-rolled LF-only JSONL client. Id correlation,
  pending-response map, event subscription, write with backpressure swallow (EPIPE when the
  child died = normal race), spawn/kill, stdin queue with flow control (pause/resume on
  drain). Exposed for tests via `__test__`.
- **Transcript ring buffer**: the surface keeps the last N (default 400) rendered text lines
  derived from RPC events — message starts/ends, tool calls (`name(input-summary)`), errors
  — a plain-text approximation of what the tmux screen would show. This is what
  `readRpcScreen` returns and what the panes dashboard displays for rpc children. It is *not*
  used for control flow (exit detection stays sidecar-based), except as a fallback where
  tmux's screen-regex fallback would have applied.
- **Per-surface state map** `Map<uuid, RpcSurface>` — process handle, client, buffer, prompt
  queue, last-activity timestamp (fed into the existing stall detector unchanged).

### Call-site mapping in `index.ts` (no signature changes to the five primitives)

| Call site | Today | After |
|---|---|---|
| launch, `index.ts:~1207` | `createSurface(name)` | `createSurfaceFor(spec, name)` → tmux or rpc render + spawn |
| launch, `sendLongCommand` ~1284/1425 | shell string | tmux: same string (unchanged); rpc: prompts queue |
| steer, `steerSubagent` ~1015 | flattened text via injectable sender | rpc: sends message as next prompt (unflattened — rpc delivers verbatim) |
| resume ~2152/2226 | tmux-only | works on rpc too (re-spawn `--session` + seed prompts) |
| `readScreen` ~1554 | claude branch only | rpc: `readRpcScreen` (pi branch panes display only) |
| `closeSurface` 1573/1601/1617 | tmux kill-pane | dispatched by prefix |
| `pollForExit` ~1531 | `{interval:1000, sessionFile, sentinelFile, onTick}` | identical signature; `onTick` cadence preserved (observeRunningSubagent + deliverPendingQuestion keep working) |

Claude-CLI agent branch at ~1284/1554 keeps its tmux calls directly.

## 4. `panes.ts` — in-pi dashboard

The user's preferred outcome: render panes *inside* pi, and manipulate them from within pi.

**Mounting** (works on pi ≥ 0.65, verified against 0.65 typings):

- `ctx.ui.custom(factory, { overlay: true, overlayOptions, onHandle })` with a factory that
  returns a `Component & { dispose?() }` and **never calls `done()`** → a persistent,
  non-capturing overlay. `overlayOptions` as a function returning
  `{ anchor: "top", width: "100%", maxHeight: "100%", margin: 0 }`.
- Input routing: while the overlay is not focused, `ctx.ui.onTerminalInput(handler)` still
  receives raw bytes (verified: 0.65 `types.d.ts:65`) → global toggle shortcut works even
  while the user is typing in the main editor. When the user activates a pane
  (focus mode), we call `handle.focus()` so keystrokes route to the embedded `Editor`
  component; `handle.unfocus()` exits back to pi.
- Component baseline is 0.65 pi-tui (verified exports): `Container`, `Box`, `Text`,
  `TruncatedText`, `Spacer`, `Editor`, `Input`, `matchesKey`/`Key`, `visibleWidth`,
  `truncateToWidth`, hand-rolled `HStack`-equivalent compositing (VStack/HStack are 0.84+,
  so side-by-side pane columns are composed manually by padding/concatenating rendered
  line arrays).
- Rendering is pull-based: the dashboard `Component.render(width)` reads the surface state
  map + status/activity state and composes pane cards. Invalidation is event-driven: the
  rpc event handler and the 1s poll tick call `tui.requestRender()` (16 ms coalesce built in)
  — a 250 ms render debounce in the dashboard guards tmux-children `readScreenAsync` costs.
- **resetExtensionUI hazard**: pi's `resetExtensionUI` can unmount extension overlays on
  `session_start`. The dashboard re-registers on `session_start` events if enabled.

**Layout** (pure 0.65 components):

```
┌ pi-subagents panes ──────────────── 1/3 running ─ 14:32:05 ┐
│ ▸ pi-learn-1  [running] 12s  ● read /tmp/x.md               │   ← header: name, status,
│   ┌ transcript ───────────────────────────────────────────┐ │      duration, live activity
│   │ I'll read the lesson file...                          │ │      line (from activity.ts)
│   │ ● Read /tmp/x.md → 42 lines                           │ │
│   │ Thinking about exercise 1...                          │ │
│   └───────────────────────────────────────────────────────┘ │
│ ▸ pi-learn-2  [waiting_for_user] ask_question                │
│   ...                                                        │
│ [tab] next  [shift-tab] prev  [enter] focus  [e] editor      │
│ [esc] unfocus  [ctrl+alt+p] toggle panes  [q] close         │
└──────────────────────────────────────────────────────────────┘
```

- One card per subagent entry in `runningChildren` order; scrolling when more than fit.
- Transcript lines: rpc children from the ring buffer; tmux children from
  `readScreenAsync` snapshot (tail, status lines stripped); both clipped with
  `truncateToWidth`.
- **Focus mode** (`enter`): the card's transcript is replaced by an embedded `Editor`
  ("type message; enter to send, esc to cancel"). Submitting calls the existing
  `steerSubagent` path (which sends via the backend-appropriate sender — rpc prompt or
  tmux sendCommand). This is "manipulate the panes from within pi."
- For tmux children the same editor submits through `sendCommand` — steering parity.

**Toggle**: `pi.registerShortcut("ctrl+alt+p", ...)` → `handle.setHidden(!hidden)`.
Dashboard state (open/closed, focused pane) is per-session in a module-level singleton, with
dispose cleanup on `session_start`.

## 5. Version-compat summary

| Feature | Floor | Notes |
|---|---|---|
| rpc mode | 0.65 | everything above is 0.65-baseline |
| `agent_settled` | 0.80.4 | used if present; else heuristic + nudge |
| steer delivery | 0.32 | fine |
| `tool_execution_*` events | 0.52.10 | transcript buffer uses if present |
| LF-only JSONL | 0.57 strict | client always LF-only |
| HStack/VStack | 0.84 | NOT used (hand-rolled) |

## 6. Testing plan

1. **Unit tests** — DONE, `test/rpc.test.ts` (node:test + assert/strict, matching the
   repo's existing runner; 47 tests, all green; 195 total with the pre-existing
   suite, 194 pass — the one failure exists on HEAD too). A fake RPC child
   (`test/fixtures/rpc-child.mjs`) exercises `RpcClient` over real stdio (id correlation,
   LF framing surviving U+2028, non-JSON lines, stderr routing including the exit-time
   tail flush, `__spawn_error` for unspawnable binaries, exit codes, kill/close);
   a `RecordingTransport` around a live fixture exercises the full dispatch path
   (id-echoed rejection → transcript `✗` line → queue recovery, verified against
   the freeze this workflow found); an injectable `FakeTransport` exercises the
   surface state machine (prompt correlation ids, queue serialization, steer parking,
   steer-throw-on-exit, stale-id rejection tolerance, rejected prompts, reap-nudge
   arm/skip/cancel, transcript mirroring, `pollRpcForExit` sidecar/process/abort paths);
   golden strings pin `renderTmuxCommand` byte-identity (env order, unquoted AUTO_EXIT,
   empty-env leading space, shell escaping, sentinel echo) and the `@file` expansion
   (byte-identical to pi's CLI wrapper); the backend-selection matrix covers config,
   env overrides, surface-id inheritance (`rpc:<id>`/`%N` children keep their kind),
   claude pin, and auto.
2. **Integration** (`tests/harness`): deferred to the user's real-machine run — this
   sandbox has no interactive pi. `TESTING.md` §2 is the checklist.
3. **Manual (user)**: `TESTING.md` — pi-learn md-log flow with `PI_SUBAGENT_SURFACE=rpc`,
   panes toggle/steer, resume, interrupt, stall detection, and the tmux path regression.

## 7. pi-learn consumer patch (companion, applied in the pi-learn checkout)

- `settings.json`: extension URL → `git:github.com/fsan/pi-interactive-subagents` ✓
- README: tmux optional with the fsan fork; headless install notes; fork credited ✓
- `scripts/selftest-headless.sh` (new): the same maker chain as `selftest.sh` but with
  `PI_SUBAGENT_SURFACE=rpc` and the parent driven by `pi -p` instead of tmux send-keys ✓