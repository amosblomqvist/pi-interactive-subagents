/**
 * In-pi panes dashboard — the tmux-free answer to "but where do my
 * subagents live visually?"
 *
 * A persistent, non-capturing overlay mounted through ctx.ui.custom(). While
 * hidden or unfocused it renders live transcripts of every running subagent
 * without stealing a single keystroke from pi's editor. ctrl+alt+p toggles it
 * and focuses it; once focused, keys drive the dashboard (navigate panes,
 * open a composer, steer a subagent — the same subagent_message code path
 * the LLM uses).
 *
 * Compatibility note: built exclusively against pi-tui ≥ 0.65 primitives
 * (hand-rolled line compositing, no HStack/VStack, which are 0.84+).
 * Input routing relies only on TUI's focusedComponent model: a nonCapturing
 * overlay gets no keys until handle.focus() is called, and unfocus() restores
 * the previous focus target (pi's editor).
 */
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Editor, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface PanesEntry {
  id: string;
  name: string;
  agent: string | null;
  /** Live status label ("running 01:23", "waiting_for_user", …). */
  status: string;
  /** Most recent transcript lines, oldest first. */
  transcript: string[];
  /** True when this child runs headless (rpc) rather than in a tmux pane. */
  headless: boolean;
}

export interface PanesHost {
  getEntries(): PanesEntry[];
  /**
   * Deliver a message to the named subagent (steers running children).
   * Reports failure so the composer can tell the user their message was
   * not delivered instead of silently closing on a dead surface.
   */
  steer(name: string, message: string): { ok: true } | { error: string };
}

// ── Layout constants ─────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_LINES_PER_PANE = 6;
const MAX_PANES_RENDERED = 6;
/** Hard cap on total rendered lines; the overlay maxHeight clips the rest. */
const MAX_TOTAL_LINES = 40;

// ── Dashboard component ─────────────────────────────────────────────────────

class PanesDashboard implements Component {
  private host: PanesHost;
  private tui: TUI;
  private theme: any;
  private handle: {
    hide(): void;
    setHidden(hidden: boolean): void;
    focus(): void;
    unfocus(): void;
    isFocused(): boolean;
  } | null = null;
  private selected = 0;
  private composer: Editor | null = null;
  private composingFor: PanesEntry | null = null;
  /** Set when the last composer submit failed; shown in the footer. */
  private steerError: string | null = null;
  private visible = false;
  private disposed = false;

  constructor(host: PanesHost, tui: TUI, theme: any) {
    this.host = host;
    this.tui = tui;
    this.theme = theme;
  }

  setHandle(handle: NonNullable<PanesDashboard["handle"]>): void {
    this.handle = handle;
    // Start hidden: the panes dashboard is opt-in via ctrl+alt+p.
    handle.setHidden(true);
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show(): void {
    if (!this.handle) return;
    this.visible = true;
    this.handle.setHidden(false);
    // Take the keyboard so navigation works immediately.
    this.handle.focus();
    this.tui.requestRender();
  }

  hide(): void {
    if (!this.handle) return;
    this.cancelComposer();
    this.visible = false;
    this.handle.setHidden(true);
    // A hidden overlay must never keep keyboard focus: while focused it
    // would swallow every key (input routes purely by focusedComponent), so
    // release the keyboard back to pi's editor on the way down.
    try {
      if (this.handle.isFocused()) this.handle.unfocus();
    } catch {}
    this.tui.requestRender();
  }

  // ── Component interface ──

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.composer = null;
    this.composingFor = null;
  }

