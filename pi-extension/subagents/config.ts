import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/**
 * Subagent config file (`subagents.json` in the pi agent directory).
 *
 * The file holds two independent sections:
 *   - `status` — status-line rendering (parsed by status.ts);
 *   - `models` — optional model selection for sub-agents (parsed here).
 *
 * The `models` section is opt-in. When the key is absent, sub-agent models come
 * from the agent frontmatter exactly as before, so existing installations are
 * unaffected.
 *
 * This module also owns the shared config-file primitives — the validation
 * guard, the raw JSON reader, and the file paths — so status.ts and the models
 * parser cannot drift apart.
 *
 * The file lives in the agent directory (default `~/.pi/agent`) rather than the
 * package checkout: the checkout is git-managed and `git clean -fdx` runs on a
 * package update, which would delete an ignored file inside it. The legacy
 * package-root `config.json` is still read once, so existing picks migrate on
 * the next write.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Primary, durable location for user configuration, inside the pi agent dir. */
export const SUBAGENT_CONFIG_PATH = join(getAgentDir(), "subagents.json");

/**
 * Legacy location inside the package checkout. Read-only, kept so a user who
 * configured models before this move keeps their selection.
 */
export const SUBAGENT_LEGACY_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");

/** Shipped defaults, used only when no user config exists yet. */
export const SUBAGENT_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

/** Default source label used when a caller has no file path at hand. */
const DEFAULT_CONFIG_SOURCE = "subagents.json";

/** Indent width for the config file this extension writes back. */
const CONFIG_JSON_INDENT = 2;

/** Agent names this extension accepts as config keys. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Keys that must never be written as agent names. */
const FORBIDDEN_AGENT_NAMES = ["__proto__", "constructor"];

/**
 * The literal that means "run this sub-agent on the parent session's active
 * model". Stored as-is in the loadout snapshot so a resume re-resolves it
 * against the parent session at resume time instead of freezing a model id.
 */
export const INHERIT_TOKEN = "inherit";

/** pi thinking levels, in ascending order. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

/** What to do when a configured model is not available in this pi install. */
export type ModelFallback = "default" | "inherit" | "fail";

export interface AgentModelConfig {
  /** A `provider/modelId` string, a bare `modelId`, or the inherit token. */
  model?: string;
  thinking?: ThinkingLevelName;
}

export interface ModelsConfig {
  /** Model for every agent without a per-agent entry. Takes precedence over frontmatter `model:`. */
  default?: string;
  /** Thinking level for every agent. Takes precedence over frontmatter `thinking:`. */
  thinking?: ThinkingLevelName;
  /** Per-agent overrides, keyed by agent name. */
  agents: Record<string, AgentModelConfig>;
  /** Check the resolved model against the local catalogue. Defaults to true. */
  validate: boolean;
  /** What to do when validation fails. Defaults to `inherit`. */
  fallback: ModelFallback;
}

export interface SubagentConfig {
  /**
   * The parsed `models` section, or null when the key is absent. Null means
   * "no model configuration" — the resolution chain then behaves exactly as it
   * did before this section existed.
   */
  models: ModelsConfig | null;
}

/** One model the user can run, reduced to what resolution needs. */
export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  /** Whether the model supports thinking at all. Absent means unknown. */
  reasoning?: boolean;
  /** Thinking levels the model supports, or undefined when unknown. */
  supportedThinking?: readonly ThinkingLevelName[];
}

/** The live model environment of the session that is spawning a sub-agent. */
export interface ModelCatalog {
  /** Parent session's active model as `provider/id`, or null when unknown. */
  parentModel: string | null;
  /** Parent session's effective thinking level, or null when unknown. */
  parentThinking: string | null;
  /** Thinking levels the parent session's model supports, or undefined when unknown. */
  parentSupportedThinking?: readonly ThinkingLevelName[];
  /** Every model with resolved credentials, from the pi model registry. */
  available: readonly CatalogModel[];
}

export type ModelSource =
  | "param"
  | "config-agent"
  | "config-default"
  | "agent"
  | "snapshot"
  | "fallback"
  | "unset";

