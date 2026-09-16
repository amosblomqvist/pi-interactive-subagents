## Context

The multiplexer seam is currently `pi-extension/subagents/tmux.ts` (354 lines), consumed by `index.ts` through a small API: `createSurface`, `sendCommand`, `sendLongCommand`, `readScreen`/`readScreenAsync`, `closeSurface`, `pollForExit`, plus `isMuxAvailable`/`muxSetupHint`. Everything tmux-specific is isolated there, but the surrounding orchestration encodes tmux assumptions: POSIX shell syntax (`cd <cwd> && …`, `KEY='value'` prefixes, `#!/bin/bash` scripts, `bash <script>` invocation), `/tmp` and `HOME` paths, `#{pane_id}`-style ids, and a 500 ms "shell ready" sleep.

Constraints that shape the approach, verified against the Herdr 0.9.0 (protocol 22) instance hosting the development session on Windows:

- Herdr has three layers — layout (`workspace`/`tab`/`pane split`), pane (raw terminal: `run`, `send-text`, `send-keys`, `read`, `wait-output`, `close`, `process-info`), and agent (recognized coding agent: `start`, `prompt`, `wait`, `get`). The CLI prints JSON; every control command spawns a process (measured 45–95 ms).
- `herdr pane run <pane> <command>…` is a CLI convenience over `send_text` + `send_keys enter`: it writes *text a shell parses*. There is no `pane.run` socket method.
- `pane.split` accepts `cwd` and an `env` map, so working directory and environment never need shell syntax.
- Errors are JSON on **stderr** with exit status 1; CLI usage errors exit 2 without JSON. Codes observed: `pane_not_found`, `agent_not_found`, `agent_pane_busy`, `agent_prompt_stalled`, `timeout`, `tab_not_found`.
- `pane read --raw` keeps ANSI escapes; `--source recent-unwrapped --format text` (no `--raw`) is the plain, unwrapped read.
- `pane wait-output --match/--regex` searches the snapshot immediately (34 ms observed) then polls server-side; `--timeout` expiry returns code `timeout`.
- The pane shell family is not knowable from the platform: `terminal.default_shell` defaults to `""` (documented as `$SHELL` then `/bin/sh`) yet new panes on this Windows host are PowerShell. `terminal.default_shell` is server-global, so it cannot be scoped to subagent panes. `pane process-info` does expose the foreground process argv on Windows, including PowerShell.
- Focus semantics: `pane current` with no arguments reports the UI-focused pane; `--current` reports the caller (`HERDR_PANE_ID`). `pane list` carries a per-pane `focused` flag.
- Herdr exposes **no exit status** for a pane process anywhere in `PaneInfo`, `AgentInfo`, or `pane process-info`.
- Agent-layer timing (observed): shell-launched pi is detected at ~1.7 s (`unknown`) and classified `idle` at ~5.07 s; `agent start --kind pi` returns `interactive_ready: true` after a consistent ~5.0 s. Prompting while the state is `unknown` returns `agent_prompt_stalled` and the input is lost; prompting once `idle` succeeds in ~1.9 s.
- Text transport is faithful: an 809-character `pane run` line and `$ " \` = ' space` all round-trip byte-exact; multi-line `send-text` is held by bracketed paste until Enter; a multi-line `agent prompt` is delivered as one turn.
- A command sent immediately after `pane split` was delivered 6/6 times, so the 500 ms readiness sleep is not needed for text delivery. `agent start` issued ~400 ms after pane creation failed with `agent_pane_busy`, so the timing hazard lives in the agent layer, not the PTY.
- `herdr status` reports client and server versions separately with protocol and endpoint compatibility; client and server can diverge.

See `proposal.md` for motivation and scope.

## Goals / Non-Goals

**Goals:**

- One deep multiplexer seam (`herdr.ts`) that `index.ts` consumes without knowing Herdr command syntax, plus one shell seam (`shell.ts`) that owns all shell-family rendering.
- Preserve every externally observable subagent behavior: non-blocking spawn, one pane per subagent, no focus stealing, steering, resumption, `.exit`/`.ask` sidecars, sentinel-based completion with exit codes, pane cleanup, session and artifact persistence.
- Correct behavior on macOS zsh, macOS bash, and Windows PowerShell panes.
- Fail with actionable, code-specific errors instead of sleeping, hanging, or silently mis-parsing.

