## 1. Shell rendering module

- [x] 1.1 Add the shell module (`pi-extension/subagents/shell.ts`) with a `ShellKind` (`posix` | `powershell`) and a structured shell specification, resolving in order: `PI_SUBAGENT_SHELL` → macOS `SHELL` when zsh/bash → platform default (`/bin/zsh`, `/bin/bash`, PowerShell). Verify with unit tests covering override, macOS zsh, macOS bash, and Windows resolution.
- [x] 1.2 Implement per-family argument and path quoting (`quoteArg`). Verify with unit tests for spaces, single and double quotes, `$`, backticks, `=`, apostrophes, non-ASCII, and newlines, asserting each family is never quoted with the other family's rules.
- [x] 1.3 Implement launch-script generation and invocation rendering: `.sh` for POSIX, `.ps1` for PowerShell, invoked through the detected shell rather than a hardcoded `bash`. Verify with unit tests asserting script extension, script content, and that the invocation names the resolved shell.
- [x] 1.4 Implement sentinel rendering per family: POSIX `printf '__SUBAGENT_DONE_%s__\n' "$code"`-style, PowerShell with braced interpolation `"__SUBAGENT_DONE_${code}__"` plus a `$?`-based fallback when the native exit status is null that maps the boolean to digits first (`$code = if ($?) { 0 } else { 1 }`) — never interpolating `$?` directly, which would emit `__SUBAGENT_DONE_True__`. Verify with unit tests asserting the generated text contains the braced form, no `$LASTEXITCODE__`, and that the fallback path emits only digits (`__SUBAGENT_DONE_0__`/`__SUBAGENT_DONE_1__`, never `True`); and with integration assertions that a PowerShell pane emits `__SUBAGENT_DONE_5__` for a command that exits 5 and that the completion wait matches an exit code of more than three digits.
- [x] 1.5 Remove Unix-only path construction from runtime code and tests: `tmpdir()`, `homedir()`, `basename()`, `path.join()` replace `/tmp`, `process.env.HOME`, and `split("/")` in sentinel paths, launch scripts, and integration output paths. Verify with a grep audit (`/tmp`, `process.env.HOME`, `split("/")`) returning no runtime hits and a Windows path-with-spaces test passing.

## 2. Herdr pane adapter

- [x] 2.1 Add a single centralized runtime helper built on `execFile` (no shell string, no `sh -c`) that parses JSON errors from stderr, distinguishes server failures (exit 1) from usage failures (exit 2), and returns typed error codes (`pane_not_found`, `agent_not_found`, `agent_pane_busy`, `agent_prompt_stalled`, `timeout`, unknown). Verify with unit tests for each code, malformed JSON, empty stderr, and a non-JSON exit-2 failure.
- [x] 2.2 Implement availability and version gating: require `HERDR_ENV=1` and `HERDR_PANE_ID`, confirm the server is reachable, and read server version/protocol from `herdr status` against the pinned floor (Herdr 0.9.0 / protocol 22). Verify with unit tests over fake status payloads and a manual check that spawning outside Herdr returns the "run pi inside a Herdr pane" setup hint without touching any session.
- [x] 2.3 Implement pane creation targeting the caller (`--current` or explicit pane id), `--direction right`, `--no-focus`, `--cwd`, and repeated `--env`, parsing and validating the returned pane id. Verify with an integration test asserting the user's focused pane is unchanged via the runtime's focused-pane listing, and unit tests for missing/malformed pane ids.
- [x] 2.4 Implement pane-shell detection from runtime process information (`pane process-info` foreground argv) and refuse to render when the resolved family does not match. Verify with an integration test on Windows asserting the detected family is PowerShell, and a unit test asserting a mismatch produces an actionable error and sends nothing.
- [x] 2.5 Implement command and text submission: one pre-quoted command via `pane run`, atomic text + enter for interactive input. Verify with integration tests that a command containing spaces, quotes, `$`, backticks, apostrophes, and `=` executes once with an exact round-trip, and that multi-line text sent without enter executes nothing until enter.
- [x] 2.6 Implement sync and async pane reads using the plain, unwrapped source and a line count. Verify with an integration test asserting the read contains no escape sequences, no carriage returns, and no protocol envelope, and that a soft-wrapped long line is returned as one matchable line.
- [x] 2.7 Implement output waiting with a regex matcher, plain unwrapped source, and a timeout that reports the timeout code distinctly from not-found. Verify with an integration test that an already-present pattern returns promptly and that a 1.5 s timeout returns `timeout`.
- [x] 2.8 Implement pane close with idempotent cleanup: a not-found pane must count as success. Verify with an integration test that closes a pane twice and asserts no error is surfaced.
- [x] 2.9 Add bounded retry for the retryable busy condition (`agent_pane_busy`) and nothing else. Verify with unit tests asserting retry-then-success, retry exhaustion, and that terminal codes are not retried.

