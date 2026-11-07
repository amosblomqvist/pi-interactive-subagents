/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents request shutdown
 * only after the complete run settles (see the `agent_settled` handler);
 * non-auto-exit agents remain available for RPC follow-up messages until terminated.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createSubagentActivityRecorder } from "./activity.ts";
import { summarizeToolActivity, sanitizeMonitorText } from "./monitor.ts";
import { consumeMessages } from "./interactive-ipc.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const rawMaxTurns = process.env.PI_SUBAGENT_MAX_TURNS;
  const maxTurns = rawMaxTurns ? Number(rawMaxTurns) : undefined;
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) throw new Error("Invalid PI_SUBAGENT_MAX_TURNS");
  let turns = 0;
  let turnLimitReached = false;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Only `input` clears it:
  // child-result custom messages can trigger their own agent runs without
  // answering the question, while RPC prompt/steer replies do emit `input`.
  let awaitingAnswer = false;
  let latestAgentMessages: any[] | undefined;
  let shutdownRequested = false;
  let shuttingDown = false;
  let inputReader: ReturnType<typeof setInterval> | undefined;
  const mailbox = process.env.PI_SUBAGENT_IPC_DIR;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    latestAgentMessages = undefined;
    shutdownRequested = false;
    shuttingDown = false;
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
    if (inputReader) clearInterval(inputReader);
    if (mailbox) {
      if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY) {
        const errorMessage = "Interactive subagent requires Pi TUI on a real PTY";
        if (process.env.PI_SUBAGENT_SESSION) writeFileSync(`${process.env.PI_SUBAGENT_SESSION}.exit`, JSON.stringify({ type: "error", errorMessage }));
        ctx.shutdown();
        throw new Error(errorMessage);
      }
      inputReader = setInterval(() => {
        if (shutdownRequested || shuttingDown) return;
        try {
          consumeMessages(mailbox, ({ message, deliverAs, skills }) => {
            const blocks = (skills ?? []).map(name => {
              const skill = pi.getCommands().find(command => command.source === "skill" && command.name === `skill:${name}`);
              if (!skill) throw new Error(`Bootstrap skill is not loaded: ${name}`);
              const path = skill.sourceInfo.path;
              return `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${stripFrontmatter(readFileSync(path, "utf8")).trim()}\n</skill>`;
            });
            // One literal prompt prevents async slash expansion from racing the task/auth startup.
            pi.sendUserMessage([...blocks, message].join("\n\n"), { deliverAs, expandPromptTemplates: false });
          });
        } catch (error: any) {
          clearInterval(inputReader);
          if (process.env.PI_SUBAGENT_SESSION) writeFileSync(`${process.env.PI_SUBAGENT_SESSION}.exit`, JSON.stringify({ type: "error", errorMessage: `Interactive IPC failed: ${error.message}` }));
          ctx.shutdown();
        }
      }, 40);
      try {
        writeFileSync(join(mailbox, "ready.tmp"), JSON.stringify({ mode: "tui" }), { mode: 0o600 });
        renameSync(join(mailbox, "ready.tmp"), join(mailbox, "ready"));
      } catch (error) {
        clearInterval(inputReader);
        ctx.shutdown();
        throw error;
      }
    }
  });

  pi.on("input", () => {
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_settled would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // Do not clear awaitingAnswer here. Extension-injected child handoffs can
    // start a run without being the parent's answer; only the input event is
    // evidence that an RPC/user reply actually arrived.
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    latestAgentMessages = (event as any).messages as any[] | undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (shuttingDown || shutdownRequested) return;
    if (turnLimitReached) {
      const errorMessage = `Subagent turn limit reached (${maxTurns}); work is incomplete. Resume starts a new bounded process.`;
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage }));
      recorder.agentEndWaiting("turn limit reached");
      shutdownRequested = true;
      ctx.shutdown();
      return;
    }
    // Pi emits agent_end before automatic retries, compaction recovery, and
    // queued follow-ups. Publishing terminal state there lets the parent
    // watcher kill the process before those continuations finish.
    const messages = latestAgentMessages;
    const pendingChildren = runningChildrenCount();
    const hasPendingChildren = pendingChildren > 0;
    const shouldExit =
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      // ctx.shutdown() is deferred by Pi until the session is idle. Guard the
      // request as well as session_shutdown so a duplicate/stale settled event
      // cannot request shutdown twice with a context that is being retired.
      shutdownRequested = true;
      try {
        ctx.shutdown();
      } catch (error) {
        // A rejected request did not schedule shutdown. Let a later settled
        // event retry with its fresh context and keep this error observable to
        // Pi's extension error reporting.
        shutdownRequested = false;
        throw error;
      }
      return;
    }

    let reason = awaitingAnswer ? "parent answer" : autoExit ? "aborted turn" : "interactive input";
    if (!awaitingAnswer && hasPendingChildren) {
      const getNames = (globalThis as any)[Symbol.for("pi-subagents/running-children-names")];
      let names: string[] = [];
      try {
        const value = typeof getNames === "function" ? getNames() : [];
        if (Array.isArray(value)) names = value.filter((name): name is string => typeof name === "string").slice(0, 3);
      } catch {}
      reason = sanitizeMonitorText(`children (${pendingChildren})${names.length ? `: ${names.join(", ")}` : ""}`, 200);
    }
    recorder.agentEndWaiting(reason);
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest settled run completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event, ctx) => {
    recorder.turnEnd((event as any).turnIndex);
    turns += 1;
    if (maxTurns !== undefined && turns >= maxTurns) {
      turnLimitReached = true;
      ctx.abort();
    }
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart(
      (event as any).toolCallId,
      (event as any).toolName,
      summarizeToolActivity((event as any).toolName, (event as any).args),
    );
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall(
      (event as any).toolCallId,
      (event as any).toolName,
      summarizeToolActivity((event as any).toolName, (event as any).input),
    );
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    shuttingDown = true;
    if (inputReader) clearInterval(inputReader);
    inputReader = undefined;
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) one focused question and pause until they reply. " +
      "Use this only when a material ambiguity, blocker, or coordinator-only decision prevents safe progress. " +
      "Resolve local, reversible implementation choices yourself; do not ask for routine confirmation. " +
      "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated blocking questions.",
    promptSnippet:
      "Ask the orchestrator one focused question only when a material blocker or coordinator-only decision prevents safe progress; otherwise choose a reversible default and continue.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple blocking things, make separate ask_question calls instead of bundling them.",
      "Resolve ordinary implementation choices and other recoverable uncertainty without asking.",
      "Use it when requirements are materially ambiguous, work is blocked, or only the orchestrator can decide.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait — the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      // The parent removes the sidecar after delivering the notification, not
      // after receiving an answer. Keep an in-memory pending bit as the source
      // of truth so the model cannot ask a second question in that interval.
      if (awaitingAnswer) {
        throw new Error(
          "This subagent already has a pending question; wait for the orchestrator's reply before asking another.",
        );
      }

      // Set this before publishing the sidecar so a fast parent watcher cannot
      // observe the question before auto-exit is suppressed for this turn.
      awaitingAnswer = true;
      try {
        // Exclusive creation prevents a second unanswered question from
        // replacing the first one while the parent is deciding how to reply.
        writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData), { encoding: "utf8", flag: "wx" });
      } catch (error: any) {
        awaitingAnswer = false;
        if (error?.code === "EEXIST") {
          throw new Error(
            "This subagent already has a pending question; wait for the orchestrator's reply before asking another.",
          );
        }
        throw error;
      }

      // Keep the session open: park in the "waiting" phase. The parent's
      // watcher picks up the `.ask` signal and notifies the orchestrator, who
      // replies via subagent_message.
      recorder.askQuestion();

      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