  render(width: number): string[] {
    if (!this.visible) return [];
    const accent = (s: string) => this.theme.fg("accent", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const muted = (s: string) => this.theme.fg("muted", s);

    const entries = this.host.getEntries();
    const lines: string[] = [];

    // Header: ╭─ pi subagents · N running ─...─╮
    const inner = Math.max(0, width - 2);
    const title = `─ pi subagents · ${entries.length} running `;
    const headerText = `${title}${"─".repeat(Math.max(0, inner - title.length))}`;
    lines.push(`${accent("╭")}${headerText.slice(0, inner)}${accent("╮")}`);

    if (this.composer) {
      // Composer mode: the editor fills the overlay body.
      lines.push(...this.composer.render(width - 2).map((l) => `${accent("│")}${l}${accent("│")}`));
    } else if (entries.length === 0) {
      lines.push(...this.borderLine(dim("  No subagents running."), "", width, accent));
    } else {
      const rendered = entries.slice(0, MAX_PANES_RENDERED);
      // Keep the selection inside the rendered window.
      if (this.selected >= rendered.length) this.selected = Math.max(0, rendered.length - 1);
      let budget = MAX_TOTAL_LINES - lines.length - 2;

      rendered.forEach((entry, index) => {
        if (budget <= 0) return;
        const cursor = index === this.selected ? "▸" : " ";
        const agentTag = entry.agent ? dim(` (${entry.agent})`) : "";
        const badge = entry.headless ? muted(" headless") : muted(" tmux");
        const left = ` ${cursor} ${this.theme.fg("toolTitle", entry.name)}${agentTag}${badge}`;
        const right = ` ${entry.status} `;
        lines.push(...this.borderLine(left, right, width, accent));
        budget--;

        const transcriptBudget = Math.min(MAX_TRANSCRIPT_LINES_PER_PANE, Math.max(0, budget - 1));
        const transcript = entry.transcript.slice(-transcriptBudget);
        for (const line of transcript) {
          if (budget <= 0) break;
          const text = line === "" ? "" : truncateToWidth(`  │ ${line}`, Math.max(1, inner - 1));
          const padded = text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
          lines.push(`${accent("│")}${dim(padded)}${accent("│")}`);
          budget--;
        }
      });

      if (entries.length > rendered.length) {
        lines.push(...this.borderLine("", muted(` +${entries.length - rendered.length} more `), width, accent));
      }
    }

    // Footer: the last steer failure if any, else mode hints.
    const footer = this.steerError
      ? `✗ ${this.steerError}`
      : this.composer
        ? " enter send · esc cancel "
        : " tab next · enter compose · esc back · q hide · ctrl+alt+p toggle ";
    lines.push(...this.borderLine("", muted(footer), width, accent));
    lines.push(`${accent("╰")}${"─".repeat(Math.max(0, inner))}${accent("╯")}`);

    return lines;
  }

  private borderLine(
    left: string,
    right: string,
    width: number,
    accent: (s: string) => string,
  ): string[] {
    if (width <= 2) return [`${accent("│")}${accent("│")}`];
    const contentWidth = width - 2;
    const rightVis = visibleWidth(right);
    if (rightVis >= contentWidth) {
      // The right segment alone would overflow the line; tui clips over-wide
      // lines at the declared width, which would slice off the closing
      // border. Truncate the segment instead so the border survives.
      const rightText = truncateToWidth(right, Math.max(0, contentWidth));
      return [
        `${accent("│")}${rightText}${" ".repeat(Math.max(0, contentWidth - visibleWidth(rightText)))}${accent("│")}`,
      ];
    }
    const maxLeft = Math.max(0, contentWidth - rightVis);
    const leftText = truncateToWidth(left, maxLeft);
    const pad = Math.max(0, contentWidth - visibleWidth(leftText) - rightVis);
    return [`${accent("│")}${leftText}${" ".repeat(pad)}${right}${accent("│")}`];
  }

  // ── Input ──

  handleInput(data: string): void {
    if (!this.visible) return;

    if (this.composer) {
      // Escape cancels before the editor ever sees the key.
      if (matchesKey(data, "escape")) {
        this.cancelComposer();
        return;
      }
      this.composer.handleInput(data);
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "down")) {
      const count = Math.max(1, this.host.getEntries().length);
      this.selected = (this.selected + 1) % count;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "up")) {
      const count = Math.max(1, this.host.getEntries().length);
      this.selected = (this.selected - 1 + count) % count;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.openComposer();
      return;
    }
    if (matchesKey(data, "q")) {
      this.hide();
      return;
    }
    // The advertised toggle must work while the dashboard holds focus too —
    // a focused overlay swallows every key, so the shortcut never reaches
    // pi's editor where extension shortcuts are dispatched.
    if (matchesKey(data, "ctrl+alt+p")) {
      this.toggle();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      // Back to pi — dashboard stays visible, keyboard released.
      this.handle?.unfocus();
      return;
    }
  }

  private openComposer(): void {
    const entry = this.host.getEntries()[this.selected];
    if (!entry) return;
    const editor = new Editor(this.tui, {
      borderColor: (s: string) => this.theme.fg("border", s),
      selectList: {
        selectedPrefix: (s: string) => this.theme.fg("accent", s),
        selectedText: (s: string) => this.theme.fg("accent", s),
        description: (s: string) => this.theme.fg("dim", s),
        scrollInfo: (s: string) => this.theme.fg("muted", s),
        noMatch: (s: string) => this.theme.fg("muted", s),
      },
    });
    editor.onSubmit = (text: string) => {
      const message = text.trim();
      if (!message) {
        this.cancelComposer();
        return;
      }
      const result = this.host.steer(entry.name, message);
      if ("error" in result) {
        // Keep the composer open with the typed text intact and surface the
        // failure in the footer — closing here would look exactly like a
        // successful send while the message went nowhere.
        this.steerError = result.error;
        this.tui.requestRender();
        return;
      }
      this.steerError = null;
      this.cancelComposer();
    };
    this.composer = editor;
    this.composingFor = entry;
    this.tui.requestRender();
  }

  private cancelComposer(): void {
    this.composer?.setText("");
    this.composer = null;
    this.composingFor = null;
    this.steerError = null;
    this.tui.requestRender();
  }
}