/** Display label per resolution source, used by `subagents_list` and warnings. */
const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  param: "spawn param",
  "config-agent": "config agent",
  "config-default": "config default",
  agent: "agent file",
  snapshot: "snapshot",
  fallback: "fallback",
  unset: "unset",
};

export interface ResolvedModel {
  /**
   * Value persisted in the loadout snapshot: a literal `provider/id`, the
   * inherit token, or null when no model is configured.
   */
  token: string | null;
  /** Effective model for `--model` (no thinking suffix), or null to omit it. */
  command: string | null;
  /** Effective thinking level for the `model:level` suffix, or null. */
  thinking: string | null;
  /** Which source produced the token. */
  source: ModelSource;
  /** True when the token is the inherit token. */
  inherited: boolean;
  /** Set when the value had to be replaced or adjusted. */
  warning: string | null;
  /** Set when the model is unusable and the spawn must not continue. */
  error: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validation primitives bound to one config file and one config label, so
 * every section of the file rejects the same shapes and names the same file.
 */
export interface SubagentConfigGuard {
  invalid(message: string): never;
  isPlainObject(value: unknown): value is Record<string, unknown>;
  requireObject(value: unknown, fieldName: string): Record<string, unknown>;
  requireBoolean(value: unknown, fieldName: string): boolean;
  requireNonEmptyString(value: unknown, fieldName: string): string;
  rejectUnsupportedKeys(
    value: Record<string, unknown>,
    allowedKeys: readonly string[],
    fieldName: string,
  ): void;
}

/** Build the guard for one config file. `configLabel` names the section owner. */
export function createSubagentConfigGuard(
  source = DEFAULT_CONFIG_SOURCE,
  configLabel = "subagent",
): SubagentConfigGuard {
  const invalid = (message: string): never => {
    throw new Error(`Invalid ${configLabel} config in ${source}: ${message}`);
  };

  return {
    invalid,
    isPlainObject,
    requireObject(value, fieldName) {
      if (!isPlainObject(value)) invalid(`${fieldName} must be an object`);
      return value;
    },
    requireBoolean(value, fieldName) {
      if (typeof value !== "boolean") invalid(`${fieldName} must be a boolean`);
      return value;
    },
    requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim().length === 0) {
        invalid(`${fieldName} must be a non-empty string`);
      }
      return value.trim();
    },
    rejectUnsupportedKeys(value, allowedKeys, fieldName) {
      const unsupported = Object.keys(value).filter((key) => !allowedKeys.includes(key));
      if (unsupported.length > 0) {
        invalid(`${fieldName} has unsupported key(s): ${unsupported.join(", ")}`);
      }
    },
  };
}

/** Parse config JSON, naming the offending file on failure. */
export function parseSubagentConfigJson(rawConfig: string, sourcePath: string): unknown {
  try {
    return JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }
}