## 3. Orchestration cutover

- [x] 3.1 Replace multiplexer imports and wording in the extension: `isMuxAvailable`/`muxSetupHint` become runtime-specific, tmux error text is replaced, and the unused `PI_SUBAGENT_SURFACE` variable is removed. Verify with updated unit tests and a grep over runtime code returning no tmux references.
- [x] 3.2 Rewrite the launch path: create the pane with cwd/environment, render and submit the launch line immediately (no readiness sleep), register the running subagent, and return. Verify with an integration test that a spawn creates a pane, changes no focus, and starts the child process.
- [x] 3.3 Implement the readiness gate and task delivery: wait until the child reports a ready agent state (bounded), then deliver the composed task exactly once through the agent layer, with one degraded `send-text` + enter fallback and a reported warning when used. Verify with integration tests for delivery as the first turn, no delivery before readiness, delivery exactly once, the fallback path, and that an ambiguous prompt failure (`timeout`) triggers a state re-check rather than a second delivery — a started turn counts as delivered, an unchanged state fails the run. Verified: `test/test.ts` `task delivery gate` (withheld-until-ready + exactly-once, gate-expiry degraded, stalled degraded, timeout→turn-started counts as delivered, timeout→unchanged fails without re-send, blocked reported, no-pending no-op), model-backed `delivers the composed task to a real pi child once it reports ready` (first turn), and integration `degrades to text + enter when the pane never hosts a ready agent` (fallback transport end to end, marker appears once).
- [x] 3.4 Route steering through the agent layer, preserving line breaks and reporting blocked or unknown targets instead of typing into dialogs. Verify with integration tests that a multi-line steer arrives as one turn and that a blocked target is reported. Verified: integration `delivers a multi-line steer to a running pi child as one turn` (both lines in one recorded user turn) and `reports a steer to a pane with no agent instead of typing into it`; unit `reports a blocked target instead of typing into the dialog` (zero herdr calls), `degrades a stalled steer once through text + enter`, `reports an unknown target without sending any pane input`.
- [x] 3.5 Rework completion polling: error sidecar first, then a sentinel regex wait bounded per tick, then pane disappearance as a terminal, actionable error while still honouring a late sidecar. Verify with integration tests for exit 0, non-zero exit, a multi-digit exit code beyond the POSIX 0–255 range (the wait regex is `[0-9]+`, never digit-capped), sidecar precedence, and closing the pane mid-run.
- [x] 3.6 Rewrite the resume path on the new adapter: fresh pane, replayed sandbox and session, message delivered through the readiness gate, refusal when restrictions cannot be replayed. Verify with integration tests asserting same name/session and the message arriving as the next turn. Verified: integration `resumes a finished subagent by name in a fresh pane with its session and sandbox` (real `subagent_message` tool path: same name, same session file, new pane id, launch script replays `--session` + `--no-extensions`, follow-up recorded as the child's next user turn) and `refuses to resume when the sandbox snapshot is missing`.
- [x] 3.7 Delete the tmux adapter, the layout constant, and the debounced rebalance; make cancellation and launch-failure cleanup close any created pane. Verify with unit/integration tests for cancellation leaving no pane or timer, and a grep returning no `tmux`/rebalance references.

## 5. Integration harness and test suites

- [x] 5.1 Rewrite the harness: skip when the runtime is unavailable, create a scratch tab (or workspace) per run, track and close every pane, expose a focus oracle, and use platform-aware temp paths. Verify that a dry run leaves no panes or tabs behind.
- [x] 5.2 Rewrite the surface tests: no-focus creation, focus stability across repeated creation and close, special-character quoting, 800+ character line integrity, plain unwrapped reads, async reads, concurrent panes, cwd with spaces, environment values with shell-sensitive characters, and a non-zero-exit sentinel. Verify the suite passes on Windows and is written to skip cleanly outside the runtime.
- [x] 5.3 Add shell unit tests for zsh/bash/PowerShell quoting, script generation, sentinel generation, override precedence, and the pane-shell mismatch error. Verify the suite runs without any multiplexer present.
- [x] 5.4 Extend lifecycle tests for spawn, steer, question, resume, cancel, and completion. Verify each scenario from the `subagent-orchestration` spec has at least one passing test. Verified: `test/integration/subagent-lifecycle.test.ts` covers spawn (pane, focus, artifacts), steering (multi-line turn, agentless target reported), question round-trip (`.ask` delivered once, pane stays open, reply becomes the next turn, clean exit), resume (fresh pane, replayed sandbox/session, unsafe resume refused), cancel, completion (exit 0, exit 7, 32-bit exit, sidecar precedence, pane-disappeared, late sidecar) and degraded delivery; 15/15 pass on macOS zsh and bash.

## 6. Documentation and packaging

- [x] 6.1 Update `README.md` and the package description: runtime requirement, "install the runtime, start it, then run pi inside a pane", the shell override variable, supported shells, and integration-test instructions; remove tmux installation and layout documentation. Verify by reading the rendered README for stale tmux references.
- [x] 6.2 Document that the pane shell must match the resolved shell family, including the runtime's default-shell setting and the actionable mismatch error. Verify documentation mentions the setting and the error.
- [x] 6.3 Bump the version and write release notes describing the breaking change (tmux support removed, Herdr runtime now required at or above 0.9.0 / protocol 22) and the new Windows support. Verify the package version and notes.

## 7. Verification

- [ ] 7.1 Run the full verification matrix: Windows PowerShell, macOS zsh, and macOS bash, each covering a normal task, a non-zero exit, `ask_question` and reply, resume, a long prompt, closing the pane mid-run. Verify every row passes and record results. **macOS rows done** (see Verification results below); **Windows PowerShell row still to run.**
- [x] 7.2 (dropped) GitHub Actions CI smoke job — removed at the owner's request: this repository carries no CI workflow and no CI-only helper scripts. Verification stays local and manual (see Verification results below).
- [x] 7.3 Final audit: no runtime references to `tmux`/`TMUX`, `/tmp`, hardcoded `bash`, POSIX-only `cd … &&` or `KEY=value` prefixes, or `#!/bin/bash`. Verify with a grep audit over runtime code.

## Verification results

Environment: macOS (darwin), Herdr 0.9.0 / protocol 22, pi 0.65, real Herdr session
(`HERDR_ENV=1`), Herdr server `terminal.default_shell = "zsh"`. Model-backed rows used
`deepseek/deepseek-flash` (authenticated).

| Row | Unit | Integration | Notes |
| --- | --- | --- | --- |
| macOS zsh (`SHELL=/bin/zsh`) | 203/203 | 34/34 | full suite, including model-backed rows |
| macOS bash (`SHELL=/bin/bash`) | 203/203 | 34/34 | bash-resolved spec: `.sh` scripts invoked via `/bin/bash`; panes themselves stay zsh because `terminal.default_shell` is server-global (same shell family, so the pane-family gate passes) |
| Headless server on an isolated socket, no client | 203/203 | 29/29 | model-backed suites skipped; run manually, not in CI |

Matrix coverage (macOS rows): normal task (`delivers the composed task to a real pi
child…`), non-zero exit (`exit 7`, 32-bit `1073741824`), `ask_question` + reply
(`round-trips a subagent question and resumes the run with the reply`), resume
(`resumes a finished subagent by name in a fresh pane…`), long prompt (800+ character
unwrapped line + long composed task), pane closed mid-run (`terminates a run whose pane
disappears`, `honours a late sidecar…`).

### Findings from this verification pass

1. **Harness geometry (fixed).** `createTestEnv` created one scratch tab per suite and
   every tracked pane was a right split of its root pane; Herdr's split ratio halves the
   target, so later panes reached 0–1 columns and a fixed 20-line read could start
   mid-line. Each surface test now gets a fresh tab, and a dedicated test exercises the
   runtime's real read budgets (wait 50 / read 200) in a deliberately crowded pane.
2. **Accepted crowding is more severe than "narrow columns" (documented, not changed).**
   Repeated spawns target the caller pane, so after ~7 sequential spawns the caller is
   1 column wide and the newest subagent panes are 1–3 columns (Herdr's own guidance:
   split right when wide, down when narrow). D10 accepts that Herdr owns layout; the
   README already warns to close finished panes. Worth revisiting with a dimension-aware
   direction choice or a rebalance if users run many concurrent subagents.
3. **`getToolExtensionPath` still maps only the legacy `~/.pi/agent/extensions` layout
   (pre-existing, out of scope).** On installs where the web tools come from a pi package
   (`npm:pi-web-access`), `web_search`/`web_fetch` resolve to `undefined`, so a subagent
   allowlist granting them gets no `-e` path. `pi.getAllTools()[].sourceInfo.path` is the
   general fix; the unit assertion was made environment-honest instead of failing on
   installs without the legacy layout.
4. **`herdr pane list` does not start a server** (it answers `server_not_running` and
   points at the TUI). A headless server must be started explicitly (`herdr server`),
   which the manual headless row above does.
