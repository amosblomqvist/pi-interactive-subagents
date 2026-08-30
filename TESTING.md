# Testing the RPC surface + panes dashboard

This fork adds two things on top of the tmux-only upstream: a **headless RPC
backend** (`pi --mode rpc` children, no multiplexer) and an **in-pi panes
dashboard** (`ctrl+alt+p`). Everything below tmux-only must keep working
byte-identically.

What is verified here (sandbox, no interactive pi) vs. what needs a real
machine is called out explicitly.

## 1. Unit tests (no pi needed)

```bash
npm test          # node --test test/test.ts test/rpc.test.ts
```

`test/rpc.test.ts` (new, 47 tests) covers:

- `RpcClient` against a fake RPC child (`test/fixtures/rpc-child.mjs`): id
  correlation, LF-only framing surviving U+2028 inside JSON payloads, non-JSON
  stdout lines ignored, stderr → synthetic `__stderr` events **including the
  trailing fragment flushed on child exit**, `__spawn_error` when the pi binary
  cannot be started (the event names the binary and errno), exit-code
  observation, process-group kill on close.
- Integration tests run a **real** child through the real dispatch path
  (`RecordingTransport` wraps a live fixture): an id-echoed prompt rejection
  reaches the transcript as a `✗` line, frees the queue, and the next prompt
  plus a later steer still go out — the exact path that froze before prompts
  carried correlation ids.
- The surface state machine via an injected `FakeTransport`: prompt queue
  serialization (one run at a time), prompts carry distinct correlation ids,
  steer parking behind the active run, **steer throws once the child has
  exited or the surface is unknown** (callers report the failure instead of
  silently dropping the message), rejected-prompt recovery (matched by id;
  stale-id rejections ignored), the reap-nudge (armed after a final-looking
  `agent_end`, skipped on `agent_settled`, cancelled by a new run, skipped
  while prompts are queued), transcript mirroring + caps.
- `pollRpcForExit`: `.exit` sidecar (with error message + sidecar consumed),
  clean exit → done, crash → error with/without `lastError`, unknown surface →
  done, abort.
- Backend selection: config parsing, env overrides (including surface-id
  inheritance — a child spawned as `rpc:<id>` keeps its children headless, a
  pane child `%N` keeps opening panes), claude→tmux pin, auto.
- `buildRpcArgv` / `buildRpcPrompts` ordering, identity file writing, and the
  `@file` expansion — byte-identical to pi's own CLI expansion
  (`<file name="<abs>">…</file>`) so headless children see the same task
  bytes as pane children.
- `renderTmuxCommand` **golden strings** — these pin the tmux path byte-for-
  byte against the pre-refactor construction (env insertion order, the
  unquoted `PI_SUBAGENT_AUTO_EXIT=1` quirk, the leading space with empty env,
  shell escaping, the `cd` prefix, the sentinel echo).

Runner notes:

- Tests are TypeScript. Node ≥ 23.6 runs them natively; on Node 22 use
  jiti: `node --import ./node_modules/@mariozechner/jiti/lib/jiti-register.mjs --test test/test.ts test/rpc.test.ts`.
- `test/test.ts` line "getToolExtensionPath maps custom tools and skips
  built-ins" fails **on upstream HEAD too** in environments without
  `~/.pi/agent/extensions/web-search/` on disk — pre-existing, not from this
  fork.

Status in this sandbox: **195 tests, 194 pass** (the one failure is the
pre-existing one above; the baseline HEAD suite gives the identical result).
Strict `tsc` compared message-by-message against HEAD: the only new
complaints are `.ts`-import notices (TS5097 — every import in this codebase
uses the `.ts` extension, including HEAD's own) from the new modules, plus
one instance of HEAD's own `params.name: string | undefined` noise in the
new env-building code; two of HEAD's strict errors disappear (the loadout
refactor types those sites). No new error classes; `panes.ts` typechecks
clean under `--strict`.

## 2. Real-machine checklist (interactive pi required)

The sandbox cannot run interactive pi — these need a real terminal.

### 2a. tmux regression (highest priority)

```bash
tmux new -A -s pi 'pi'
```

- `/subagent <agent> <task>` → child appears in a pane, widget tracks it,
  result steers back. Diff a `<name>-<id>.sh` launch artifact against one
  produced by upstream — they must be **byte-identical** for the same
  loadout.
- Everything else as before: `/subagent` command, `subagent_message`,
  `ask_question` relay, resume-on-message after completion, interrupt/abort.

### 2b. Headless backend

```bash
pi                          # no tmux, no server
```

- `/subagent <agent> <task>` → child runs headless; a `<name>-<id>.rpc.json`
  artifact appears next to the session file (argv/env/cwd/prompts).
- Result steers back into the parent on completion, same notification flow.
- Force modes to compare: `PI_SUBAGENT_SURFACE=rpc` inside tmux, and
  `PI_SUBAGENT_SURFACE=tmux` outside a server (should fail with the standard
  mux hint, not a crash).

### 2c. Panes dashboard

- `ctrl+alt+p` toggles the overlay on both backends; while visible but
  unfocused, **every** keystroke must keep reaching pi's editor.
- Focused: `tab`/`shift+tab` navigate, `enter` opens the composer, `escape`
  cancels the composer (before the editor sees it), `q` hides, `escape`
  releases the keyboard back to pi while leaving the dashboard visible.
- Composer submit steers the selected sub-agent — verify the message lands
  (the child widget should react). Steering a sub-agent that already exited
  must **not** silently close the composer: it stays open with the text
  intact and the footer shows `✗ <reason>`.
- After `/reload` and across a new session (`/exit`, restart), no stale
  overlay, no double overlay, toggle still works.

### 2d. pi version matrix

| pi version | headless spawn | auto-exit child |
| --- | --- | --- |
| ≥ 0.80.4 (current) | expected clean | exits on its own (`agent_settled`) |
| 0.65 – < 0.80.4 | expected clean | exits ~2s late (reap-nudge) |

The nudge is observable: after the final-looking `agent_end` the parent sends
a `get_last_assistant_text` command ~2s later; the child then exits. On
≥ 0.80.4 no nudge is sent.

### 2e. pi-learn end-to-end

With the [fsan/pi-learn](https://github.com/fsan/pi-learn) checkout patched to
this fork:

```bash
bash .pi/scripts/selftest.sh             # tmux path, unchanged
bash .pi/scripts/selftest-headless.sh    # new: no tmux, PI_SUBAGENT_SURFACE=rpc
```

Then a real lesson: `/mdlog notes/<topic>.md` → "i want to learn about X" →
researcher/maker subagents spawn headless, quizzes render into the log.

## 3. Debug levers

| Lever | Effect |
| --- | --- |
| `PI_SUBAGENT_SURFACE=rpc\|tmux\|auto` | force the backend for one run |
| `PI_SUBAGENT_PANES=0\|1` | force the dashboard off/on |
| `config.json` → `surface.backend` | persistent backend choice |
| `<session>.rpc.json` / `<name>-<id>.sh` | launch artifacts: exactly what was spawned |
| `PI_SUBAGENT_BIN="node /path/to/pi.js"` | point children at a dev pi build |

Headless child stderr is captured into the dashboard transcript (`__stderr`
lines) — panes with `✗` lines or a stuck `running` status should show the
reason there.