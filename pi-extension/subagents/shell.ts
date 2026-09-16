/**
 * Shell rendering seam — the only place that knows how each supported shell
 * family quotes values, invokes launch scripts, and emits the completion
 * sentinel. Everything the extension types into a pane's shell is produced
 * here, so macOS zsh, macOS bash, and Windows PowerShell panes all get
 * family-correct text and exit codes survive on every one of them.
 *
 * ShellKind is deliberately coarse: the adapter validates that the pane the
 * runtime actually started runs a shell of the resolved family, so a mismatch
 * is refused with an actionable error before any command is rendered.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename as pathBasename, dirname, join } from "node:path";

/** The two shell families the extension renders for. */
export type ShellKind = "posix" | "powershell";

/** Everything the renderer needs to know about one resolved shell. */
export interface ShellSpec {
 kind: ShellKind;
 /** Executable that runs launch scripts; renderInvocation output starts with it. */
 executable: string;
 /** Argv placed between the executable and the script path (PowerShell hardening flags). */
 invocationArgs: string[];
 /** Script artifact extension, including the dot. */
 scriptExtension: ".sh" | ".ps1";
}

/**
 * Sentinel pattern emitted by the launch line after the child exits. The wait
 * regex is unbounded — Windows exit codes are 32-bit (crash codes such as
 * 3221226505 are ten digits), and a digit-capped pattern would silently never
 * match them. The digit anchor is safe against the echoed launch line: the
 * echo contains the unexpanded shell text, never digits.
 */
export const SUBAGENT_DONE_WAIT_REGEX = "__SUBAGENT_DONE_[0-9]+__";
/** Capturing pattern for a sentinel found in captured pane text. */
export const SUBAGENT_DONE_PATTERN = /__SUBAGENT_DONE_([0-9]+)__/;

/** Extract the exit code from a sentinel embedded in captured pane output. */
export function parseSentinelExitCode(text: string): number | null {
 const match = SUBAGENT_DONE_PATTERN.exec(text);
 if (!match) return null;
 const code = Number.parseInt(match[1], 10);
 return Number.isFinite(code) ? code : null;
}

function posixSpec(executable: string): ShellSpec {
 return {
  kind: "posix",
  executable,
  invocationArgs: [],
  scriptExtension: ".sh",
 };
}

function powershellSpec(executable: string): ShellSpec {
 return {
  kind: "powershell",
  executable,
  invocationArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
  scriptExtension: ".ps1",
 };
}

/** Map a shell name or path to its family; null when unsupported. */
function shellFamilyOf(value: string): ShellKind | null {
 const base = pathBasename(value)
  .replace(/\.exe$/i, "")
  .toLowerCase();
 if (base === "powershell" || base === "pwsh") return "powershell";
 if (base === "zsh" || base === "bash" || base === "sh") return "posix";
 return null;
}

function defaultPosixExecutable(base: string): string {
 switch (base) {
  case "zsh":
   return "/bin/zsh";
  case "bash":
   return "/bin/bash";
  default:
   return "/bin/sh";
 }
}

function specFromOverride(value: string): ShellSpec {
 const kind = shellFamilyOf(value);
 if (!kind) {
  throw new Error(
   `Unsupported PI_SUBAGENT_SHELL value "${value}". Use zsh, bash, sh, powershell, or pwsh (optionally a full path).`,
  );
 }
 const base = pathBasename(value)
  .replace(/\.exe$/i, "")
  .toLowerCase();
 const isPath = /[/\\]/.test(value);
 if (kind === "powershell") {
  let executable = value;
  if (!isPath) executable = base === "pwsh" ? "pwsh.exe" : "powershell.exe";
  return powershellSpec(executable);
 }
 return posixSpec(isPath ? value : defaultPosixExecutable(base));
}

/**
 * Resolve the shell family used to render launch commands, in order:
 * PI_SUBAGENT_SHELL override → macOS $SHELL when it is zsh/bash → platform
 * default (/bin/zsh on macOS, /bin/bash elsewhere POSIX, PowerShell on
 * Windows). Platform and env are injectable so every branch is testable on
 * any host.
 */
