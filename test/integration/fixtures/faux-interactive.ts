import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export default async function (pi: ExtensionAPI) {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(process.env.PI_TEST_FAUX!).href);
  const faux = fauxProvider({ provider: "interactive-faux", models: [{ id: "local" }] });
  if (process.env.PI_TEST_POLICY) {
    faux.setResponses(Array.from({ length: 6 }, () => (context: unknown) => {
      appendFileSync(`${process.env.PI_TEST_POLICY}.requests`, "request\n");
      writeFileSync(process.env.PI_TEST_POLICY!, JSON.stringify({ context, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(), active: pi.getActiveTools(), registered: pi.getAllTools().map(tool => tool.name), skills: pi.getCommands().filter(command => command.source === "skill") }));
      return fauxAssistantMessage(fauxToolCall("read", { path: process.env.PI_TEST_POLICY_READ }), { stopReason: "toolUse" });
    }));
  } else if (process.env.PI_TEST_SIMPLE === "1") {
    faux.setResponses([(context: unknown) => {
      if (process.env.PI_TEST_FIRST_CONTEXT && !existsSync(process.env.PI_TEST_FIRST_CONTEXT)) writeFileSync(process.env.PI_TEST_FIRST_CONTEXT, JSON.stringify(context));
      return fauxAssistantMessage(`## Handoff\nStatus: complete\nSummary:\n${JSON.stringify(context)}\nFiles:\n- None.\nVerification:\n- Offline TUI.\nRisks/Blockers:\n- None.\nNext:\n- None.`);
    }]);
  } else faux.setResponses([
    async () => {
      writeFileSync(process.env.PI_TEST_STARTED!, "started");
      await new Promise(resolve => setTimeout(resolve, 500));
      return fauxAssistantMessage(fauxToolCall("ask_question", { question: "Which contract?" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Waiting for parent."),
    (context: unknown) => fauxAssistantMessage(`FINAL_CONTEXT ${JSON.stringify(context)}`),
  ]);
  pi.registerProvider(faux.provider);
  pi.registerCommand("danger", { description: "must not execute", handler: async () => { writeFileSync(process.env.PI_TEST_DANGER!, "executed"); } });
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(process.env.PI_TEST_MODE!, JSON.stringify({ mode: ctx.mode, stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }));
  });
  pi.on("input", event => { appendFileSync(process.env.PI_TEST_INPUTS!, JSON.stringify(event) + "\n"); });
  pi.on("agent_settled", () => { appendFileSync(process.env.PI_TEST_SETTLED!, "settled\n"); });
}
