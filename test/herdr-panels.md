# Native Herdr panels

## Scope

The Herdr backend starts each Pi child in a native core terminal.
Herdr shows that terminal in its own pane.
There is no transcript viewer, tmux process, or util-linux `script` wrapper on this path.
The existing mailbox carries instructions between the coordinator and each child.

`PI_SUBAGENT_SURFACE_BACKEND=herdr` selects this backend for the interactive-subagents extension.
The default remains `process`.
This change does not install the extension or replace another subagent runtime.

The backend uses the caller's `HC_TERMINAL_ID` to find its tab.
It does not use the focused pane as a fallback.
`PI_SUBAGENT_HERDR_TAB` can select another existing local tab explicitly.
Invalid or remote targets fail before launch.
Each child has an ownership label and a core parent.
Core notifications are disabled because the extension delivers results itself.

## Authorized app test

**This test controls the running Herdr app. Get the user's authorization before execution.**
It creates a temporary tab, starts two Pi processes, sends instructions, and closes its own resources.
It restores the original tab and focus.
Do not run multiple copies concurrently.

The test uses separate temporary homes and a local synthetic provider.
It does not use credentials or paid models.
The normal integration suite skips this test.

From the repository root, run:

```sh
PI_TEST_HERDR=1 \
PI_TEST_CLI=/home/imanol/.local/share/pi-node/node-v22.23.2-linux-x64-1.5.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
PI_TEST_HERDR_EVIDENCE="$PWD/.git/herdr-panels-working.png" \
node --test test/integration/herdr-panels.test.ts
```

`PI_TEST_CLI` must refer to the package's `dist/cli.js`, not `dist/bundle/cli.js`.
The optional screenshot requires the existing Python Pillow package.
Without `PI_TEST_HERDR_EVIDENCE`, the test discards its screenshot.

The test checks:

- Two distinct native terminals with real Pi TUI input and output.
- Two simultaneous panes in the requested tab.
- The correct core parent, process ID, and disabled core notifications.
- Multiline instructions through the coordinator's mailbox.
- Cancellation of one child without cancellation of its sibling.
- Direct terminal input that Pi identifies as interactive input.
- Cleanup and unchanged settings, keys, and layout files.

## Limits

Verification covers Linux, Pi 1.5.0, and the locally installed Herdr app and core.
It does not verify remote machines, live model providers, or installation into the active harness.
Agent profile migration remains separate work.
