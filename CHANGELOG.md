# Changelog

## 4.0.0 — Herdr runtime, Windows support

**BREAKING: tmux support is removed.** The extension now requires running pi inside a
[Herdr](https://herdr.dev) pane (`HERDR_ENV=1`) with a Herdr server at or above the pinned floor
(Herdr 0.9.0 / protocol 22). Older servers are refused with an upgrade message naming the required
protocol. Users who need tmux should stay on the 3.x line.

- **New runtime seam.** Pane lifecycle (create/split without focus change, cwd and environment at
  creation, plain unwrapped reads, regex output waits, idempotent close, process-info) goes through
  a single Herdr adapter; completion polling stays in the orchestration layer on top of its wait
  primitive. Structured JSON errors are normalized into typed codes
  (`pane_not_found`, `tab_not_found`, `agent_not_found`, `agent_pane_busy`, `agent_prompt_stalled`,
  `agent_blocked`, `timeout`) and only the busy condition is retried.
- **Windows is a first-class target.** Launch commands are rendered per shell family — `.sh` scripts
  invoked through zsh/bash, `.ps1` scripts invoked through PowerShell — with family-correct quoting
  and a sentinel that carries the exact exit status (including 32-bit Windows crash codes). The
  pane's shell is validated against the rendered family before anything is typed, with an actionable
  mismatch error.
- **Task and steering delivery move to the agent layer.** The composed task is delivered through
  `agent prompt` once the child reports a ready state (bounded gate, exactly one transport, one
  reported degraded fallback); steering preserves line breaks and reports a blocked sub-agent
  instead of typing into its dialog. The launch line still runs through the shell so exit codes
  remain the completion signal.
- **No fixed shell-readiness sleep.** Delivery is gated on the child's observed agent state.
- **Portable paths.** `/tmp`, `HOME`, and slash splitting are replaced by `tmpdir()`, `homedir()`,
  `basename()`, and `path.join()`.
- **Herdr owns pane layout.** The `even-horizontal` rebalance and `SUBAGENT_TMUX_LAYOUT` are gone.
- **Removed:** the tmux adapter, tmux availability checks and setup hints, `PI_SUBAGENT_SURFACE`,
  the `PI_SUBAGENT_SHELL_READY_DELAY_MS` delay, the `cli` frontmatter field, and Claude Code CLI
  subagent support (including the bundled Claude Code plugin and its stop hook).
- **Tests.** Unit suite runs without any multiplexer; the integration suites create a scratch,
  non-focused Herdr tab per run and leave no panes or tabs behind.
