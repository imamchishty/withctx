import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CtxConfigSchema, type CtxConfig } from "../types/config.js";

const CONFIG_FILENAME = "ctx.yaml";

/**
 * Resolve environment variable references in config values.
 * Replaces ${VAR_NAME} with process.env.VAR_NAME.
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, varName) => {
      return process.env[varName] ?? "";
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

/**
 * Find ctx.yaml by walking up from the given directory.
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const configPath = resolve(dir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      return configPath;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load and validate ctx.yaml configuration.
 */
export function loadConfig(configPath?: string): CtxConfig {
  const path = configPath ?? findConfigFile();
  if (!path) {
    throw new Error(
      `No ${CONFIG_FILENAME} found. Run 'ctx init' to create one.`
    );
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const resolved = resolveEnvVars(parsed);
  return CtxConfigSchema.parse(resolved);
}

/**
 * Get the project root directory (where ctx.yaml lives).
 */
export function getProjectRoot(configPath?: string): string {
  const path = configPath ?? findConfigFile();
  if (!path) {
    throw new Error(
      `No ${CONFIG_FILENAME} found. Run 'ctx init' to create one.`
    );
  }
  return resolve(path, "..");
}
