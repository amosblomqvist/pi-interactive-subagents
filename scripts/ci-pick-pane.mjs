/**
 * CI helper: pick the first pane id from `herdr pane list` JSON on stdin.
 *
 * Used by the headless smoke job to supply HERDR_PANE_ID after the named
 * session's server has started. Exits non-zero when no pane is listed.
 */
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
 const panes = JSON.parse(raw)?.result?.panes ?? [];
 if (panes.length === 0) {
  console.error("no panes listed — is the Herdr server running?");
  process.exit(1);
 }
 process.stdout.write(String(panes[0].pane_id));
} catch (error) {
 console.error(`could not parse pane list: ${error?.message ?? error}`);
 process.exit(1);
}
