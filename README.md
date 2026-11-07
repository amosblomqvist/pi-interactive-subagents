# pi-interactive-subagents

Async subagents for [Pi](https://github.com/earendil-works/pi). Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

Each Pi child runs as a separate interactive TUI process, not an RPC child.
The Herdr backend creates one native pane per child. The Linux process backend uses a PTY for headless tests.
A private mailbox carries coordinator messages separately from terminal input. Tool restrictions are not an OS sandbox.

## How it works

`subagent()` waits for startup and the bootstrap acknowledgment, then returns without waiting for task completion.
The process backend captures output beside the launch script. The Herdr backend displays the actual Pi TUI.
A live widget tracks running children. Completion notifications return results to the parent and trigger a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes. A root-session lineage shares one persistent technical launch ledger across every child and grandchild, including resumed runs. The defaults allow depth 2 (root is 0), four active descendant processes total, and unlimited cumulative launches for the lineage.

The launch counter tracks **process launches, including resumes**, not tokens, dollars, or model cost. Pre-spawn failures are refunded; cancellation and processes that actually started consume a launch. The count remains persisted even when cumulative launches are unlimited. Set `maxLaunchesPerLineage` to a non-negative integer for an explicit finite cap; after that cap is exhausted, start a new root session or explicitly change the root configuration. These launcher limits are operational safeguards, not a sandbox against code that bypasses the launcher.

## Tools

| Tool | Description |
| --- | --- |
| `implementation_route` | Advisory direct/delegated/SDD route selection from explicit scope facts |
| `subagent` | Spawn a sub-agent in an isolated background process (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagent_cancel` | Cancel an exact running name owned by this session; preserve files and deliver a cancelled result |
| `subagent_status` | Read owned worker identity and running, finished, or unknown status, with a validated terminal result when available |
| `subagents_list` | List available agent definitions and their effective capabilities |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Waiting and cancellation

The monitor explains a parked agent: `parent answer`, `children (N): name…`,
`aborted turn`, or `interactive input`. Named child dependencies are bounded and sanitized.
A completed handoff does not bypass the child-draining guard: a parent stays open while
its children are pending. Repeating a finish instruction does not cancel those children.

Use `subagent_cancel({ name: "worker" })` or `/subagent-cancel worker` to request cancellation.
Only exact names currently owned by this session are accepted; this never resumes a finished
agent and does not accept arbitrary process IDs. Saved files remain untouched; cancellation
is not reported as successful task completion. On Windows the managed process tree is stopped;
on POSIX the surface also enumerates descendants with `ps` because nested surfaces can have
separate process groups. This is process cleanup, not containment of deliberately escaping
processes. Failure to terminate a live surface is reported rather than silently accepted.

Offline regressions cover child-draining, reason display, late settled events after shutdown,
exact-name cancellation, and a real detached descendant with an unaffected sibling. Native
process cancellation was historically exercised on Windows. Current Linux tests cover PTY descendants and cancellation of one Herdr child without stopping its sibling.
These tests do not reproduce or cure provider-side long generation or compaction failures.
Custom profiles can still grant nested delegation; the separate `agent-config` harness now
keeps delegation in the parent by default, so its worker no longer creates hidden descendants.

### Implementation routing

Use `implementation_route` when the smallest safe route is not obvious. It is advisory only: it does not inspect the repository, launch a child, edit files, or create SDD artifacts.

- **direct** — the work is bounded enough for focused inspection and implementation in the current session. Unfamiliarity, file counts, and bounded ambiguity do not by themselves trigger delegation; ask one focused question when needed.
- **delegated** — exploration is genuinely broad, research spans multiple sources, or an independent work item benefits from separate context. Delegate a narrow action and integrate its result.
- **sdd** — the user explicitly requested SDD, or durable planning artifacts would materially reduce uncertainty. A proposal requires explicit user acceptance.

The tool requires the orchestrator to provide scope facts instead of pretending that the router can infer them:

```typescript
implementation_route({
  task: "Add the bounded parser test",
  alreadyUnderstood: true,
  filesToUnderstand: 1,
  filesToImplement: 1,
  mechanical: false,
  broadExploration: false,
  independentWork: false,
});
```

`alreadyUnderstood`, `filesToUnderstand`, and `filesToImplement` remain available as informational facts for existing consumers. Delegation is selected only from the explicit `broadExploration`, broad `needsResearch`, or `independentWork` signals.

`subagents_list` reports each profile's runtime, effective tool allowlist, skills, nested spawn targets, and missing extension diagnostics. Restricted launches validate extension-backed tools before creating a child surface or session; a missing capability fails closed.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the process and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model, then parent model | Override the model for this spawn. Worker requests for Astra are treated as reserved escalation. |
| `useAstraXhigh` | boolean | `false` | Worker-only reserved escalation to Astra at `xhigh`; every activation asks the user and no-UI sessions are refused |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the private mailbox preserves literal multiline messages. An acknowledgment confirms submission to Pi, not model execution or completion.
- **Finished** — the follow-up starts a new interactive process with the saved session and original name. The result arrives later.

For repository-bound continuation, use the restrictive options:

```typescript
subagent_message({
  name: "project-worker",
  message: "Continue the agreed task",
  resume_only: true,
  expected_cwd: "/absolute/canonical/repository",
  expected_agent: "project-worker",
});
```

`resume_only` refuses a running worker without sending a message. The expected root and profile must match the saved loadout.
`subagent_status({ name })` resolves only workers registered to the current parent session.
A running process or pending resume takes precedence over an earlier result receipt.
Finished status requires a validated `<session>.result.json` receipt. Missing or invalid evidence returns unknown status.
Results are bounded to 48,000 characters plus a truncation marker.
The runtime emits `interactive-subagents:disposed` only after successful cleanup of its pending launches and owned surfaces.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original restricted loadout.** Each launch saves its resolved policy to `<session>.loadout.json`.
The snapshot includes tools, extensions, model, thinking level, prompt, spawn targets, and working directory.
Resume reconstructs those restrictions instead of launching an unrestricted process.

### ask_question

A sub-agent can ask its orchestrator one focused question only when a material ambiguity or blocker prevents safe progress, or a coordinator-only decision is required. Resolve local, reversible choices without asking for routine confirmation. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Each sub-agent may have one pending question; a second one is rejected instead of replacing the first. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the background process stays open until it is terminated. Only available inside sub-agent sessions.

### Structured handoffs

Every launch asks the child to finish with a concise `## Handoff` footer containing `Status`, `Summary`, `Files`, `Verification`, `Risks/Blockers`, and `Next`. The parent receives the parsed footer in the result details when the child follows the format. An unstructured response is preserved as `unknown`; the extension never invents completion, file changes, or verification claims.

## Bundled agents

| Agent | Model | Thinking | Tools | Role |
| ----- | ----- | -------- | ----- | ---- |
| **scout** | `openai-codex/gpt-5.6-luna` | `max` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openai-codex/gpt-5.6-luna` | `max` | `read`, `safe_bash` | Web research through sandboxed HTTP/search commands, synthesized into a sourced brief |
| **worker** | `openai-codex/gpt-5.6-sol` | `high` | `read`, `write`, `edit`, `bash` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`). For reserved worker tasks, `useAstraXhigh: true` requests `openai-codex/gpt-6-astra` at `xhigh`; the extension always asks the user before activation, including on resume, and refuses when interactive confirmation is unavailable.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).
Default discovery priority is **project > global > package-bundled**.
`allowProjectAgents: false` and `includeBundledAgents: false` disable those sources.
The installed `agent-config` policy requires named personal profiles and disables both sources.

