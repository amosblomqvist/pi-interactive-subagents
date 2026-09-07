import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DELEGATION_LIMITS,
  validateDelegationLimits,
  type DelegationLimits,
} from "./lineage.ts";
import { readSubagentsConfigSource } from "./config-source.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface RuntimeConfig {
  delegation: DelegationLimits;
  herdrViewer: { enabled: boolean };
}

export function parseRuntimeConfig(value: unknown, source = "config.json"): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid subagent runtime config in ${source}: root must be an object`);
  }
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !["status", "delegation", "herdrViewer"].includes(key));
  if (extra.length) {
    throw new Error(`Invalid subagent runtime config in ${source}: unsupported key(s): ${extra.join(", ")}`);
  }
  let delegation: DelegationLimits;
  try {
    delegation = validateDelegationLimits(input.delegation ?? DEFAULT_DELEGATION_LIMITS);
  } catch (error) {
    throw new Error(`Invalid subagent runtime config in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const viewer = input.herdrViewer;
  if (viewer != null && (typeof viewer !== "object" || Array.isArray(viewer))) {
    throw new Error(`Invalid subagent runtime config in ${source}: herdrViewer must be an object`);
  }
  const viewerObject = (viewer ?? {}) as Record<string, unknown>;
  const viewerExtra = Object.keys(viewerObject).filter((key) => key !== "enabled");
  if (viewerExtra.length) {
    throw new Error(`Invalid subagent runtime config in ${source}: herdrViewer has unsupported key(s): ${viewerExtra.join(", ")}`);
  }
  if (viewerObject.enabled != null && typeof viewerObject.enabled !== "boolean") {
    throw new Error(`Invalid subagent runtime config in ${source}: herdrViewer.enabled must be a boolean`);
  }
  return {
    delegation,
    herdrViewer: { enabled: viewerObject.enabled !== false },
  };
}

export function loadRuntimeConfig(
  configPath = DEFAULT_CONFIG_PATH,
  examplePath = EXAMPLE_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const loaded = readSubagentsConfigSource({
    configPath,
    examplePath,
    env,
    // Explicit non-default paths are API/test fixtures and retain fallback;
    // normal extension loading honors the external absolute env override.
    honorExternal: configPath === DEFAULT_CONFIG_PATH && examplePath === EXAMPLE_CONFIG_PATH,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(loaded.rawConfig);
  } catch (error) {
    throw new Error(`Invalid JSON in subagent config ${loaded.sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRuntimeConfig(parsed, loaded.sourcePath);
}