export function resolveShellSpec(
 options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): ShellSpec {
 const env = options.env ?? process.env;
 const platform = options.platform ?? process.platform;
 const override = env.PI_SUBAGENT_SHELL?.trim();
 if (override) return specFromOverride(override);
 if (platform === "win32") return powershellSpec("powershell.exe");
 if (platform === "darwin") {
  const shell = env.SHELL ?? "";
  if (shell.endsWith("/zsh") || shell.endsWith("/bash"))
   return posixSpec(shell);
  return posixSpec("/bin/zsh");
 }
 return posixSpec("/bin/bash");
}

/**
 * Quote a single argument with the resolved family's rules. Both families
 * wrap in single quotes, but their escape rules differ and are NOT
 * interchangeable: POSIX closes and reopens the quote ('\''), PowerShell
 * doubles the quote (''). PowerShell single-quoted strings are literal, so
 * $, backticks, and double quotes need no further escaping there.
 */
export function quoteArg(kind: ShellKind, value: string): string {
 if (kind === "powershell") return "'" + value.replace(/'/g, "''") + "'";
 return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The statement appended to the launch line that emits the completion
 * sentinel carrying the child's exit status.
 *
 * PowerShell must brace the variable — "$LASTEXITCODE__" parses as a single
 * identifier and silently emits no digits. A $null native exit status falls
 * back to $? mapped to digits first ($code = if ($?) { 0 } else { 1 }) —
 * interpolating $? directly would emit __SUBAGENT_DONE_True__, which the
 * digit-anchored wait regex never matches. Negative Windows exit codes (crash
 * statuses read back as signed ints) are normalized into their unsigned
 * NTSTATUS form so the sentinel always carries digits.
 */
export function renderSentinelStatement(kind: ShellKind): string {
 if (kind === "powershell") {
  return (
   "$code = $LASTEXITCODE; " +
   "if ($null -eq $code) { $code = if ($?) { 0 } else { 1 } }; " +
   "if ($code -lt 0) { $code += 4294967296 }; " +
   'Write-Output "__SUBAGENT_DONE_${code}__"'
  );
 }
 return `printf '__SUBAGENT_DONE_%s__\\n' "$?"`;
}

/** Render the command line that runs a launch script in the pane. */
export function renderInvocation(spec: ShellSpec, scriptPath: string): string {
 return [
  spec.executable,
  ...spec.invocationArgs,
  quoteArg(spec.kind, scriptPath),
 ].join(" ");
}

/** The full launch line: run the script, then emit the sentinel. */
export function renderLaunchLine(spec: ShellSpec, scriptPath: string): string {
 return `${renderInvocation(spec, scriptPath)}; ${renderSentinelStatement(spec.kind)}`;
}

/**
 * Generate the launch script body: run the child command, then exit with its
 * status so the sentinel statement appended to the launch line reports the
 * child's code. No `set -e` and no error-suppressing constructs — the wrapper
 * must never swallow the child's failure, and the sentinel must not be
 * suppressed when the child fails.
 */
export function generateLaunchScript(
 spec: ShellSpec,
 childCommand: string,
 options: { preamble?: string } = {},
): string {
 const lines: string[] = [];
 if (spec.kind === "posix") lines.push("#!/bin/sh");
 if (options.preamble) lines.push(options.preamble.trimEnd());
 lines.push(childCommand);
 if (spec.kind === "powershell") {
  lines.push(
   "$code = $LASTEXITCODE",
   "if ($null -eq $code) { $code = if ($?) { 0 } else { 1 } }",
   "exit $code",
  );
 } else {
  lines.push('exit "$?"');
 }
 return lines.join("\n") + "\n";
}

/**
 * Write the launch script into `dir` with the family-correct extension and
 * return its path. Artifacts stay on disk after the run for debugging.
 */
export function writeLaunchScript(
 spec: ShellSpec,
 dir: string,
 childCommand: string,
 options: { baseName?: string; preamble?: string } = {},
): string {
 const scriptPath = join(
  dir,
  `${options.baseName ?? "subagent"}${spec.scriptExtension}`,
 );
 mkdirSync(dirname(scriptPath), { recursive: true });
 writeFileSync(scriptPath, generateLaunchScript(spec, childCommand, options), {
  mode: 0o755,
 });
 return scriptPath;
}
