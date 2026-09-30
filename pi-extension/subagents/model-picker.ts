import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";

/** Structural view of the pi theme, so this module does not import a mode-internal type. */
export interface ModelPickerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** One selectable row in the model picker. */
export interface ModelPickerItem {
  /** Value persisted when this row is chosen. */
  value: string;
  /** Row text shown to the user. */
  label: string;
  /** Plain text the fuzzy filter matches against. */
  searchText: string;
  /** Marks the row that is currently configured for the target. */
  current?: boolean;
}

/** Minimal registry-model shape needed to build picker rows. */
export interface ModelPickerModel {
  provider: string;
  id: string;
  name?: string;
}

export interface BuildModelPickerItemsInput {
  models: readonly ModelPickerModel[];
  /** Currently configured token for the target, or null when unset. */
  currentValue: string | null;
  /** Rows shown before the model list, such as inherit and reset. */
  leadingItems?: readonly ModelPickerItem[];
}

export interface ModelPickerOptions {
  title: string;
  items: readonly ModelPickerItem[];
  /** List rows kept on screen; the selected row stays centered in the window. */
  maxVisible?: number;
}

const DEFAULT_MAX_VISIBLE = 10;
const SELECTED_CURSOR = "→ ";
const UNSELECTED_CURSOR = "  ";
const CURRENT_MARKER = "● ";
const BLANK_MARKER = "  ";
const NO_MATCH_TEXT = "  No matching models";
const FOOTER_HINT = "↑↓ navigate · Enter select · Esc cancel";

/** Canonical `provider/id` reference for a registry model. */
export function modelPickerItemId(model: ModelPickerModel): string {
  return `${model.provider}/${model.id}`;
}

/** Build de-duplicated, sorted picker rows and flag the row that is currently configured. */
export function buildModelPickerItems(input: BuildModelPickerItemsInput): ModelPickerItem[] {
  const seen = new Set<string>();
  const modelItems: ModelPickerItem[] = [];

  for (const model of input.models) {
    const value = modelPickerItemId(model);
    if (seen.has(value)) continue;
    seen.add(value);
    modelItems.push({
      value,
      label: value,
      searchText: `${value} ${model.name ?? ""}`.trim(),
    });
  }
  modelItems.sort((left, right) => left.value.localeCompare(right.value));

  const rows = [...(input.leadingItems ?? []), ...modelItems];
  return rows.map((row) => ({ ...row, current: row.value === input.currentValue }));
}

/** Scrollable, fuzzy-filterable single-select list for choosing a model. */
export class ModelPickerComponent extends Container {
  private readonly theme: ModelPickerTheme;
  private readonly done: (value: string | undefined) => void;
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private readonly footerText: Text;
  private readonly allItems: readonly ModelPickerItem[];
  private readonly maxVisible: number;
  private filteredItems: readonly ModelPickerItem[];
  private selectedIndex = 0;
  private focusedFlag = false;

  constructor(
    theme: ModelPickerTheme,
    options: ModelPickerOptions,
    done: (value: string | undefined) => void,
  ) {
    super();
    this.theme = theme;
    this.done = done;
    this.allItems = options.items;
    this.filteredItems = options.items;
    this.maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE;
    this.footerText = new Text(theme.fg("dim", FOOTER_HINT), 0, 0);
    this.selectedIndex = this.currentItemIndex();

    this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.footerText);

    this.updateList();
  }

  get focused(): boolean {
    return this.focusedFlag;
  }

  set focused(value: boolean) {
    this.focusedFlag = value;
    this.searchInput.focused = value;
  }

  private currentItemIndex(): number {
    const index = this.allItems.findIndex((item) => item.current);
    return index >= 0 ? index : 0;
  }

  private refresh(): void {
    const query = this.searchInput.getValue();
    this.filteredItems = query
      ? fuzzyFilter([...this.allItems], query, (item) => item.searchText)
      : this.allItems;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", NO_MATCH_TEXT), 0, 0));
      return;
    }

    const visibleCount = Math.min(this.maxVisible, this.filteredItems.length);
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.filteredItems.length - visibleCount),
    );
    const endIndex = Math.min(startIndex + visibleCount, this.filteredItems.length);

    for (let index = startIndex; index < endIndex; index++) {
      this.listContainer.addChild(new Text(this.renderRow(this.filteredItems[index], index), 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
      );
    }
  }

  private renderRow(item: ModelPickerItem, index: number): string {
    const cursor = index === this.selectedIndex ? SELECTED_CURSOR : UNSELECTED_CURSOR;
    const marker = item.current ? CURRENT_MARKER : BLANK_MARKER;
    const label = index === this.selectedIndex || item.current
      ? this.theme.fg("accent", item.label)
      : this.theme.fg("text", item.label);
    return `${cursor}${marker}${label}`;
  }

  private moveSelection(delta: number): void {
    if (this.filteredItems.length === 0) return;
    const total = this.filteredItems.length;
    this.selectedIndex = (this.selectedIndex + delta + total) % total;
    this.updateList();
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }

    this.searchInput.handleInput(data);
    this.refresh();
  }
}