/** Return the first candidate config file that can be read, or null when none exists. */
function readFirstExistingConfigFile(
  candidatePaths: readonly string[],
): { sourcePath: string; rawConfig: string } | null {
  for (const path of candidatePaths) {
    try {
      return { sourcePath: path, rawConfig: readFileSync(path, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

/**
 * Read the raw config text. The durable agent-dir file wins, then the legacy
 * package-root `config.json`, then the shipped example. Returns null when none
 * exists.
 */
export function readSubagentConfigFile(
  configPath = SUBAGENT_CONFIG_PATH,
  examplePath = SUBAGENT_CONFIG_EXAMPLE_PATH,
  legacyPath = SUBAGENT_LEGACY_CONFIG_PATH,
): { sourcePath: string; rawConfig: string } | null {
  return readFirstExistingConfigFile([configPath, legacyPath, examplePath]);
}

function parseThinkingLevel(
  guard: SubagentConfigGuard,
  value: unknown,
  fieldName: string,
): ThinkingLevelName {
  if (typeof value !== "string" || !THINKING_LEVEL_SET.has(value)) {
    guard.invalid(`${fieldName} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevelName;
}

function parseAgentModelConfig(
  guard: SubagentConfigGuard,
  value: unknown,
  fieldName: string,
): AgentModelConfig {
  const entry = guard.requireObject(value, fieldName);
  guard.rejectUnsupportedKeys(entry, ["model", "thinking"], fieldName);

  const parsed: AgentModelConfig = {};
  if (entry.model !== undefined) {
    parsed.model = guard.requireNonEmptyString(entry.model, `${fieldName}.model`);
  }
  if (entry.thinking !== undefined) {
    parsed.thinking = parseThinkingLevel(guard, entry.thinking, `${fieldName}.thinking`);
  }
  return parsed;
}

/**
 * Parse the `models` section. Returns null when the key is absent, which is the
 * signal that no model configuration exists and resolution must stay inert.
 */
export function parseSubagentConfig(rawConfig: unknown, source = DEFAULT_CONFIG_SOURCE): SubagentConfig {
  const guard = createSubagentConfigGuard(source);
  const config = guard.requireObject(rawConfig, "root");
  if (config.models === undefined) return { models: null };

  const models = guard.requireObject(config.models, "models");
  guard.rejectUnsupportedKeys(
    models,
    ["default", "thinking", "agents", "validate", "fallback"],
    "models",
  );

  const parsed: ModelsConfig = {
    agents: {},
    validate: true,
    fallback: "inherit",
  };

  if (models.default !== undefined) {
    parsed.default = guard.requireNonEmptyString(models.default, "models.default");
  }
  if (models.thinking !== undefined) {
    parsed.thinking = parseThinkingLevel(guard, models.thinking, "models.thinking");
  }
  if (models.validate !== undefined) {
    parsed.validate = guard.requireBoolean(models.validate, "models.validate");
  }
  if (models.fallback !== undefined) {
    if (models.fallback !== "default" && models.fallback !== "inherit" && models.fallback !== "fail") {
      guard.invalid("models.fallback must be one of: default, inherit, fail");
    }
    parsed.fallback = models.fallback;
  }
  if (models.agents !== undefined) {
    const agents = guard.requireObject(models.agents, "models.agents");
    for (const [name, entry] of Object.entries(agents)) {
      if (FORBIDDEN_AGENT_NAMES.includes(name)) {
        guard.invalid(`models.agents has unsupported key: ${name}`);
      }
      parsed.agents[name] = parseAgentModelConfig(guard, entry, `models.agents.${name}`);
    }
  }

  return { models: parsed };
}

/**
 * Load the sub-agent config. A missing file is not an error — it just means no
 * model configuration, which is the default state for every installation.
 */
export function loadSubagentConfig(
  configPath = SUBAGENT_CONFIG_PATH,
  examplePath = SUBAGENT_CONFIG_EXAMPLE_PATH,
  legacyPath = SUBAGENT_LEGACY_CONFIG_PATH,
): SubagentConfig {
  const read = readSubagentConfigFile(configPath, examplePath, legacyPath);
  if (!read) return { models: null };
  return parseSubagentConfig(
    parseSubagentConfigJson(read.rawConfig, read.sourcePath),
    read.sourcePath,
  );
}

/**
 * Split a `provider/modelId:level` string into its model part and its optional
 * thinking level. Only a recognised thinking level is treated as a suffix, so
 * model ids that contain a colon (e.g. OpenRouter `:batch` variants) survive.
 */
export function parseModelToken(token: string): {
  base: string;
  thinking: ThinkingLevelName | null;
} {
  const trimmed = token.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const suffix = trimmed.slice(colon + 1);
    if (THINKING_LEVEL_SET.has(suffix)) {
      return { base: trimmed.slice(0, colon), thinking: suffix as ThinkingLevelName };
    }
  }
  return { base: trimmed, thinking: null };
}

/** Thinking levels a model supports, mirroring pi-ai's getSupportedThinkingLevels. */
export function supportedThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevelName, string | null>>;
}): ThinkingLevelName[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Snap a requested thinking level to the nearest supported one. */
export function clampThinkingLevel(
  level: ThinkingLevelName,
  supported: readonly ThinkingLevelName[],
): ThinkingLevelName {
  if (supported.length === 0) return "off";

  const requestedIndex = THINKING_LEVELS.indexOf(level);
  if (requestedIndex >= 0) {
    let best: ThinkingLevelName | null = null;
    for (const candidate of supported) {
      const candidateIndex = THINKING_LEVELS.indexOf(candidate);
      if (candidateIndex <= requestedIndex && (best === null || candidateIndex > THINKING_LEVELS.indexOf(best))) {
        best = candidate;
      }
    }
    if (best !== null) return best;
  }

  return supported.reduce((lowest, candidate) =>
    THINKING_LEVELS.indexOf(candidate) < THINKING_LEVELS.indexOf(lowest) ? candidate : lowest,
  );
}

/** Clamp a resolved model's thinking level to what the model supports. */
function adjustThinkingForSupport(
  thinking: string | null,
  supported: readonly ThinkingLevelName[] | undefined,
  validating: boolean,
): { thinking: string | null; warning: string | null } {
  if (!validating || supported === undefined) return { thinking, warning: null };

  // A non-reasoning model only supports `off`; resolve it explicitly rather
  // than silently dropping the suffix.
  if (supported.length === 1 && supported[0] === "off") {
    if (thinking === "off" || thinking === null) return { thinking: "off", warning: null };
    return { thinking: "off", warning: unsupportedThinkingWarning(thinking, "off") };
  }

  if (thinking === null) return { thinking, warning: null };

  if (supported.includes(thinking as ThinkingLevelName)) return { thinking, warning: null };

  const clamped = clampThinkingLevel(thinking as ThinkingLevelName, supported);
  return { thinking: clamped, warning: unsupportedThinkingWarning(thinking, clamped) };
}

function unsupportedThinkingWarning(requested: string, used: string): string {
  return `Thinking level "${requested}" is not supported by the resolved model; using "${used}" instead.`;
}

/** Find the available model a token names by bare id or `provider/id`. */
export function findAvailableModel(
  token: string,
  available: readonly CatalogModel[],
): CatalogModel | undefined {
  const needle = token.toLowerCase();
  return available.find(
    (model) =>
      model.id.toLowerCase() === needle ||
      `${model.provider}/${model.id}`.toLowerCase() === needle,
  );
}

/** True when `base` matches an available model by `provider/id` or bare id. */
export function isModelAvailable(base: string, available: readonly CatalogModel[]): boolean {
  return findAvailableModel(base, available) !== undefined;
}

/** Human label for a resolution source, for `subagents_list` and warnings. */
export function formatModelSource(source: ModelSource): string {
  return MODEL_SOURCE_LABELS[source];
}

interface ResolveInput {
  token: string | null;
  source: ModelSource;
  agentName: string | null;
  thinking: string | null;
  config: SubagentConfig;
  catalog: ModelCatalog;
}

/**
 * Turn a model token into an effective model, applying validation and the
 * fallback ladder when the token is not available in this pi installation.
 */
function resolveModelToken(input: ResolveInput): ResolvedModel {
  const models = input.config.models;
  const baseThinking = input.thinking;

  const attempt = (token: string | null, source: ModelSource): ResolvedModel | null => {
    if (!token) {
      return {
        token: null,
        command: null,
        thinking: baseThinking,
        source: "unset",
        inherited: false,
        warning: null,
        error: null,
      };
    }

    const parsed = parseModelToken(token);
    const thinking = parsed.thinking ?? baseThinking;

    if (token === INHERIT_TOKEN) {
      if (!input.catalog.parentModel) return null;
      const adjusted = adjustThinkingForSupport(
        thinking ?? input.catalog.parentThinking,
        input.catalog.parentSupportedThinking,
        models?.validate === true,
      );
      return {
        token,
        command: input.catalog.parentModel,
        thinking: adjusted.thinking,
        source,
        inherited: true,
        warning: adjusted.warning,
        error: null,
      };
    }

    // An empty catalogue means the model environment is unknown (no registry
    // available), not that nothing is installed. Skip validation rather than
    // rejecting every configured model.
    const validating = models?.validate === true && input.catalog.available.length > 0;
    if (!validating || isModelAvailable(parsed.base, input.catalog.available)) {
      const catalogModel = findAvailableModel(parsed.base, input.catalog.available);
      const adjusted = adjustThinkingForSupport(
        thinking,
        catalogModel?.supportedThinking,
        models?.validate === true,
      );
      return {
        token,
        command: parsed.base,
        thinking: adjusted.thinking,
        source,
        inherited: false,
        warning: adjusted.warning,
        error: null,
      };
    }

    return null;
  };

  const primary = attempt(input.token, input.source);
  if (primary) return primary;

  const label = formatModelSource(input.source);
  const reason =
    input.token === INHERIT_TOKEN
      ? `No active model to inherit from (source: ${label}).`
      : `Model "${input.token}" (source: ${label}) is not available in this pi installation.`;

  if (!models) {
    return {
      token: input.token,
      command: null,
      thinking: baseThinking,
      source: input.source,
      inherited: false,
      warning: reason,
      error: null,
    };
  }

  if (models.fallback === "fail") {
    return {
      token: input.token,
      command: null,
      thinking: baseThinking,
      source: input.source,
      inherited: false,
      warning: null,
      error: `${reason} Set "models.fallback" to "default" or "inherit", or pick an available model with /subagent-model.`,
    };
  }

  const ladder: Array<string | undefined> =
    models.fallback === "default" ? [models.default, INHERIT_TOKEN] : [INHERIT_TOKEN];

  for (const candidate of ladder) {
    if (!candidate || candidate === input.token) continue;
    const resolved = attempt(candidate, "fallback");
    if (resolved) {
      const fallbackWarning = `${reason} Falling back to "${candidate}".`;
      resolved.warning = resolved.warning
        ? `${resolved.warning} ${fallbackWarning}`
        : fallbackWarning;
      return resolved;
    }
  }

  return {
    token: input.token,
    command: null,
    thinking: baseThinking,
    source: input.source,
    inherited: false,
    warning: null,
    error: `${reason} No fallback model was usable.`,
  };
}

/** Warning text when a spawn param is shadowed by the agent's authoritative config pick. */
function buildIgnoredParamWarning(
  param: string | null,
  agentName: string | null,
  configModel: string | undefined,
): string | null {
  if (!param || !agentName || !configModel || configModel === param) return null;
  return `Ignoring model override "${param}" from the subagent tool: agent "${agentName}" is pinned to "${configModel}" via /subagent-model.`;
}

/** Pick the token by precedence: config-agent > param > config-default > agent, because the user's explicit `/subagent-model` pick is authoritative. */
export function resolveSubagentModel(input: {
  param: string | null;
  agentName: string | null;
  agentModel: string | null;
  agentThinking: string | null;
  config: SubagentConfig;
  catalog: ModelCatalog;
}): ResolvedModel {
  const models = input.config.models;
  const agentEntry = input.agentName ? models?.agents[input.agentName] : undefined;

  const thinking = agentEntry?.thinking ?? models?.thinking ?? input.agentThinking ?? null;

  // Highest precedence first; the first entry with a token wins. The per-agent
  // config entry is authoritative, so a tool-supplied param cannot silently
  // override the user's `/subagent-model` pick; config entries also outrank the
  // agent's own frontmatter.
  const precedence: ReadonlyArray<{ source: ModelSource; token: string | null | undefined }> = [
    { source: "config-agent", token: agentEntry?.model },
    { source: "param", token: input.param },
    { source: "config-default", token: models?.default },
    { source: "agent", token: input.agentModel },
  ];

  const chosen = precedence.find((entry) => entry.token);

  const resolved = resolveModelToken({
    ...input,
    token: chosen?.token ?? null,
    source: chosen?.source ?? "unset",
    thinking,
  });

  const ignoredParamWarning = buildIgnoredParamWarning(input.param, input.agentName, agentEntry?.model);
  if (ignoredParamWarning) {
    resolved.warning = resolved.warning
      ? `${resolved.warning}; ${ignoredParamWarning}`
      : ignoredParamWarning;
  }

  return resolved;
}

/**
 * Re-resolve the model for a sub-agent that is being resumed.
 *
 * The user's current pick always wins: the agent's config entry, then the
 * config default, then the token frozen in the snapshot. The snapshot is only
 * a fallback, so resuming an older sub-agent after a `/subagent-model` change
 * runs the new model instead of the one captured at its first spawn. An
 * `inherit` snapshot still follows the parent session whenever no config entry
 * outranks it.
 */
export function resolveLoadoutModel(input: {
  loadout: { model: string | null; thinking: string | null; agent: string | null };
  config: SubagentConfig;
  catalog: ModelCatalog;
}): ResolvedModel {
  const models = input.config.models;
  const agentEntry = input.loadout.agent ? models?.agents[input.loadout.agent] : undefined;
  const configuredToken = agentEntry?.model ?? models?.default;

  const source: ModelSource = agentEntry?.model
    ? "config-agent"
    : models?.default
      ? "config-default"
      : "snapshot";
  const thinking = agentEntry?.thinking ?? models?.thinking ?? input.loadout.thinking ?? null;

  return resolveModelToken({
    ...input,
    token: configuredToken ?? input.loadout.model,
    source,
    thinking,
  });
}

/** Write model and/or thinking selections into the config, preserving every other key. */
export function writeModelSelection(opts: {
  agentName: string | null;
  /** undefined = leave the model as-is, null = remove, string = set. */
  model?: string | null;
  /** undefined = leave thinking as-is, null = remove, value = set. */
  thinking?: ThinkingLevelName | null;
  configPath?: string;
  examplePath?: string;
  legacyPath?: string;
}): { path: string; changed: boolean } {
  const configPath = opts.configPath ?? SUBAGENT_CONFIG_PATH;
  const examplePath = opts.examplePath ?? SUBAGENT_CONFIG_EXAMPLE_PATH;
  const legacyPath = opts.legacyPath ?? SUBAGENT_LEGACY_CONFIG_PATH;

  if (opts.agentName && !AGENT_NAME_PATTERN.test(opts.agentName)) {
    throw new Error(`Refusing to write model selection for unsafe agent name "${opts.agentName}"`);
  }

  const removingOnly =
    (opts.model === null || opts.model === undefined) &&
    (opts.thinking === null || opts.thinking === undefined);
  if (removingOnly && !existsSync(configPath) && !existsSync(legacyPath)) {
    return { path: configPath, changed: false };
  }

  const read = readSubagentConfigFile(configPath, examplePath, legacyPath);
  const guard = createSubagentConfigGuard(read?.sourcePath ?? configPath);

  let root: Record<string, unknown> = {};
  if (read) {
    root = guard.requireObject(parseSubagentConfigJson(read.rawConfig, read.sourcePath), "root");
  }
  const before = JSON.stringify(root);

  const models =
    root.models === undefined ? {} : guard.requireObject(root.models, "models");
  let mutated = false;

  const applyField = (target: Record<string, unknown>, key: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) {
      if (key in target) {
        delete target[key];
        mutated = true;
      }
      return;
    }
    if (target[key] !== value) {
      target[key] = value;
      mutated = true;
    }
  };

  if (opts.agentName) {
    const agents =
      models.agents === undefined ? {} : guard.requireObject(models.agents, "models.agents");
    const currentEntry = agents[opts.agentName];
    const entry = guard.isPlainObject(currentEntry) ? { ...currentEntry } : {};
    applyField(entry, "model", opts.model);
    applyField(entry, "thinking", opts.thinking);

    if (Object.keys(entry).length === 0) {
      if (currentEntry !== undefined) {
        delete agents[opts.agentName];
        mutated = true;
      }
    } else {
      agents[opts.agentName] = entry;
    }
    if (mutated) models.agents = agents;
  } else {
    applyField(models, "default", opts.model);
    applyField(models, "thinking", opts.thinking);
  }

  if (mutated) root.models = models;

  if (JSON.stringify(root) === before) {
    return { path: configPath, changed: false };
  }

  writeFileSync(configPath, `${JSON.stringify(root, null, CONFIG_JSON_INDENT)}\n`, "utf8");
  return { path: configPath, changed: true };
}
