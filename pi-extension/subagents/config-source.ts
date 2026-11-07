import { readFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { homedir } from "node:os";

export interface ConfigSource {
  sourcePath: string;
  rawConfig: string;
}

/**
 * Resolve configuration without requiring mutation of the installed package.
 * An external env path is exact and fail-closed; explicit test/API paths retain
 * the historical primary→example fallback.
 */
export function readSubagentsConfigSource(options: {
  configPath: string;
  examplePath: string;
  env?: NodeJS.ProcessEnv;
  honorExternal?: boolean;
  missingLabel?: string;
}): ConfigSource {
  const env = options.env ?? process.env;
  if (options.honorExternal !== false) {
    const external = env.PI_SUBAGENTS_CONFIG?.trim();
    if (external) {
      if (!isAbsolute(external)) {
        throw new Error("PI_SUBAGENTS_CONFIG must be an absolute path");
      }
      const sourcePath = resolve(external);
      try {
        return { sourcePath, rawConfig: readFileSync(sourcePath, "utf8") };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read PI_SUBAGENTS_CONFIG ${sourcePath}: ${detail}`);
      }
    }
    const personal = join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent"), "subagents.json");
    try {
      return { sourcePath: personal, rawConfig: readFileSync(personal, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  try {
    return { sourcePath: options.configPath, rawConfig: readFileSync(options.configPath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: options.examplePath, rawConfig: readFileSync(options.examplePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${options.missingLabel ?? "subagent config"}. Expected ${options.configPath} or ${options.examplePath}.`);
    }
    throw error;
  }
}
