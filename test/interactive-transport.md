# Interactive transport verification

## Scope

Pi children use interactive mode, not `--mode rpc`, for launch and resume.
The temporary terminal backend requires Linux and util-linux `script`.
It does not open Herdr panels.
Herdr integration and agent profile changes are separate work.

Each launch has a private mailbox.
The child confirms readiness after it checks TUI mode and terminal input/output.
The parent waits for an acknowledgement for each instruction.
An acknowledgement confirms an API submission, not model execution or task completion.
A timeout reports uncertain delivery and does not cause an automatic retry.
A claim prevents message replay after a crash, but cannot guarantee delivery across that crash.

The child combines loaded skills and the initial task into one literal message.
Steering preserves line breaks and does not execute slash commands.
Resume removes the previous process's exit sidecar before it starts the new process.

## Run the checks

From the repository root, run:

```sh
npm run typecheck
npm test
npm run test:integration
```

The real Pi test requires an explicit CLI path.
Use the package's `dist/cli.js`, not `dist/bundle/cli.js`.
For the verified local Pi 1.5.0 installation, run:

```sh
PI_TEST_CLI=/home/imanol/.local/share/pi-node/node-v22.23.2-linux-x64-1.5.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
node --test test/integration/interactive-tui.test.ts
```

The fixture uses an isolated home, a private configuration directory, and a local synthetic provider.
It does not use credentials or a paid model.
It checks real TUI mode and terminal input/output, instructions, question/answer handling, and final shutdown.
It also checks launch/resume, skill order in the first request, and a stale exit sidecar.

## Verified result

Pi 1.5.0 and Node 22.23.2 passed the explicit test.
The unit suite passed 237 tests and skipped one.
The integration suite passed 17 tests and skipped one without the explicit CLI path.
Type checking passed.
These results do not verify a visible Herdr panel or live provider behavior.