```markdown
---
name: my-agent
description: Does something specific
model: openai-codex/gpt-6-astra
thinking: medium
tools: read, edit, write, safe_bash
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child; if a declared extension is unavailable, spawning fails with a diagnostic instead of silently granting an incomplete loadout |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string or boolean | Comma-separated skill names to load, or `false` to disable skill discovery |
| `extensions` | boolean | `false` disables optional extension discovery |
| `allowed_subagents` | string | `none` disables nested delegation |
| `prompt_mode` | string | `append` or `replace`, compatible with the managed harness profiles |
| `max_turns` | positive integer | Stop incomplete work at this turn limit. A resumed process receives a new budget |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down after Pi reports settled work and pending child dependencies finish.
The agent writes its final message and stops. There is no "done" tool.
The last assistant message becomes the summary returned to the parent. Direct user interaction can keep the TUI open.

Notes:

- **Follow-up input does not strand an auto-exit sub-agent.** If the orchestrator sends another message, the session still closes once that turn completes normally; only an abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings, while explicitly interactive profiles stay quiet and rely on the widget. Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Every launch and finished-session resume also acquires a generation-tokened lease in the root lineage ledger. The depth, active-process count, and cumulative launch count are checked under one cross-process file lock, so grandchildren cannot reset the accounting in their own process. Releases are token-checked to prevent stale completion/cancellation races from deleting a retry's lease; failed process termination retains capacity, and abandoned owners are reclaimed conservatively without refunding launches. Linux process-start ticks disambiguate PID reuse; platforms without a comparable identity retain ambiguous live-PID capacity rather than claiming the PID is the original process. Existing lineage files retain usage across Pi restarts, inherited children cannot recreate a missing ledger or loosen its root policy, and corrupt accounting is refused rather than reset. On normal root initialization, the current root configuration is applied without clearing usage, descendants, or active leases; this migrates an old default finite ledger to the current unlimited default.

Lineage locks are never deleted automatically based on age because doing so can remove a replacement owner's lock. A lock timeout reports its bounded owner record and the exact `.lock` directory. Only remove that directory manually after confirming every owning Pi process has stopped.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global. Restricted launches fail clearly when a declared extension-backed tool is unavailable; install or register the extension before using that profile rather than bypassing the whitelist.

## Role folders

With project profiles enabled, `cwd` can select a directory with role-specific configuration:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

When `allowProjectAgents` is false, `cwd` changes only the working directory.
It cannot replace personal configuration or move session storage into the project.
Resume rejects a saved non-personal agent directory under this policy.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Use `/subagents` or `Ctrl+Alt+S` to open a live monitor. It shows the active descendant tree across the whole root lineage, with stable IDs, nesting depth, per-parent active child counts (`↳N`), task, model, current tool, sanitized action, and bounded observable events. Use arrow keys to select and collapse/expand branches. Counts remain visible whenever descendants are active, not only while an agent is waiting. Use `/subagent-log <name>` to inspect recent events for a directly owned running or completed named session. These views do not add monitoring output to the parent model's context. Thinking blocks are deliberately excluded.

### Historical snapshot viewer

The optional snapshot viewer is separate from the native Herdr execution backend.
It displays snapshots, not an interactive child. The installed harness disables this viewer.

In Pi's fullscreen mode, clicking a descendant widget row opens or focuses one Herdr tab for that stable descendant ID when `HERDR_ENV=1` and the viewer is enabled. The tab is explicitly scoped to `HERDR_WORKSPACE_ID`, preserves the caller's working directory, and runs only `viewer-runtime.mjs` against a bounded sanitized snapshot; it never starts or attaches a second Pi process, sends input, invokes a model, exposes hidden reasoning, or browses arbitrary sessions. Completed, failed, and cancelled owners write a terminal snapshot; an owner that disappears without doing so ages into a visible stale/disconnected state. Concurrent clicks are idempotent, and retired Pi sessions cannot perform a late run/focus. If Herdr is absent or the viewer is disabled, the same click falls back to Pi's bounded ownership-aware snapshot overlay; regular terminal mode keeps `/subagents` and `Ctrl+Alt+S` because Pi 0.85.1 routes widget mouse input only in fullscreen mode. Herdr failures are reported without affecting subagent execution.

On Windows, shell quoting is fail-closed and `PI_SUBAGENT_HERDR_SHELL` is required. Set it to `powershell` or `git-bash` to describe the shell Herdr is configured to use for **new tabs**. The caller's inherited `SHELL` is not authoritative and is never inferred because it may differ from that new-tab shell; `cmd.exe` is unsupported because `%VAR%` expansion cannot safely preserve arbitrary paths. Shell selection, the absolute `process.execPath`, and every quoted path are validated before `tab create`, so missing or invalid configuration creates no tab. A successful `pane run` only confirms command-text submission, not that Node started or the viewer became ready; diagnose runtime failures by reading the test-owned pane during the coordinated manual smoke. The viewer never falls back silently to a bare `node` resolved by the pane shell.

### Native Herdr backend and personal policy

Herdr launches Pi directly in a core-owned PTY, without tmux, `script`, an RPC child, or a transcript viewer.
The target comes from the caller's Herdr terminal or an explicit existing `PI_SUBAGENT_HERDR_TAB`.
There is no fallback to the focused pane. Startup waits for the child TUI and pane adoption before submitting the task.
Cancellation and cleanup operate only on owned surfaces.

Configuration precedence is an absolute `PI_SUBAGENTS_CONFIG` path, personal `subagents.json`, then package defaults.
The personal file lives under `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that variable is absent.
An invalid explicit configuration fails instead of falling back.
Do not edit sealed packages. `config.json.example` provides packaged defaults, with package-local `config.json` retained for compatibility.

