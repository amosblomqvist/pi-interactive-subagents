# Plan: migrate the extension from tmux to Herdr

> **Status:** original migration review, kept for provenance. It was verified live against
> Herdr 0.9.0 (protocol 22, Windows) and captured as the OpenSpec change
> `openspec/changes/migrate-to-herdr/`. That change's `design.md` is the implementation source
> of truth; its spec deltas supersede the parity-matrix rows touched by the notes below.
>
> What verification changed:
>
> - **Launch architecture:** the change keeps this plan's pane-layer lifecycle and the
>   shell-rendered launch line (sentinel -> exit codes), but delivers the task and steering
>   through `agent prompt` once the child reports a ready agent state. Section 2's
>   long-command artifacts, `@file` resume message, and task argv quoting are dropped;
>   `pane run` remains a text-into-shell write.
> - **Readiness (review item 8):** text sent immediately after `pane split` arrived 6/6, so no
>   fixed delay is needed. The timing hazard is `agent_pane_busy` in the agent layer, handled
>   by a readiness gate before any agent-layer input.
> - **Reads (section 1, Screen capture):** `--raw` keeps ANSI escapes and carriage returns;
>   sentinel reads use `recent-unwrapped` plus plain text, and sentinel waits use a
>   digit-anchored regex.
> - **Version floor (review item 6):** read the server's version and protocol from
>   `herdr status`, not the client's `--version`.
> - **Section 4 is out of scope:** pi already runs bash through Git Bash on Windows.
> - **Tests (sections 6 and 8):** focus is asserted from `pane list`'s `focused` flag;
>   this machine cannot run the current suite until the harness is rewritten.

## Scope and decisions

- Remove the tmux implementation; no tmux compatibility layer is required.
- Use Herdr as the only terminal multiplexer.
- Support:
  - Windows PowerShell
  - macOS `zsh`
  - macOS `bash`
- Preserve the existing subagent behavior:
  - non-blocking launches
  - one pane per subagent
  - no focus stealing
  - steering running subagents
  - completion sentinels and `.exit`/`.ask` sidecars
  - pane cleanup
  - session/artifact persistence
- Use Herdr’s CLI first rather than its raw socket API. This avoids Unix-socket versus Windows named-pipe differences and follows Herdr’s automation guidance.

Relevant Herdr operations are:

- `herdr pane split ... --no-focus`
- `herdr pane run <pane> <command>`
- `herdr pane send-text`
- `herdr pane send-keys ... enter`
- `herdr pane read ... --source recent-unwrapped`
- `herdr pane close`
- `herdr pane current` for UI-focus inspection in integration tests
- `HERDR_PANE_ID` for stable parent-pane targeting

References:

- [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Herdr Windows support](https://herdr.dev/docs/windows-beta/)
- [Herdr configuration](https://herdr.dev/docs/config-reference/)

## Plan review

The migration is feasible and the plan covers the major portability work, but the following corrections are required before implementation:

1. **Separate terminal input from shell execution.** The current `sendCommand` name hides two different behaviors: submitting a message to the pi TUI and executing a shell command. Expose distinct `submitText` and `runCommand` operations even if both initially use `herdr pane run` internally.
2. **Make split-direction parity explicit.** tmux currently supports left, right, up, and down. Herdr natively splits only right or down. Production spawning only needs a right split, so remove left/up from the production interface unless a real caller requires emulation.
3. **Do not use `pane current --current` to prove focus.** Inside a Herdr pane, `--current` resolves from `HERDR_PANE_ID`; it identifies the caller, not necessarily the UI-focused pane. Use `HERDR_PANE_ID` for parent targeting and verify the no-argument `herdr pane current` contract for focus assertions.
4. **Define a pane-shell invariant.** A `.ps1` invocation cannot be sent to a zsh pane and a POSIX invocation cannot be sent to PowerShell. `PI_SUBAGENT_SHELL`, the generated script type, and Herdr's `terminal.default_shell` must resolve to the same shell family. Detect or validate this instead of silently inferring it only from the OS.
5. **Centralize Herdr CLI execution.** Add one internal `runHerdr(args)` helper that calls `execFile`, checks exit status, parses documented JSON responses, normalizes errors, and validates pane IDs. Do not use `sh -c` for command discovery because it fails on Windows.
6. **Establish a minimum Herdr version.** Verify the exact release that provides the required `pane split`, `pane run`, `pane read --raw`, `--cwd`, `--env`, and `--no-focus` behavior, then fail with an actionable upgrade message on older versions.
   > **Refined:** client and server versions can diverge (0.9.0 keeps compatible servers running and disables only the affected action when a server feature is missing), so the floor is read from the server via `herdr status` (client, server, protocol, endpoint compatibility) rather than `herdr --version`. `--raw` is not part of the required read path; see the Screen capture note.
7. **Build cwd and environment before splitting.** Herdr applies `--cwd` and `--env` when the pane process is created, so launch and resume paths must finish constructing their environment before calling `createSurface`.
8. **Preserve shell-readiness behavior.** The current configurable startup delay prevents input from being dropped. Keep it for the first migration or replace it with a tested readiness handshake; do not remove it implicitly.
   > **Verified 2026-09-15:** a command sent immediately after `pane split` was delivered 6/6 times, so no delay is needed for text delivery. `agent start` issued about 400 ms after pane creation failed with `agent_pane_busy`, and prompting while the agent state was still `unknown` returned `agent_prompt_stalled` with the input lost. Readiness is therefore an observed state: wait for `idle` or `done` before agent-layer input, and retry only the retryable busy code.
9. **Record layout as intentional non-parity.** Removing tmux's debounced `even-horizontal` rebalance changes visible behavior. Treat that as an approved product difference and test only that Herdr maintains a usable layout.
10. **Define disappeared-pane behavior.** If a Herdr pane vanishes before a sentinel or sidecar appears, polling must terminate with a useful error rather than loop forever.
11. **Validate the Claude hook launcher on both shell families.** Rewriting the hook in Node removes Bash/Python dependencies, but the `hooks.json` command that launches Node must itself be proven portable on PowerShell and POSIX shells.
12. **Treat portable agent shell tools as adjacent portability work.** They are necessary for full Windows support but are not part of the multiplexer adapter. Implement and test them as a separate module so Herdr migration failures are distinguishable from shell-tool failures.

## tmux-to-Herdr feature parity matrix

| Area | Existing tmux behavior | Herdr migration | Parity target | Verification |
| --- | --- | --- | --- | --- |
| Runtime detection | Requires both `TMUX` and a `tmux` executable | Require `HERDR_ENV=1`, `HERDR_PANE_ID`, a reachable Herdr server, and a supported CLI version | Preserve | Outside-Herdr failure and inside-Herdr success tests on Windows and macOS |
| Stable parent targeting | Uses `TMUX_PANE`, independent of user focus | Pass the parent's `HERDR_PANE_ID` explicitly to every split | Preserve | Change UI focus, spawn, and assert the child still splits from the parent pane |
| Child pane creation | `tmux split-window -d -h -t <parent>` | `herdr pane split <parent> --direction right --no-focus` | Preserve | New pane ID is returned and points to a live pane |
| Split directions | Adapter supports left, right, up, and down | Herdr natively supports right and down | Narrow intentionally | Keep right in production; retain down only if needed; remove or explicitly emulate left/up |
| No focus stealing | tmux `-d` leaves the active pane unchanged | Herdr `--no-focus` | Preserve | Compare no-argument `herdr pane current` before and after split |
| Pane identity | Validates tmux IDs such as `%12` | Parse `.result.pane.pane_id` and validate Herdr public IDs such as `w1:p1` | Preserve | Unit-test valid, missing, malformed, and error responses |
| Pane naming | tmux adapter ignores the supplied subagent name | Optionally call `herdr pane rename` after creation | Optional enhancement | Pane remains usable if rename fails; label appears when supported |
| Initial cwd | Shell command uses `cd <cwd> && ...` | Pass `--cwd <path>` to `pane split` | Improve | Paths with spaces and Unicode on PowerShell, zsh, and Bash |
| Initial environment | Shell command prefixes `KEY=value` assignments | Pass repeated `--env KEY=VALUE` arguments when creating the pane | Improve | Values containing spaces, quotes, `$`, backticks, and `=` arrive unchanged |
| Shell readiness | Waits `PI_SUBAGENT_SHELL_READY_DELAY_MS`, default 500 ms | Retain the configurable delay initially or replace it with a Herdr readiness handshake | Preserve | Slow-profile test proves the first launch command is not dropped |
| Shell command execution | Types a shell command and presses Enter | `herdr pane run <pane> <command>` through a shell-aware renderer | Preserve | Command runs exactly once and returns expected output on all three shells |
| TUI message steering | Literal `send-keys`, followed by Enter | Atomic `pane run` submission; use `send-text` plus `send-keys enter` only if TUI testing requires it | Preserve | Multiline input is flattened once and delivered as one pi turn |
| Long launch commands | Writes a Bash script, then sends a short invocation | Write `.ps1` or `.sh` artifacts and submit a shell-appropriate invocation | Preserve and extend | Long commands are not truncated; launch artifact is retained for debugging |
| Synchronous screen read | `tmux capture-pane -p` | `herdr pane read --source recent-unwrapped --lines N --format text --raw` | Preserve | Marker appears in sync read without JSON envelope text |
| Asynchronous screen read | Async `capture-pane` subprocess | Async form of the same Herdr CLI read | Preserve | Concurrent reads do not block launches or corrupt output |
| Scrollback semantics | Captures the requested tail with tmux wrapping behavior | Use `recent-unwrapped` to avoid soft-wrap corruption | Preserve or improve | Long sentinel/output lines remain searchable as single logical lines |
| Clean completion sentinel | Polls screen for `__SUBAGENT_DONE_<code>__` | Poll Herdr pane output for the same sentinel | Preserve | Exit codes 0 and non-zero are decoded correctly on every shell |
| Error sidecar | Checks `<session>.exit` before screen polling | Keep filesystem fast path unchanged | Preserve | Sidecar wins over stale screen output and is removed after consumption |
| Claude sentinel file | Checks a dedicated sentinel before screen polling | Keep the sentinel protocol; use portable temp paths and Node hook | Preserve | Autonomous Claude run returns summary and transcript path |
| Pending question sidecar | Poll tick delivers `<session>.ask` without ending the pane | Keep behavior unchanged while Herdr polling runs | Preserve | Question is delivered once and the pane remains live for the reply |
| Pane disappearance | tmux read errors are swallowed and polling continues | Distinguish transient read failure from `pane not found`; terminate or consume a late sidecar | Improve | Manually close a running pane and receive a bounded, actionable failure |
| Pane close | `tmux kill-pane -t <id>` | `herdr pane close <id>` | Preserve | Process and pane disappear; repeated cleanup handles not-found safely |
| Cancellation cleanup | Abort watcher, close pane, remove running entry | Same orchestration using Herdr close | Preserve | Cancellation leaves no pane, timer, or running-map entry |
| Layout rebalance | Debounced `select-layout even-horizontal` after spawn/exit | Let Herdr own layout; optionally add a Herdr layout policy later | Intentional non-parity | Multiple spawn/close cycles remain usable; no focus change or layout failure breaks launch |
| Parallel spawning | Multiple detached splits and independent pollers | Multiple `--no-focus` Herdr splits and independent pollers | Preserve | Concurrent subagents get unique pane IDs and independent results |
| Session resume | Creates a fresh pane and starts pi with the prior session file | Same workflow with Herdr cwd/env and shell-aware script | Preserve | Finished agent resumes under the same name and session on Windows/macOS |
| Result fallback | Claude can fall back to captured pane output | Read the Herdr pane before closing it | Preserve | Missing sentinel summary still produces readable terminal output |
| Client detach | tmux panes survive client detach | Herdr server preserves panes across client detach | Preserve via Herdr | Detach and reattach without terminating a running subagent |
| Focus inspection in tests | Uses `tmux list-panes` and `pane_active` | Use Herdr's UI-focused-pane query, not caller-derived `--current` | Replace test mechanism | Contract test establishes exact focus-query semantics before no-focus assertions |
| Cross-platform temp paths | Uses `/tmp`, `HOME`, and slash splitting in several paths | Use `tmpdir()`, `homedir()`, `basename()`, and `path.join()` | Required for Windows | Unit and integration tests use Windows and macOS-style paths |
| Claude stop hook | Bash and Python script writes sentinel/transcript files | Node hook launched portably from `hooks.json` | Required for Windows | Hook subprocess matrix covers PowerShell, zsh, and Bash |
| Bundled subagent shell tools | Agent definitions request `bash`/`safe_bash` | Introduce platform-aware `shell`/`safe_shell` modules | Required for full Windows parity | Tool execution, timeout, cancellation, output, and safety tests per shell |

---

## 1. Replace the tmux surface module

### Files

- Delete or replace `pi-extension/subagents/tmux.ts`
- Add `pi-extension/subagents/herdr.ts`
- Update imports in `pi-extension/subagents/index.ts`
- Update integration-test imports

### Herdr surface interface

Keep a small deep interface so `index.ts` does not know about Herdr command syntax:

```ts
type SurfaceId = string;

createSurface(options?: {
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
}): SurfaceId;

// Submit a shell command to an idle shell prompt.
runCommand(surface: SurfaceId, command: string): void;

// Submit one complete message/turn to an interactive TUI.
submitText(surface: SurfaceId, text: string): void;

readScreen(surface: SurfaceId, lines?: number): string;
readScreenAsync(surface: SurfaceId, lines?: number): Promise<string>;

closeSurface(surface: SurfaceId): void;

isHerdrAvailable(): boolean;
herdrSetupHint(): string;
pollForExit(...): Promise<PollResult>;
```

Long-command script creation belongs to the shell module rather than the Herdr adapter. The shell module writes the portable artifact and renders its short invocation; `runCommand` only submits that invocation.

The implementation should use `execFile`/`execFileSync("herdr", args)` rather than shell command strings.

### Availability

Detect Herdr using:

- `HERDR_PANE_ID`
- `HERDR_ENV`
- a successful Herdr CLI availability/server check
- a minimum-version/capability check for every required pane command

Use a centralized `runHerdr(args)` helper built on `execFile`/`execFileSync`; do not run `command -v` through `sh -c`. The helper owns JSON parsing, exit-code checks, normalized errors, and pane-ID validation.

Do not attach to an arbitrary Herdr UI focus when the parent process is outside a Herdr pane. The extension should report a clear setup message:

> Start Herdr, then run pi inside a Herdr pane.

### Pane creation

Create panes explicitly from the parent pane:

```text
herdr pane split <parent-pane> \
  --direction right \
  --no-focus \
  --cwd <child-cwd> \
  --env KEY=VALUE
```

Important behavior:

- Always pass the parent `HERDR_PANE_ID`.
- Always use `--no-focus`.
- Pass the child working directory through Herdr instead of emitting a shell-specific `cd`.
- Pass launch environment through repeated `--env` arguments where possible.
- Parse and validate the returned pane ID.
- Optionally rename the Herdr pane using the subagent name, but treat labeling as cosmetic.

### Command delivery

Keep shell execution and interactive TUI input as separate interface operations:

- `runCommand` uses `herdr pane run <pane> <command>` to submit a shell-aware launch-script invocation atomically.
- `submitText` also prefers atomic `pane run` semantics for steering one complete pi turn. Use `pane send-text` plus `pane send-keys enter` only if integration tests show that `pane run` is incompatible with pi's TUI input handling.

This avoids the current tmux-specific `send-keys` implementation, prevents partial submissions, and avoids focus-dependent behavior.

### Screen capture

Replace tmux `capture-pane` calls with:

```text
herdr pane read <pane> \
  --source recent-unwrapped \
  --lines <N> \
  --format text \
  --raw
```

> **Correction (verified):** `--raw` maps to `strip_ansi: false`, so it keeps ANSI escapes and adds carriage returns. Reads used for sentinel detection are `herdr pane read <pane> --source recent-unwrapped --lines <N> --format text`, with no `--raw`. Sentinel waits also use a digit-anchored regex, `--regex "__SUBAGENT_DONE_[0-9]{1,3}__"`, because the literal prefix `__SUBAGENT_DONE_` also appears in the echoed launch command line and a plain match returns immediately with no exit code.

Use `recent-unwrapped` for sentinel detection because it avoids terminal soft wrapping. Preserve the current polling behavior initially; investigate `pane.wait_for_output` later as an optimization. The CLI primitive is `herdr pane wait-output (--match TEXT | --regex PATTERN) --source recent-unwrapped --lines N --timeout MS`, which searches the existing snapshot immediately and then polls server-side.

### Cleanup and layout

- Replace `tmux kill-pane` with `herdr pane close`.
- Remove `select-layout` and `SUBAGENT_TMUX_LAYOUT`.
- Do not try to reproduce tmux’s named `even-horizontal` layout unless Herdr exposes a stable equivalent.
- Let Herdr own pane layout and sizing.
- Pane close and layout failures should remain non-fatal during cleanup.

---

## 2. Make child launch commands shell-aware

The current code assumes POSIX shell syntax in several places:

- `shellEscape()` only implements POSIX quoting.
- Launch commands use `cd ... &&`.
- Environment variables are prefixed as `NAME='value'`.
- Long commands are written as `#!/bin/bash` scripts and launched with `bash`.
- Claude uses `/tmp`.
- `on-stop.sh` depends on Bash and Python.

### Add a shell module

Add something such as:

```text
pi-extension/subagents/shell.ts
```

It should define:

```ts
type ShellKind = "posix" | "powershell";

interface ShellSpec {
  kind: ShellKind;
  executable: string;
  scriptExtension: ".sh" | ".ps1";
  quoteArg(value: string): string;
  renderCommand(argv: string[]): string;
  renderScriptInvocation(path: string): string;
}
```

### Shell selection

Use this precedence:

1. `PI_SUBAGENT_SHELL`
2. On macOS:
   - `SHELL` when it is `zsh` or `bash`
   - `/bin/zsh` or `/bin/bash` fallback
3. On Windows:
   - `pwsh` if explicitly configured/available
   - `powershell.exe` fallback

The shell resolver should return a structured shell specification, not just a string.

The resolved shell family must match the shell Herdr starts for the new pane. Document the matching `terminal.default_shell` setting and add a startup validation or `pane process-info` probe where possible. A mismatch must produce an actionable error instead of sending PowerShell syntax to a POSIX shell or vice versa.

### Stop pre-escaping argv

Refactor command construction so helpers build raw argument arrays:

```ts
["pi", "--session", sessionFile, "-e", extensionPath, "--model", model]
```

Only the final shell renderer should quote arguments. This prevents the current POSIX quoting from breaking PowerShell paths, apostrophes, `$`, backticks, and spaces.

### Generate shell-specific launch scripts

For macOS:

```sh
#!/usr/bin/env zsh
pi ...
code=$?
printf '__SUBAGENT_DONE_%s__\n' "$code"
```

The same structure should work for Bash.

For PowerShell:

```powershell
& pi ...
$code = $LASTEXITCODE
Write-Output "__SUBAGENT_DONE_${code}__"
```

> **Note (verified):** the braced `${code}` form is required. Inline interpolation such as `"__SUBAGENT_DONE_$LASTEXITCODE__"` parses `$LASTEXITCODE__` as a single variable name and prints a sentinel with no digits, which never matches the parent's regex. Native exit codes do propagate for the `pi.ps1` shim in a fresh pane (checked with 0 and 5), and a `$?` fallback covers a null exit status. In the captured change the task text no longer travels through the shell at all: it is delivered with `agent prompt` once the child reports a ready state, leaving the invocation plus this sentinel as the shell renderer's whole job.

Requirements:

- Always emit the completion sentinel, including non-zero exit codes.
- Do not use `set -e` in the wrapper because the sentinel must still be written.
- Preserve launch scripts under the existing artifact directory for debugging.
- Use `.sh` on POSIX and `.ps1` on Windows.
- Invoke scripts with the detected shell, not hardcoded `bash`.

### Remove Unix-only paths

Replace:

```ts
/tmp/...
process.env.HOME
transcriptPath.split("/")
```

with:

```ts
join(tmpdir(), ...)
homedir()
basename(transcriptPath)
```

Specific locations include:

- Claude sentinel paths in `index.ts`
- `CLAUDE_SESSIONS_DIR`
- integration-test output paths
- any artifact or temporary file construction

---

## 3. Port the Claude completion hook

### Current problem

`pi-extension/subagents/plugin/hooks/on-stop.sh` depends on:

- Bash
- `cat`
- `python3`
- POSIX path syntax

### Replacement

Add:

```text
pi-extension/subagents/plugin/hooks/on-stop.mjs
```

Implement the same behavior with Node:

1. Read JSON from stdin.
2. Ignore recursive `stop_hook_active` invocations.
3. Exit when `PI_CLAUDE_SENTINEL` is absent.
4. Read `transcript_path`.
5. Write the transcript path to `<sentinel>.transcript`.
6. Count real user messages from the JSONL transcript.
7. Write `last_assistant_message` to the sentinel for autonomous runs.

Update `hooks.json` to invoke Node through the Claude plugin root.

Test the hook with:

- Windows paths containing spaces
- macOS paths
- missing transcript files
- malformed input
- recursive stop-hook input
- autonomous and interactive sessions

---

## 4. Add a portable shell tool for subagents

> **Out of scope in the captured change.** pi already runs bash on Windows through Git Bash:
> `getShellConfig()` prefers Git Bash (`C:\Program Files\Git\bin\bash.exe`), then `bash.exe`
> on PATH, and the SDK's `docs/windows.md` documents Git Bash as the Windows default. The
> bundled agents' `bash` and `safe_bash` tools therefore already work on Windows, so portable
> `shell`/`safe_shell` tools are separate product work rather than multiplexer portability.
> Note also that the pane shell (what parses a typed launch line) and the agent's own shell
> tool are independent choices.

`safe-bash.ts` is explicitly Bash-only, and the bundled agents currently request `bash` or `safe_bash`.

### Add portable tools

Create:

```text
pi-extension/subagents/tools/shell.ts
pi-extension/subagents/tools/safe-shell.ts
```

The tool should:

- execute through the resolved shell
- support `zsh` and `bash` on macOS
- support PowerShell on Windows
- preserve command, timeout, output, and cancellation behavior
- terminate child processes correctly on each platform

If the installed pi SDK exposes a platform-neutral shell factory, use it. Otherwise implement the tool with `child_process.spawn` and the same result/update contract as pi’s existing shell tool.

### Safety rules

Port the existing dangerous-command checks and add PowerShell equivalents, including patterns for:

- `Remove-Item -Recurse -Force`
- `Stop-Computer`
- `Restart-Computer`
- destructive disk commands
- dangerous downloads piped into execution
- privilege escalation
- recursive deletion of system paths

Keep the rules shell-specific so a Bash pattern is not incorrectly applied to PowerShell syntax.

### Agent configuration

Update:

- `agents/worker.md`
- `agents/researcher.md`
- `getToolExtensionPath()` in `index.ts`
- tool allowlist normalization

Recommended names:

- `shell` for the general portable shell tool
- `safe_shell` for the guarded version

Keep `safe_bash` as a compatibility alias if practical, but update the bundled definitions to the portable names.

On Windows, explicitly normalize requested `bash` tools to `shell` for bundled agents. Add a clear error or migration hint for custom agent definitions that require Bash-only behavior.

---

## 5. Update subagent orchestration

### `pi-extension/subagents/index.ts`

Replace tmux-specific imports and wording:

- `isMuxAvailable` → `isHerdrAvailable`
- `muxSetupHint` → Herdr setup hint
- tmux-specific error text
- “via tmux” error messages
- tmux surface terminology in comments

Preserve:

- `RunningSubagent.surface`, or rename it to `paneId`
- `.exit` sidecar handling
- `.ask` question handling
- activity/status files
- session resume behavior
- result extraction
- cancellation cleanup

Remove the unused `PI_SUBAGENT_SURFACE` environment variable unless a real child consumer is added; current repository usage only writes it.

Ensure a failed Herdr launch closes any pane that was successfully created before the failure.

---

## 6. Rewrite integration tests for Herdr

### Files

- Rename `test/integration/tmux-surface.test.ts` to `herdr-surface.test.ts`
- Update `test/integration/harness.ts`
- Update `test/integration/subagent-lifecycle.test.ts`

### Harness changes

Replace:

- `tmux list-panes`
- `tmux select-pane`
- tmux pane IDs
- `tmux new` instructions

with Herdr operations.

The harness should:

- skip surface tests when Herdr is unavailable
- create panes through the Herdr adapter
- track and close pane IDs
- use `HERDR_PANE_ID` to identify the calling/parent pane
- use the no-argument `herdr pane current` behavior for UI-focus assertions, after a contract test verifies that behavior
  > **Simpler oracle (verified):** `herdr pane list` carries a per-pane `focused` flag that tests can assert directly. `pane current` with no arguments reports the UI-focused pane; `--current` resolves to the caller (`HERDR_PANE_ID`). With multiple clients able to view different tabs in 0.9.0, all commands should target panes explicitly.
- use `recent-unwrapped` reads
- use `tmpdir()` and `path.join()`
- launch test scripts using the portable shell renderer

### Surface tests

Cover:

1. Creating a pane with `--no-focus`.
2. Parent focus remaining unchanged.
3. Sending literal text containing:
   - `$`
   - quotes
   - apostrophes
   - backticks
   - spaces
4. Long command/script delivery.
5. Async screen reads.
6. Multiple concurrent panes.
7. Pane close and cleanup.
8. Working directories containing spaces.
9. Environment values containing PowerShell-sensitive characters.
10. Sentinel detection after a non-zero child exit.

### Shell unit tests

Add unit coverage for:

- zsh quoting
- Bash quoting
- PowerShell quoting
- shell detection and overrides
- `.sh` and `.ps1` script generation
- exit sentinel generation
- paths with spaces
- apostrophes, `$`, backticks, Unicode, and newlines

### Claude hook tests

Run the Node hook as a subprocess and verify sentinel/transcript behavior on both platforms.

---

## 7. Documentation and packaging

Update:

- `README.md`
- `package.json` description
- requirements section
- integration test instructions
- agent/tool documentation

Document:

```text
Install Herdr, start it, then run pi inside a Herdr pane.
```

Add shell configuration examples:

macOS:

```toml
terminal.default_shell = "/bin/zsh"
```

or:

```toml
terminal.default_shell = "/bin/bash"
```

Windows:

```toml
terminal.default_shell = "powershell.exe"
```

Document:

```text
PI_SUBAGENT_SHELL
```

as the explicit override for unusual setups.

Remove:

- tmux installation instructions
- tmux-only wording
- `tmux new -A ...`
- `even-horizontal` layout configuration

---

## 8. Verification sequence

1. Run unit tests on the current development machine. **Blocked as of 2026-09-15:** this repository has no `node_modules` and tmux is not installed, so the existing suite cannot run here (the surface tests skip). Rewrite the harness before the cutover and make the Windows machine the primary test bed.
2. Run Herdr surface tests inside a Herdr pane on macOS with zsh.
3. Repeat with Bash selected explicitly.
4. Run on Windows with PowerShell.
5. Test a project path containing spaces.
6. Test an agent launch with:
   - a normal task
   - a non-zero exit
   - an `ask_question`
   - a resumed session
   - a long prompt
7. Test Claude completion hook behavior.
8. Verify no remaining runtime references to:
   - `tmux`
   - `TMUX`
   - `/tmp`
   - hardcoded `bash`
   - POSIX-only `cd &&`
   - `#!/bin/bash`

## Acceptance criteria

- The extension starts only when pi is running inside Herdr.
- Subagent panes are created without changing focus.
- Launch, steering, reading, polling, completion, resume, and cleanup work on macOS zsh, macOS Bash, and Windows PowerShell.
- No user-provided task, path, or environment value is corrupted by shell quoting.
- No runtime code requires Bash, Python, `/tmp`, or Unix path separators.
- Existing session, status-widget, `.exit`, `.ask`, and artifact behavior remains unchanged.
- The repository contains no tmux implementation or tmux setup requirement.