**Non-Goals:**

- A tmux compatibility layer or build-time multiplexer abstraction. This change cuts over to Herdr.
- Reproducing tmux layout behavior (`even-horizontal`, `SUBAGENT_TMUX_LAYOUT`).
- Portable `shell`/`safe_shell` agent tools for subagents (independent product work; pi already runs bash through Git Bash on Windows).
- Replacing screen/sentinel completion with agent lifecycle state. Agent state is used for *input readiness*, never as the completion signal.
- Changing the child-side question/answer protocol, session file layout, or artifact paths.

## Decisions

### D1 — Pane layer owns lifecycle; the shell wrapper keeps exit codes

Subagent lifecycle (split, cwd/env, read, wait, close) uses the pane layer. The child is launched by one shell-rendered line that runs the launch script and then emits `__SUBAGENT_DONE_<code>__`, so clean-completion detection and exit codes keep their current semantics.

- *Alternatives*: (A) render the whole launch command per shell, including the task as a quoted argument; (C) launch with `agent start --kind pi --pane <id> -- <args>` and use agent state for completion. C is rejected because Herdr exposes no exit status, so `reason: "sentinel"` and `exitCode` would be lost, and because `agent start` adds ~5.0 s per spawn. A remains the fallback if agent-layer input delivery proves unreliable in the macOS test pass.
- *Why this way*: exit codes are part of the existing result contract (`Sub-agent "x" failed (exit code N)`) and are the only crash signal for a child that dies before writing a sidecar.

### D2 — Task and steering are delivered through the agent layer, gated on readiness

The initial task and every steering message are submitted with `herdr agent prompt <pane> <text>` (by pane id, so unnamed shell-launched pi works). Newlines are preserved; `steerSubagent` no longer flattens them. `agent_blocked` is surfaced to the orchestrator instead of being typed into a dialog, and a prompt that fails to start a turn is reported rather than assumed delivered.

- *Alternatives*: keep the task as a quoted argv (A); deliver everything with `pane send-text` + `send-keys enter`; both. `send-text` needs no agent detection and was verified for multi-line paste, but it writes text and Enter as two operations without Herdr's size-aware submit delay, so a large prompt can submit partially.
- *Why this way*: one delivery path for task and steering, no shell quoting for arbitrary user text, and blocked-dialog detection. The task is delivered **exactly once**, by one of the two transports — never both.
- *Failure handling*: fall back to `pane send-text` + `pane send-keys enter` once — logging a degraded-delivery warning — only when the failure proves the task was not delivered: gate expiry (no prompt was ever sent) or `agent_prompt_stalled` (Herdr documents the input as lost). If `agent prompt` itself fails with `timeout`, the outcome is ambiguous — the turn may have started server-side — so the system re-checks `agent get`: a started turn counts as delivered, an unchanged state fails the run with an actionable error. The task is never re-sent on an ambiguous outcome; "exactly once" is enforced, not assumed. If the fallback transport also fails, fail the run instead of leaving the subagent idle.

### D3 — Readiness gate instead of a sleep

Before any agent-layer input, the watcher waits until `herdr agent get <pane>` reports `idle` or `done`, bounded by a timeout (default 15 s). `agent_pane_busy` from any agent-layer call is retried with a short backoff. No fixed sleep precedes the launch line: sending immediately after `pane split` was verified 6/6.

- *Alternative considered and deferred*: a child-written `<session>.ready` sidecar from `subagent-done.ts` (deterministic, independent of Herdr detection). It would require a child-protocol change and still would not prove the TUI accepts input, so it does not remove the need for a state gate. Revisit only if the state gate proves flaky on macOS.

### D4 — Completion detection order: sidecar, then sentinel, then disappearance

