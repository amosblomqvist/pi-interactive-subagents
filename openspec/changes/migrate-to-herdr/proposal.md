## Why

The extension can only run inside tmux, so it is unusable on Windows and forces a POSIX shell. Herdr is a terminal multiplexer that runs natively on Windows (ConPTY), exposes a JSON CLI with structured pane and agent primitives, and is already the environment this project is developed and used in. Moving the multiplexer seam from tmux to Herdr removes the tmux requirement and makes Windows PowerShell a first-class target while preserving the existing subagent behavior contract.

## What Changes

- Remove the tmux implementation (`pi-extension/subagents/tmux.ts`) and its setup requirement; Herdr becomes the only supported multiplexer. **BREAKING**: the extension now requires running pi inside a Herdr pane (`HERDR_ENV=1`) with a Herdr server at or above the pinned floor (0.9.0 / protocol 22); older servers are refused with an actionable upgrade message.
- Add a Herdr pane adapter behind the existing deep seam: create/split without focus change, submit, read, wait for output, and close — all through one centralized `runHerdr()` helper that uses `execFile`, parses JSON from stderr, normalizes error codes (`pane_not_found`, `agent_not_found`, `agent_pane_busy`, `agent_prompt_stalled`, `timeout`), and retries on `agent_pane_busy`. Completion polling stays in the orchestration layer, on top of the adapter's wait primitive.
- Pass child cwd and environment to the pane at creation (`--cwd`, repeated `--env`) instead of emitting `cd`/`KEY=value` prefixes into the shell.
- Make launch-command construction shell-aware: one renderer per shell family (POSIX zsh/bash, Windows PowerShell), generating a `.sh` or `.ps1` launch script and emitting the completion sentinel with shell-correct status interpolation (braced `${code}` for PowerShell, `printf` for POSIX shells).
- Deliver the initial task and all steering messages through Herdr's agent layer (`agent prompt`) once the child reaches a known agent state, replacing long-command script artifacts, `@file` resume messages, and the newline-flattening workaround. Keep the shell-rendered launch line for process launch so shell exit codes remain the completion signal.
- Replace Unix-only paths (`/tmp`, `HOME`, slash splitting) with `tmpdir()`, `homedir()`, `basename()`, and `path.join()`.
- Replace the configurable shell-readiness sleep with an observed readiness gate before any agent-layer input.
- Out of scope: portable `shell`/`safe_shell` agent tools. pi already runs bash through Git Bash on Windows, so those tools are independent product work, not multiplexer portability.

## Capabilities

### New Capabilities

- `subagent-orchestration`: spawning, steering, resuming, completing, and cleaning up interactive subagents; task delivery after a readiness gate; `.exit`/`.ask` sidecars, session and artifact persistence, and cancelled-run cleanup.
- `pane-runtime-adapter`: the Herdr seam — runtime detection, explicit pane targeting, no-focus pane creation with cwd/env, screen reads, output waits, pane close, and normalized error handling across macOS and Windows.
- `shell-command-rendering`: resolving the pane's shell family, quoting arguments, generating `.sh`/`.ps1` launch scripts, and emitting the completion sentinel so exit codes survive on every supported shell.

### Modified Capabilities

- None. The repository has no existing specs; the tmux-era behavior is captured as these new capabilities.

## Impact

- **Removed**: `pi-extension/subagents/tmux.ts`, tmux availability checks and setup hints, `SUBAGENT_TMUX_LAYOUT`/layout rebalance, `PI_SUBAGENT_SURFACE`, `pi-extension/subagents/plugin/` (the Claude Code plugin: hook manifest and stop hook), and Claude Code CLI subagent support (the `cli` frontmatter field).
- **Added**: `pi-extension/subagents/herdr.ts`, `pi-extension/subagents/shell.ts`.
- **Modified**: `pi-extension/subagents/index.ts` (launch, steer, resume, poll, cleanup paths), `pi-extension/subagents/status.ts` (Claude status source removed), `agents/worker.md`/`agents/researcher.md`/`agents/scout.md` (only if tool names change — not required for this change), `README.md`, `package.json` description, integration tests and harness.
- **Dependencies**: requires a Herdr server, at or above the pinned floor (0.9.0 / protocol 22), that provides `pane split` with `--cwd`/`--env`, `pane run`, `pane read --source recent-unwrapped`, `pane wait-output`, `pane close`, `pane process-info`, `pane send-text`/`pane send-keys` (degraded-delivery fallback), `agent prompt`, `agent get` (readiness gate), and `herdr status` (server version/protocol check); verified on Windows, to be verified on macOS zsh/bash.
- **Behavioral guarantees preserved**: non-blocking spawn, one pane per subagent, no focus stealing, steering of running subagents, completion sentinels plus `.exit`/`.ask` sidecars, pane cleanup, and session/artifact persistence.
- **Intentional non-parity**: tmux's debounced `even-horizontal` layout rebalance is removed; Herdr owns layout. One behavioral difference is also accepted: an orchestrator crash during the task-delivery gate can strand an idle subagent pane (with tmux the task was baked into the launch line and survived); documented as a risk in the design.
