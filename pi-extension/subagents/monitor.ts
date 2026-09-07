import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

export type SubagentMonitorEventKind = "assistant" | "tool" | "result" | "error";

export interface SubagentMonitorEvent {
  kind: SubagentMonitorEventKind;
  text: string;
  timestamp?: string;
}

const MAX_SESSION_TAIL_BYTES = 512 * 1024;
const MAX_EVENT_TEXT_LENGTH = 240;
const SHELL_TOOLS = new Set(["bash", "powershell", "safe_bash"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, ...names: string[]): string | undefined {
  if (!record) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function redactUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of url.searchParams.keys()) {
      if (/token|secret|password|passwd|api[-_]?key|authorization/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

/** Remove terminal control sequences and common inline credentials before display. */
export function sanitizeMonitorText(value: unknown, maxLength = MAX_EVENT_TEXT_LENGTH): string {
  if (value == null) return "";
  let text = String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/https?:\/\/[^\s]+/gi, (url) => redactUrl(url))
    .replace(/\b(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(
      /\b(api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret)(\s*[:=]\s*)([^\s,;&]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/(\s--?(?:api[-_]?key|token|password|passwd|secret)\s+)(\S+)/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]{0,40}PRIVATE KEY-----.*?(?:-----END [^-]{0,40}PRIVATE KEY-----|$)/gi, "[private key redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[token redacted]")
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, "[credential redacted]");

  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Build a compact, allowlisted description of a tool call without dumping arbitrary arguments. */
export function summarizeToolActivity(toolName: string, args: unknown): string | undefined {
  const input = asRecord(args);
  let summary: string | undefined;

  if (SHELL_TOOLS.has(toolName)) {
    summary = stringField(input, "command");
  } else {
    switch (toolName) {
      case "read":
      case "write":
      case "edit":
      case "ls":
        summary = stringField(input, "path");
        break;
      case "grep": {
        const pattern = stringField(input, "pattern");
        const path = stringField(input, "path");
        summary = [pattern, path ? `in ${path}` : undefined].filter(Boolean).join(" ");
        break;
      }
      case "find": {
        const pattern = stringField(input, "pattern");
        const path = stringField(input, "path");
        summary = [pattern, path ? `in ${path}` : undefined].filter(Boolean).join(" ");
        break;
      }
      case "web_fetch":
        summary = stringField(input, "url");
        break;
      case "subagent": {
        const agent = stringField(input, "agent", "name");
        const task = stringField(input, "task");
        summary = [agent, task].filter(Boolean).join(": ");
        break;
      }
      case "subagent_message":
        summary = stringField(input, "name");
        break;
      case "ask_user_question":
      case "ask_question":
        summary = stringField(input, "question");
        break;
      default:
        summary = stringField(input, "path", "url");
        break;
    }
  }

  const sanitized = sanitizeMonitorText(summary, 180);
  return sanitized || undefined;
}

function readSessionTail(sessionFile: string): string[] {
  if (!existsSync(sessionFile)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_SESSION_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim());
  } catch {
    return [];
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean);
}

function meaningfulLine(text: string, fromEnd = false): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return sanitizeMonitorText(fromEnd ? lines.at(-1) : lines[0]);
}

/** Read a human-oriented timeline from persisted messages, deliberately skipping thinking blocks. */
export function readRecentSubagentEvents(
  sessionFile: string,
  maxEvents = 8,
  sinceMs?: number,
): SubagentMonitorEvent[] {
  const events: SubagentMonitorEvent[] = [];

  for (const line of readSessionTail(sessionFile)) {
    let entry: Record<string, unknown> | null = null;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    const role = stringField(message, "role");
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (sinceMs != null && Number.isFinite(timestampMs) && timestampMs < sinceMs) continue;

    if (role === "assistant" && Array.isArray(message?.content)) {
      for (const rawBlock of message.content) {
        const block = asRecord(rawBlock);
        if (block?.type === "toolCall" && typeof block.name === "string") {
          const detail = summarizeToolActivity(block.name, block.arguments);
          events.push({
            kind: "tool",
            text: detail ? `${block.name} · ${detail}` : block.name,
            timestamp,
          });
        } else if (block?.type === "text" && typeof block.text === "string") {
          const text = meaningfulLine(block.text);
          if (text) events.push({ kind: "assistant", text, timestamp });
        }
      }
      continue;
    }

    if (role !== "toolResult") continue;
    const toolName = stringField(message, "toolName") ?? "tool";
    const isError = message?.isError === true;
    const output = textBlocks(message?.content).join("\n");
    const detail = isError
      ? meaningfulLine(output)
      : SHELL_TOOLS.has(toolName)
        ? meaningfulLine(output, true)
        : "completed";
    events.push({
      kind: isError ? "error" : "result",
      text: detail ? `${toolName} · ${detail}` : toolName,
      timestamp,
    });
  }

  return events.slice(-Math.max(1, maxEvents));
}