Each watcher tick preserves the existing fast paths first (the `.exit` sidecar), then waits for the sentinel with `herdr pane wait-output <pane> --regex "__SUBAGENT_DONE_[0-9]+__" --source recent-unwrapped --lines <N> --timeout <tick>`, so sidecar and `.ask` checks still run once per interval. The regex is unbounded rather than `[0-9]{1,3}`: POSIX masks exit codes to 0–255, but Windows exit codes are 32-bit (crash codes such as 3221226505 are ten digits), and a digit-capped regex would silently never match them — the watcher would poll forever on exactly the crashes the exit code exists to signal. Reads that fail with `pane_not_found` (or an agent that reports `agent_not_found` while the pane is gone) terminate the run with a bounded, actionable error instead of polling forever.

- *Never* `--match "__SUBAGENT_DONE_"`: the echoed launch command line also contains that prefix, so a literal match returns immediately with no exit code. The digit-anchored regex is safe against that echo because the echoed script text contains the unexpanded `${code}`, never digits. `--raw` is likewise forbidden on these reads because it preserves ANSI escapes and carriage returns.

### D5 — Shell module owns family resolution, quoting, script generation, and the sentinel

The shell module is `pi-extension/subagents/shell.ts`. `ShellKind` is `"posix" | "powershell"`. Resolution precedence: `PI_SUBAGENT_SHELL` → macOS `SHELL` when it is zsh/bash → platform default (`/bin/zsh`, `/bin/bash`, `powershell.exe`). The renderer exposes `quoteArg`, `renderInvocation`, and `renderSentinel`, and writes `.sh` or `.ps1` artifacts into the existing session artifact directory.

The resolved family must match the pane Herdr actually started. It is validated, not assumed: after split, `pane process-info` foreground argv identifies the shell (`powershell.exe`/`pwsh.exe` vs `bash`/`zsh`/`sh`). A mismatch is an actionable error, not a mis-quoted command.

The PowerShell sentinel must brace the variable — `Write-Output "__SUBAGENT_DONE_${code}__"` — because `"$LASTEXITCODE__"` parses as a single identifier and silently emits no digits. The generator also handles a `$null` `$LASTEXITCODE`, but never by interpolating `$?` directly — `$?` is a PowerShell *boolean*, so `"__SUBAGENT_DONE_$?__"` would emit `__SUBAGENT_DONE_True__`, which the digit-anchored wait regex never matches. The fallback maps it to an exit code first: `$code = if ($?) { 0 } else { 1 }`.

### D6 — Availability and version are checked against the server

Availability requires `HERDR_ENV=1`, `HERDR_PANE_ID`, a reachable server, and a server that satisfies the version/protocol floor: Herdr 0.9.0 / protocol 22, the baseline this change was verified against. Raise the floor only when a newly used command or response field requires it. `herdr --version` describes only the client, so the check reads `herdr status` (client, server, protocol, endpoint compatibility). Otherwise the extension reports a setup hint such as "Start Herdr, then run pi inside a Herdr pane." and never attaches to an arbitrary focused session.

### D7 — Error contract is a typed result, not thrown strings

`runHerdr()` uses `execFile` (no `sh -c`, which fails on Windows), parses JSON from stderr on failure, and classifies: `pane_not_found`/`agent_not_found` → terminal; `agent_pane_busy` → retryable; `agent_prompt_stalled`/`timeout` → degraded or retryable depending on caller; exit 2 → internal/version bug. Cleanup (`pane close`) tolerates `pane_not_found` as success.

### D8 — Paths and platform assumptions

`tmpdir()`, `homedir()`, `basename()`, `path.join()` replace `/tmp`, `HOME`, and slash splitting — including launch scripts and integration-test output paths. `PI_SUBAGENT_SURFACE` is removed; children already receive `HERDR_PANE_ID` from Herdr itself.

### D10 — Layout is intentionally not rebalanced

`SUBAGENT_TMUX_LAYOUT` and the debounced `even-horizontal` rebalance are removed; Herdr owns layout. Repeated right splits can produce narrow columns; the design accepts the difference and only requires that multiple spawn/close cycles leave the layout usable. Herdr's own guidance (split right when the pane is wide, down when it is narrow) is noted as a possible future policy, not implemented here.

