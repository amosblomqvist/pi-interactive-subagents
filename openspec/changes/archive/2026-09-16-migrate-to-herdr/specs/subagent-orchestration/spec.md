## Purpose

Orchestrates interactive subagent runs from the main pi session: spawning each subagent in its own terminal pane, delivering its task once the child can accept input, keeping the orchestrator unblocked, steering and resuming runs, collecting results and exit status, and cleaning up panes and state.

## ADDED Requirements

### Requirement: Non-blocking spawn

The system SHALL return control to the orchestrator without waiting for the subagent to become ready or to finish, and SHALL report each spawned subagent's result back to the orchestrator when its run ends.

#### Scenario: Spawn returns before the child accepts input

- **WHEN** the orchestrator invokes the spawn tool
- **THEN** the tool returns after the child process has been started
- **AND** it does not wait for the child's readiness, first turn, or completion

#### Scenario: Concurrent subagents run independently

- **WHEN** several subagents are spawned in parallel
- **THEN** each runs in its own pane, keeps its own session and artifacts, and reports its own result

### Requirement: Task delivery after readiness

The system SHALL deliver the composed task to the child exactly once, and MUST NOT submit it before the child can accept input.

#### Scenario: Task delivered once the child is ready

- **WHEN** the child process reaches a ready state
- **THEN** the composed task is submitted once as the child's first user turn

#### Scenario: Task withheld before readiness

- **WHEN** the child process has started but is not yet accepting input
- **THEN** the task remains pending and no input is typed into the child

#### Scenario: Degraded delivery is reported

- **WHEN** the preferred delivery path is unavailable within the readiness timeout
- **THEN** the system attempts one alternate delivery transport
- **AND** reports the delivery as degraded when that transport is used

#### Scenario: Ambiguous delivery outcome is never retried blindly

- **WHEN** the preferred transport fails in a way that may have delivered the turn
- **THEN** the system determines whether the child's turn started before any retry or fallback
- **AND** the task is never submitted a second time

#### Scenario: Undeliverable task fails the run

- **WHEN** no transport can deliver the task
- **THEN** the run ends with an actionable error instead of leaving the subagent idle

### Requirement: Steering running subagents

The system SHALL deliver a steering message to a running subagent as a single turn, preserving the message's line breaks, and SHALL report when the subagent cannot accept input.

#### Scenario: Multi-line message arrives as one turn

- **WHEN** the orchestrator steers a running subagent with a message containing newlines
- **THEN** the subagent receives the whole message as one turn

#### Scenario: Blocked subagent is reported, not typed into

- **WHEN** the subagent is waiting at a question or approval dialog
- **THEN** steering reports that the subagent is blocked without sending input into the dialog

#### Scenario: Unknown target is reported

- **WHEN** the requested subagent name matches no running or resumable subagent
- **THEN** the system returns an error naming the request and no pane input is sent

### Requirement: Completion detection and exit status

The system SHALL detect completion from an error sidecar first and from a completion sentinel second, and SHALL surface the child's exit status in the run result.

#### Scenario: Clean completion with exit code zero

- **WHEN** the child exits successfully after emitting the completion sentinel
- **THEN** the run result reports a sentinel completion with exit code 0

#### Scenario: Non-zero exit is decoded

- **WHEN** the child exits with a non-zero status and emits the completion sentinel
- **THEN** the run result reports that exit code and the orchestrator is told the run failed

#### Scenario: Error sidecar takes precedence

- **WHEN** an error sidecar exists for the run
- **THEN** its payload determines the result, it wins over any screen content, and it is removed after being consumed

### Requirement: Results are summarized from the session

The system SHALL summarize a completed run from the child's session data and SHALL fall back to a descriptive message when no assistant output exists.

#### Scenario: Summary from the last assistant message

- **WHEN** the child session file contains assistant output
- **THEN** the last assistant message is reported as the run summary together with session references

#### Scenario: Fallback summary

- **WHEN** the child produced no assistant output
- **THEN** the summary states the exit status or the reported error instead

### Requirement: Pending question sidecar

The system SHALL deliver a subagent question to the orchestrator without ending the subagent's run, and SHALL keep the session open for the reply.

#### Scenario: Question delivered once and pane stays live

- **WHEN** a subagent writes a question sidecar
- **THEN** the orchestrator is notified once with the subagent's name
- **AND** the pane remains open and the session stays parked until the orchestrator replies

#### Scenario: Reply resumes the same run

- **WHEN** the orchestrator replies to a pending question
- **THEN** the reply arrives as the subagent's next turn

### Requirement: Cancellation and pane cleanup

The system SHALL close the subagent's pane when a run ends, is cancelled, or fails to launch, and SHALL tolerate panes that are already gone.

#### Scenario: Cancelled run leaves no state

- **WHEN** a running subagent is cancelled
- **THEN** its watcher stops, its pane is closed, and no running entry, timer, or listener remains

#### Scenario: Launch failure cleans up

- **WHEN** a run fails after a pane was created
- **THEN** that pane is closed before the error is returned

#### Scenario: Cleanup is idempotent

- **WHEN** cleanup runs for a pane that no longer exists
- **THEN** cleanup succeeds and no error is surfaced to the orchestrator

### Requirement: Disappeared pane terminates the run

The system SHALL terminate a run with a bounded, actionable error when the subagent's pane disappears before completion is signalled.

#### Scenario: Pane closed mid-run

- **WHEN** the pane is closed while the subagent is still running
- **THEN** polling stops promptly, the run reports the missing pane, and the running entry is removed

#### Scenario: Late sidecar is still honoured

- **WHEN** the pane disappears but a completion or error sidecar is present
- **THEN** the sidecar determines the result instead of the disappearance error

### Requirement: Session and artifact persistence

The system SHALL give every subagent a deterministic session file and SHALL retain its launch artifacts for debugging.

#### Scenario: Deterministic session file per run

- **WHEN** several subagents are spawned at the same time
- **THEN** each receives a unique session file path known to the orchestrator before launch

#### Scenario: Launch artifacts retained

- **WHEN** a subagent is launched
- **THEN** its rendered launch script is written under the session artifact directory and preserved after the run

### Requirement: Resume a finished or waiting subagent

The system SHALL resume a subagent by name in a fresh pane using its stored session, replaying the sandbox and identity of the original run.

#### Scenario: Resume replays the session and sandbox

- **WHEN** the orchestrator resumes a subagent by name
- **THEN** a fresh pane starts the child with the prior session file and the original tool and extension restrictions
- **AND** the supplied message arrives as the child's next turn

#### Scenario: Unsafe resume is refused

- **WHEN** the stored record cannot replay its restrictions
- **THEN** the resume is refused with an explanation rather than relaunching with the full toolset

### Requirement: Runtime unavailable is actionable

The system SHALL refuse to spawn subagents when the required runtime is unavailable and SHALL tell the user how to make it available.

#### Scenario: Spawn outside the supported runtime

- **WHEN** a spawn is attempted outside a supported runtime
- **THEN** the orchestrator receives an error naming the runtime and the setup step required
