import { mkdtempSync, writeFileSync, renameSync, readFileSync, readdirSync, rmSync, statSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface InteractiveMessage {
  message: string;
  deliverAs: "steer" | "followUp";
  expandPromptTemplates?: boolean;
  skills?: string[];
}

export function createMailbox(parent: string): string {
  return mkdtempSync(join(parent, "pi-ipc-"));
}

function validate(value: InteractiveMessage): InteractiveMessage {
  if (!value || typeof value.message !== "string" || Buffer.byteLength(value.message) > 1024 * 1024 ||
      !["steer", "followUp"].includes(value.deliverAs) ||
      (value.expandPromptTemplates !== undefined && typeof value.expandPromptTemplates !== "boolean") ||
      value.expandPromptTemplates === true ||
      (value.skills !== undefined && (value.deliverAs !== "followUp" || !Array.isArray(value.skills) ||
        value.skills.some(name => typeof name !== "string" || !/^[^\s/:\\]+$/.test(name))))) {
    throw new Error("Invalid interactive message");
  }
  return { message: value.message, deliverAs: value.deliverAs, expandPromptTemplates: false,
    ...(value.skills !== undefined ? { skills: value.skills } : {}) };
}

let sequence = 0;
export function publishMessage(directory: string, message: InteractiveMessage): string {
  const validated = validate(message);
  const id = `${String(Date.now()).padStart(16, "0")}-${String(sequence++).padStart(8, "0")}-${randomUUID()}`;
  const temp = join(directory, `${id}.tmp`);
  writeFileSync(temp, JSON.stringify({ id, ...validated }), { flag: "wx", mode: 0o600 });
  renameSync(temp, join(directory, `${id}.json`));
  return id;
}

export function consumeMessages(directory: string, accept: (message: InteractiveMessage) => void): void {
  for (const name of readdirSync(directory).filter(name => name.endsWith(".json")).sort()) {
    const id = name.slice(0, -5);
    const source = join(directory, name);
    const claim = join(directory, `${id}.claimed`);
    // Claim before calling the API: a reload/crash must never replay uncertain delivery.
    try { linkSync(source, claim); } catch (error: any) {
      if (error.code === "ENOENT") continue;
      if (error.code === "EEXIST") { rmSync(source, { force: true }); continue; }
      throw error;
    }
    unlinkSync(source);
    let receipt: { id: string; status: string; error?: string };
    try {
      if (statSync(claim).size > 1024 * 1024 + 1024) throw new Error("Interactive message exceeds limit");
      const envelope = JSON.parse(readFileSync(claim, "utf8"));
      if (envelope.id !== id) throw new Error("Interactive message identity mismatch");
      accept(validate(envelope));
      receipt = { id, status: "accepted" };
    } catch (error: any) {
      receipt = { id, status: "rejected", error: String(error.message ?? error) };
    }
    writeFileSync(join(directory, `${id}.ack.tmp`), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    renameSync(join(directory, `${id}.ack.tmp`), join(directory, `${id}.ack`));
  }
}

export function closeMailbox(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