### D11 — Spawn stays non-blocking by deferring delivery

`subagent()` returns after the launch line is submitted. The readiness gate and task delivery run inside the existing watcher loop, so the tool call does not block for the ~5 s the agent layer needs before the child accepts input. The status widget keeps showing the child as starting until delivery is confirmed.

### D12 — Tests use Herdr's own oracles

Integration tests create a scratch tab (or workspace) per run, assert focus with `pane list`'s `focused` flag, wait with `pane wait-output` instead of sleeps, gate prompts on state, and close panes unconditionally in cleanup. Surface tests skip when `HERDR_ENV` is absent, so the suite also runs against a headless server started manually.

## Risks / Trade-offs

- [Herdr agent detection unavailable or late, so the task is never delivered] → Gate is bounded; on expiry, degrade once to `send-text` + `send-keys enter`, then fail the run with a clear error. Never rely on agent state for completion.
- [~5 s between spawn and task delivery looks like a stall] → Delivery happens in the watcher, spawn returns immediately, and the widget/status keeps the child visibly "launching"; the gate is logged when it exceeds a threshold.
- [`agent_pane_busy` timing window (~400 ms after pane creation)] → Retry only that code with short backoff; never sleep-then-send.
- [Large prompt partially submitted on the degraded `send-text` path] → `agent prompt` is the primary transport because Herdr tunes the submit delay by prompt size; the fallback is bounded and reported as degraded.
- [Shell-family mismatch between our renderer and the pane] → Probe `pane process-info` after split and fail with an actionable error before rendering a command.
- [PowerShell sentinel loses its code] → Braced `${code}` interpolation plus `$?` fallback; unit-test the generated script text and cover exit 0 and non-zero.
- [Server older than the client lacks a command] → Server version/protocol floor from `herdr status`, actionable upgrade message, and an error-code table pinned by tests.
- [Layout crowding with many right splits] → Accepted non-parity; documented; optional future dimension-aware direction choice.
- [Orchestrator dies between spawn and task delivery, stranding an idle subagent pane] → With tmux the task was baked into the launch command; under D2 it lives in orchestrator memory during the gate window. Accepted for this change; the mitigation (persisting the pending task into the run's artifact directory at spawn) is deferred — see Open Questions.
- [macOS paths (zsh/bash, `SHELL`, `/tmp` removal) cannot be verified on the development machine] → Shell unit tests plus a required manual verification pass on macOS zsh and bash.

## Migration Plan

1. Land the shell module and the Herdr adapter behind the existing seam, with unit tests for quoting, script generation, sentinel emission, id→validation, and error classification.
2. Cut `index.ts` over: availability, launch, task/steer delivery, resume, polling, cleanup. Delete `tmux.ts`, `PI_SUBAGENT_SURFACE`, and the layout constants.
3. Rewrite the integration harness and surface tests; update README/package description and remove tmux setup instructions.
4. Verify manually on Windows PowerShell, then macOS zsh, then macOS bash (spawn, non-zero exit, `ask_question`, resume, long prompt, pane close mid-run).
5. Rollback is a revert: there is no data migration, and session files, artifacts, and `.exit`/`.ask` paths are unchanged. Users on tmux would need the previous release.

## Open Questions

- Whether the `send-text` degraded path should be attempted at all for prompts above a size threshold, or whether the run should fail faster. Deferrable; the spec requires only that exactly one transport is used and that a degraded delivery is reported.
- Whether a future Herdr layout policy (dimension-aware split direction, or `pane resize`) is worth adopting. Deferrable; layout is explicitly non-parity in this change.
- Whether the child-side `<session>.ready` sidecar (D3 alternative) is worth adding if the state gate proves slow or flaky on macOS.
- Whether to persist the composed task into the run's artifact directory at spawn, so an orchestrator crash during the readiness gate cannot strand an idle pane (also aids debugging). Deferrable; the risk is documented in Risks / Trade-offs.
