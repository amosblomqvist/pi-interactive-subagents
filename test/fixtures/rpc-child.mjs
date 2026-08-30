/**
 * Fake `pi --mode rpc` child for RpcClient integration tests.
 *
 * Speaks the same protocol: LF-delimited JSON on stdin/stdout. Framing here is
 * hand-rolled (NOT readline) so payloads containing U+2028/U+2029 survive —
 * that is exactly what the client under test must handle.
 *
 * Commands:
 *   {"type":"ping"}                       → response (success)
 *   {"type":"prompt","message":...}       → response + agent_start/agent_end
 *   {"type":"emit-u2028"}                 → message_end with U+2028 inside
 *   {"type":"die"}                        → exit code 3
 *   {"type":"get_last_assistant_text"}    → response (the reap-nudge command)
 */

let buf = "";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const idx = buf.indexOf("\n");
    if (idx === -1) break;
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
// Stay alive until the parent closes stdin or kills us.
process.stdin.on("end", () => {});

function handle(msg) {
  switch (msg.type) {
    case "ping":
      out({ type: "response", id: msg.id, command: "ping", success: true, data: { pong: true } });
      break;
    case "prompt":
      // Messages starting with "fail:" simulate session.prompt() throwing in
      // real pi (no model, no API key, agent busy): an id-echoed rejection.
      if (String(msg.message).startsWith("fail:")) {
        out({
          type: "response",
          id: msg.id,
          command: "prompt",
          success: false,
          error: "simulated rejection: " + msg.message.slice(5),
        });
        break;
      }
      out({ type: "response", id: msg.id, command: "prompt", success: true });
      out({ type: "agent_start" });
      out({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `echo: ${msg.message}` }],
        },
      });
      out({ type: "agent_end", willRetry: false });
      break;
    case "emit-u2028":
      // U+2028 LINE SEPARATOR inside a JSON string — Node's readline would
      // split this into two broken lines. The client must not.
      out({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `a${String.fromCharCode(0x2028)}b` }],
        },
      });
      break;
    case "get_last_assistant_text":
      out({
        type: "response",
        id: msg.id,
        command: "get_last_assistant_text",
        success: true,
        data: { text: "last assistant text" },
      });
      break;
    case "garbage":
      // Non-JSON line on the RPC channel — the client must ignore it, not
      // crash, and keep processing subsequent messages.
      process.stdout.write("this is not json\n");
      break;
    case "die":
      process.exit(3);
      break;
    default:
      break;
  }
}