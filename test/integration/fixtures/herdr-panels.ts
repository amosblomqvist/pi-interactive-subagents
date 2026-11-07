import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function (pi: ExtensionAPI) {
  const root = process.env.PI_TEST_PANEL_DIR!;
  const role = process.env.PI_TEST_PANEL_ROLE!;
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(process.env.PI_TEST_FAUX!).href);
  const provider = fauxProvider({ provider: "herdr-faux", models: [{ id: "local" }] });
  provider.setResponses([
    async () => {
      writeFileSync(join(root, "working"), role);
      await new Promise<void>((resolve, reject) => {
        const release = join(root, "release");
        const watcher = watch(root, check);
        const timer = setTimeout(() => { watcher.close(); reject(new Error("Test gate deadline exceeded")); }, 45000);
        function check() {
          if (existsSync(release)) { watcher.close(); clearTimeout(timer); resolve(); }
        }
        check();
      });
      return fauxAssistantMessage(`${role}: tarea sintética terminada. Sin acceso a red ni modelos de pago.`);
    },
    () => fauxAssistantMessage(`${role}: instrucción recibida.\n${readFileSync(join(root, "inputs"), "utf8")}`),
  ]);
  pi.registerProvider(provider.provider);
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(join(root, "mode"), JSON.stringify({ mode: ctx.mode, stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }));
  });
  pi.on("input", event => { appendFileSync(join(root, "inputs"), JSON.stringify({ text: event.text, source: event.source }) + "\n"); });
  pi.on("agent_settled", () => { appendFileSync(join(root, "settled"), "settled\n"); });
}