The installed harness uses this policy:

```json
{
  "status": { "enabled": true },
  "delegation": {
    "maxDepth": 1,
    "maxConcurrentDescendants": 6,
    "maxLaunchesPerLineage": null
  },
  "herdrViewer": { "enabled": false },
  "surfaceBackend": "herdr",
  "includeBundledAgents": false,
  "allowProjectAgents": false,
  "requireProfile": true
}
```

`maxLaunchesPerLineage: null` explicitly means there is no cumulative process-launch policy cap. A non-negative integer retains the finite-cap behavior used by older version-one configs and ledgers. Depth and active-descendant limits remain finite. The existing 10,000-record bound on distinct persisted descendant identities remains a metadata resource guard: at capacity a new identity is rejected before mutation, while an existing identity can still resume and increment its accounting.

## Compatibility and verification

Package dependency metadata remains pinned to Pi 0.85.1 and `typebox` 1.3.7.
The current interactive transport and installed harness are verified on Linux with Pi 1.5.0 and Node 22.23.2.
The legacy SDK smoke checks loading, not current cross-platform TUI behavior.
The 0.85.0 `pi-server` packaging workaround is no longer required.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:integration
npm run test:smoke
```

The integration command runs process-only coverage by default; live model tests remain opt-in. The smoke test loads every extension entry point through Pi's real extension loader and exercises `safe_bash` without invoking a model.

### Current offline TUI and Herdr verification

Set `PI_TEST_CLI` to the installed Pi `dist/cli.js` path for the real TUI fixtures:

```sh
PI_TEST_CLI=/absolute/path/to/pi-coding-agent/dist/cli.js \
node --test --test-concurrency=1 \
  test/integration/interactive-tui.test.ts \
  test/integration/project-session-contract.test.ts