// ── Module wiring ────────────────────────────────────────────────────────────

/**
 * Singleton dashboard state. One dashboard per process; re-initialized on
 * session_start because pi's resetExtensionUI can unmount extension overlays
 * between sessions. The overlay handle is tracked separately so a re-init
 * can permanently remove the previous overlay from the stack — dispose()
 * alone would leave a stale overlay rendering.
 */
let dashboard: PanesDashboard | null = null;
let activeHandle: {
  hide(): void;
  setHidden(hidden: boolean): void;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
} | null = null;

/**
 * Re-render the dashboard if it is mounted (called on any subagent update).
 * Coalesced to one render per ~250ms: subagent state changes can arrive in
 * bursts (a finishing run emits several events at once), and each render
 * reads pane transcripts — never let that burst turn into a render storm.
 */
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
export function notifyPanesChanged(): void {
  if (!dashboard || renderDebounceTimer) return;
  renderDebounceTimer = setTimeout(() => {
    renderDebounceTimer = null;
    dashboard?.invalidate();
  }, 250);
}

export function isPanesVisible(): boolean {
  return dashboard?.isVisible() ?? false;
}

/** Toggle dashboard visibility — the ctrl+alt+p shortcut handler. */
export function togglePanesDashboard(): void {
  dashboard?.toggle();
}

/**
 * Mount the dashboard for this session. Idempotent: a previous mount (from
 * an earlier session_start or a /reload) is replaced cleanly.
 */
export function initPanesDashboard(
  ctx: {
    hasUI?: boolean;
    ui: {
      custom<T>(
        factory: (
          tui: TUI,
          theme: any,
          keybindings: any,
          done: (result: T) => void,
        ) => Component & { dispose?(): void },
        options?: {
          overlay?: boolean;
          overlayOptions?: unknown;
          onHandle?: (handle: unknown) => void;
        },
      ): Promise<unknown>;
    };
  },
  host: PanesHost,
): void {
  if (!ctx.ui?.custom) return;

  // Remove the previous overlay entirely (hide() splices it from the stack
  // and restores focus) before mounting a fresh one.
  if (activeHandle) {
    try {
      activeHandle.hide();
    } catch {}
    activeHandle = null;
  }
  if (dashboard) {
    dashboard.dispose();
    dashboard = null;
  }

  void ctx.ui.custom(
    (tui, theme, _keybindings, _done) => {
      dashboard = new PanesDashboard(host, tui, theme);
      return dashboard;
    },
    {
      overlay: true,
      overlayOptions: () => ({
        // Full-width strip at the top of the terminal. nonCapturing: the
        // overlay never steals keys on its own — handle.focus() does that
        // explicitly, so pi's editor stays usable while panes are visible.
        anchor: "top-center" as const,
        width: "100%" as const,
        maxHeight: "60%" as const,
        margin: 0,
        nonCapturing: true,
      }),
      onHandle: (handle: unknown) => {
        activeHandle = handle as typeof activeHandle;
        dashboard?.setHandle(handle as NonNullable<PanesDashboard["handle"]>);
      },
    },
  ).catch(() => {
    // Overlay mount failures must never break the session.
    dashboard = null;
  });
}