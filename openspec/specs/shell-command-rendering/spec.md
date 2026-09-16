# Shell command rendering Specification

## Purpose

Renders subagent launch commands and completion sentinels for the shell the target pane actually runs, so a child process starts correctly and reports its exit status on macOS zsh, macOS bash, and Windows PowerShell.

## Requirements

### Requirement: Shell family resolution and override

The system SHALL resolve the shell family used to render a launch command, SHALL honour an explicit override, and SHALL validate that the resolved family matches the shell the target pane runs.

#### Scenario: Explicit override wins

- **WHEN** the override setting names a shell family
- **THEN** the system uses that family regardless of platform defaults

#### Scenario: Platform defaults

- **WHEN** no override is set on macOS
- **THEN** the user's configured shell is used when it is zsh or bash, otherwise the platform default
- **AND** when no override is set on Windows, a PowerShell family shell is used

#### Scenario: Pane shell mismatch is refused

- **WHEN** the resolved family does not match the shell running in the target pane
- **THEN** the system fails with an actionable error and sends no command to the pane

#### Scenario: Pane shell is detected from the environment

- **WHEN** the target pane is created
- **THEN** the system determines its shell family from runtime process information rather than assuming it from the operating system

### Requirement: Shell-correct quoting

The system SHALL quote values using the rules of the resolved shell family, and MUST NOT apply one family's quoting rules to another.

#### Scenario: Values survive quoting

- **WHEN** a path or value contains spaces, single or double quotes, `$`, backticks, or `=`
- **THEN** the value reaches the command exactly as provided

#### Scenario: PowerShell-reserved characters survive

- **WHEN** a command is rendered for PowerShell and contains double quotes, `$`, or backticks
- **THEN** the command parses as intended with no PowerShell interpolation or escape expansion

#### Scenario: Non-ASCII values survive

- **WHEN** a value contains non-ASCII characters
- **THEN** the value reaches the command unchanged

### Requirement: Launch script generation

The system SHALL write the launch command to a script artifact whose extension matches the resolved shell family, SHALL invoke it with that shell rather than a hardcoded one, and SHALL retain the artifact.

#### Scenario: Script type matches the family

- **WHEN** the family is POSIX or PowerShell
- **THEN** the launch script uses the corresponding script extension and is invoked through the detected shell

#### Scenario: Long launch commands are not truncated

- **WHEN** the rendered launch command exceeds the pane width
- **THEN** the child starts with the complete command and no argument is dropped or split

#### Scenario: Artifact is retained for debugging

- **WHEN** a launch script is written
- **THEN** it remains available under the session artifact directory after the run ends

### Requirement: Completion sentinel carries the exit status

The system SHALL emit a completion sentinel after the child process exits, on every supported shell family, containing the child's exit status, and the sentinel MUST be emitted even when the child failed.

#### Scenario: Successful exit

- **WHEN** the child exits with status zero
- **THEN** the sentinel reports zero

#### Scenario: Failed exit

- **WHEN** the child exits with a non-zero status
- **THEN** the sentinel reports that exact status

#### Scenario: Large exit codes are carried in full

- **WHEN** a Windows child exits with a multi-digit crash code beyond the POSIX 0–255 range
- **THEN** the sentinel carries the complete code and completion detection matches it

#### Scenario: Sentinel is not suppressed by the wrapper

- **WHEN** the child command fails or the shell would otherwise abort
- **THEN** the sentinel is still emitted

#### Scenario: PowerShell sentinel escapes interpolation correctly

- **WHEN** the sentinel is rendered for PowerShell
- **THEN** the exit status is interpolated with an explicit delimiter so the trailing sentinel characters are not parsed as part of the variable name
- **AND** a missing native exit status falls back to the success or failure of the last command
- **AND** that fallback reports a numeric status, never a boolean or empty value

### Requirement: No Unix-only runtime dependencies

The system SHALL render and run launch commands without requiring Bash, Python, or Unix-only locations, and SHALL NOT assume a POSIX shell on Windows.

#### Scenario: Windows without Bash

- **WHEN** a subagent is launched on a Windows host configured for a PowerShell pane
- **THEN** no part of the launch, sentinel, or artifact path requires Bash, Python, or a Unix-only directory

#### Scenario: Temp and home paths

- **WHEN** the system needs a temporary or home directory for scripts, sentinels, or transcripts
- **THEN** it uses the platform's temp and home locations