```

These tests use synthetic providers and isolated configuration, without account credentials or paid model calls.
They cover multiline delivery, owned results, restrictive resume, pending-resume status, and disposal.
See [interactive transport](test/interactive-transport.md) and [native Herdr panels](test/herdr-panels.md) for prerequisites and commands.
The Herdr test needs explicit desktop-control authorization. Process-only tests do not certify visible panels.
Current Windows TUI behavior and live-provider execution remain unverified.

### Historical live child-process verification

The retained live suite covers result delivery, questions, resume, startup failure, parallel delivery, discovery, and session placement.
Its parent is a synthetic in-process `ExtensionAPI` driver.
The historical Windows verification used RPC children, before the interactive transport migration.
It is historical evidence, not certification of the current TUI transport or parent UI.

Each test creates a private temporary `PI_CODING_AGENT_DIR` and a separate synthetic parent session directory. Child sessions use Pi's normal cwd-keyed storage beneath that temporary config. The harness never discovers or copies credentials or models from the active home. To opt in, the executor may select only these concrete files:

- `PI_TEST_AUTH_FILE` → copied opaquely to temporary `auth.json`
- `PI_TEST_MODELS_FILE` → copied opaquely to temporary `models.json`

Either file is optional when environment credentials and the built-in model catalog suffice. Contents are never parsed or printed by the harness. Child processes are terminated before cleanup; fixture deletion failures fail the test and report the retained private fixture path instead of silently leaving secrets behind.

Live calls are never enabled by `npm run test:integration` alone. To run the minimum one-child/one-turn pilot, explicitly select a non-reserved model and, only if needed, concrete config files:

```bash
# POSIX shells
PI_TEST_MODEL=openai-codex/gpt-5.6-sol \
PI_TEST_AUTH_FILE=/explicit/path/to/auth.json \
npm run test:live:pilot
```

```powershell
# PowerShell
$env:PI_TEST_MODEL = "openai-codex/gpt-5.6-sol"
$env:PI_TEST_AUTH_FILE = "C:\explicit\path\to\auth.json"
# Optional when the selected model needs a custom catalog:
# $env:PI_TEST_MODELS_FILE = "C:\explicit\path\to\models.json"
npm run test:live:pilot
```

The pilot defaults to a 60-second per-test deadline. Set `PI_TEST_TIMEOUT` between `15000` and `120000` milliseconds if needed. The runner refuses Astra/xhigh models. It sets `PI_OFFLINE=1` only to suppress Pi startup update/package/telemetry traffic; the live prompt still calls and consumes the explicitly selected model provider.

After the pilot is reviewed, the full seven-case suite can be enabled with `PI_RUN_LIVE_SUBAGENT_TESTS=1`, an explicit non-reserved `PI_TEST_MODEL`, and `npm run test:integration`. Keep `--test-concurrency=1`; the fixtures temporarily set process-wide cwd/config variables.

Verified on native Windows with Pi 0.85.0 and `openai-codex/gpt-5.6-sol`: one-child pilot passed, then all seven cases passed in approximately 36.5 seconds. No terminal-host APIs were used; this does not certify Herdr, other operating systems, or the parent UI. Explicit config copies and test sessions were temporary. Offline coverage includes 177 unit cases, 14 local integration checks and 3 loader/compatibility checks.

The startup-failure case reproduced a launcher bug: printing the completion marker could hide a failed command behind the shell's final zero exit status. Launch and resume scripts now preserve the command status after printing that marker; a model-free subprocess regression covers exit codes 0, 7 and 127.

Extensions may register their own backing file through `globalThis.__pi_interactive_subagents.registerToolExtension(name, path)`. An explicit registration takes precedence over legacy extension-directory discovery, so a packaged tool is not silently replaced by an older file when launching a restricted child. Re-registering the same path is idempotent; conflicting registrations are rejected, and a missing explicitly selected file blocks launch rather than falling back. Registration is not a sandbox for extension code.

## Requirements

- [Pi 1.5.0](https://github.com/earendil-works/pi) for the verified interactive transport
- Node 22.23.2 and a compatible Bash executable
- Herdr app and core (`hc`) for native panes
- Linux util-linux `script` for the process-PTY fallback

`PI_SUBAGENT_SURFACE_BACKEND=process` selects the fallback explicitly for isolated tests.
It overrides the configured backend without changing personal configuration.

The historical Windows launcher detects Git Bash automatically.
`PI_SUBAGENT_BASH` can select another compatible Bash executable by its full path.
This setting does not establish Windows support for the current TUI transport.

```powershell
$env:PI_SUBAGENT_BASH = "C:\Program Files\Git\bin\bash.exe"
pi
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture and status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
