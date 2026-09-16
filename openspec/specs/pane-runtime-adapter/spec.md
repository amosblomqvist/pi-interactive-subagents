# Pane runtime adapter Specification

## Purpose

The terminal multiplexer seam: detect the runtime, create child panes without disturbing the user's focus, supply working directory and environment at pane creation, read and wait on terminal output, submit text, close panes, and normalize runtime failures into actionable codes.

## Requirements

### Requirement: Runtime detection and setup guidance

The system SHALL detect that it is running inside a supported multiplexer pane with a reachable runtime before performing any pane operation, and MUST NOT control a session it was not started in.

#### Scenario: Inside a supported runtime

- **WHEN** the process runs inside a supporting pane and the runtime is reachable
- **THEN** the system reports the runtime as available

#### Scenario: Outside the runtime

- **WHEN** the process is not running inside a supporting pane
- **THEN** the system reports the runtime as unavailable and provides the setup step to run pi inside that runtime
- **AND** it does not attach to or control another focused session

#### Scenario: Unsupported runtime version

- **WHEN** the runtime is reachable but lacks features the system requires
- **THEN** the system fails with an upgrade message naming the missing capability instead of running partially

#### Scenario: Detection without a POSIX shell

- **WHEN** the host has no POSIX shell available on the command path
- **THEN** runtime detection still succeeds

### Requirement: Panes are created for the calling pane without stealing focus

The system SHALL create each subagent pane as a split of the pane that is running pi, and MUST NOT change which pane the user has focused.

#### Scenario: Focus stays on the caller

- **WHEN** a subagent pane is created while the user's focus is on a different pane
- **THEN** the new pane is created relative to the calling pane
- **AND** the user's focused pane is unchanged after creation

#### Scenario: Repeated creation keeps focus

- **WHEN** several panes are created in sequence
- **THEN** the user's focused pane is unchanged after each creation and after each close

### Requirement: Working directory and environment are applied at creation

The system SHALL pass the child's working directory and environment to pane creation instead of emitting shell syntax to change them.

#### Scenario: Values survive unchanged

- **WHEN** the child working directory or an environment value contains spaces, quotes, `$`, backticks, or `=`
- **THEN** the child process observes the exact value

#### Scenario: Runtime-managed variables stay authoritative

- **WHEN** a caller-supplied environment entry conflicts with a runtime-managed variable
- **THEN** the runtime's own value is preserved for the child

### Requirement: Pane identity is validated

The system SHALL read the created pane's identifier from the runtime response and MUST reject a malformed or missing identifier.

#### Scenario: Identifier returned by creation

- **WHEN** pane creation succeeds
- **THEN** the returned identifier is validated and used for all later operations on that pane

#### Scenario: Malformed creation response

- **WHEN** the creation response omits or malforms the pane identifier
- **THEN** the system reports an error and does not proceed with an unusable handle

### Requirement: Text submission to a pane

The system SHALL submit shell commands as a single pre-rendered text and SHALL submit interactive text and keys atomically, preserving the caller's characters exactly.

#### Scenario: Command executes once with characters preserved

- **WHEN** a single pre-quoted command containing spaces, quotes, `$`, backticks, apostrophes, or `=` is submitted to a pane
- **THEN** the command executes exactly once and produces the intended output

#### Scenario: Long single-line command is not corrupted

- **WHEN** a command line longer than the pane width is submitted
- **THEN** the pane receives the whole line unchanged

#### Scenario: Multi-line text does not execute early

- **WHEN** multi-line text is sent to a pane without a submit key
- **THEN** the pane receives the text without executing any line until enter is sent

### Requirement: Screen reads are plain and unwrapped

The system SHALL read a pane's recent output as plain text that ignores soft wrapping, and MUST NOT include terminal escape sequences or a protocol envelope in that text.

#### Scenario: Tail read is plain

- **WHEN** the system reads the last N lines of a pane
- **THEN** the result contains those logical lines without escape sequences, carriage returns, or wrapper syntax

#### Scenario: Long output lines remain searchable

- **WHEN** a pane has emitted a long line that the terminal soft-wrapped
- **THEN** the read returns it as one logical line that can be matched without wrapping artifacts

### Requirement: Output waits

The system SHALL be able to wait for a pattern in a pane's output server-side, checking existing output immediately and honouring a timeout.

#### Scenario: Pattern already present

- **WHEN** the waited-for pattern already exists in the pane's output
- **THEN** the wait completes promptly

#### Scenario: Timeout expires

- **WHEN** the pattern does not appear before the wait timeout
- **THEN** the wait fails with a timeout code that the caller can distinguish from a missing pane

### Requirement: Errors are normalized into actionable codes

The system SHALL classify runtime failures into stable codes instead of passing through raw process output.

#### Scenario: Missing pane

- **WHEN** an operation targets a pane that no longer exists
- **THEN** the failure is reported with a not-found code that callers treat as terminal

#### Scenario: Retryable busy state

- **WHEN** the runtime reports that a pane is not yet an available shell
- **THEN** the failure is reported with a distinct code that callers may retry

#### Scenario: Usage error

- **WHEN** the runtime rejects an invocation as invalid
- **THEN** the failure is reported separately from runtime errors so it can be treated as an internal or version defect

#### Scenario: Error payload is parsed

- **WHEN** the runtime reports a failure as structured data on its error stream
- **THEN** the system parses that payload rather than matching human-readable text

### Requirement: Cross-platform path handling

The system SHALL build temporary, home, and artifact paths using platform-aware path handling, and MUST NOT require Unix-only locations or separators.

#### Scenario: Windows paths with spaces

- **WHEN** temporary and artifact paths contain backslashes and spaces on Windows
- **THEN** sentinel, script, and transcript files are created and found correctly

#### Scenario: No Unix-only locations

- **WHEN** the system needs a temporary or home directory
- **THEN** it uses the platform's temp and home locations rather than fixed Unix paths
