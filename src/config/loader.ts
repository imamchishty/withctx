import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import chalk from "chalk";
import { CtxConfigSchema, type CtxConfig } from "../types/config.js";
import { setCustomPricing } from "../usage/recorder.js";
import { migrateConfig, CURRENT_VERSION } from "./migrate.js";

// Track which config paths have already printed a migration notice in
// this process. We load config repeatedly (once per command) and only
// want the "migrated 1.3 → 1.4" line to appear on the FIRST load.
const migrationNoticeShown = new Set<string>();

const CONFIG_FILENAME = "ctx.yaml";

/**
 * Leaf keys whose string value is allowed to contain `${VAR}` env-var
 * placeholders. Everything else is treated as literal — a malicious or
 * careless ctx.yaml cannot smuggle an env var into a filesystem path,
 * repo name, JQL string, or any other non-credential field.
 *
 * Why so strict:
 *
 *   sources:
 *     local:
 *       - name: leaky
 *         path: /tmp/${ANTHROPIC_API_KEY}
 *
 * Under the old unrestricted resolver, the path above would expand to
 * `/tmp/sk-ant-api03-...`, which then flows into error messages, crash
 * traces, filesystem probes, and anywhere else we log a resolved path.
 * That's an exfil channel we don't want. The allow-list below is
 * deliberately small — add to it only when a new credential-ish field
 * genuinely needs `${VAR}` support.
 */
const ENV_INTERPOLATION_LEAF_KEYS = new Set([
  // Authentication secrets
  "token",
  "api_key",
  "apikey",
  "password",
  "secret",
  "client_id",
  "client_secret",
  "tenant_id",
  "personal_access_token",
  "access_token",
  "bearer",
  "webhook",
  "webhook_url",
  // URLs — may reference private/internal hosts stored in env
  "base_url",
  "url",
  "endpoint",
  "host",
  // Identity
  "email",
]);

/**
 * Parent keys whose *immediate children* (string values, one level deep)
 * may contain `${VAR}` interpolation. The canonical example is
 * `ai.headers`: header names are user-chosen (`api-key`, `x-ms-region`,
 * …) so we can't enumerate them in ENV_INTERPOLATION_LEAF_KEYS, but
 * everything under `headers:` is secret-shaped by convention.
 */
const ENV_INTERPOLATION_PARENT_KEYS = new Set(["headers"]);

/**
 * Matches `${VAR}` and `${VAR:-default}`.
 * Group 1 = variable name, Group 2 = default value (may be undefined).
 */
const ENV_PLACEHOLDER = /\$\{(\w+)(?::-(.*?))?\}/g;

/**
 * Resolve environment variable references in config values.
 *
 * Only substitutes `${VAR_NAME}` inside fields on the credential/URL
 * allow-list (see `ENV_INTERPOLATION_LEAF_KEYS` / `_PARENT_KEYS`). Any
 * other field containing `${...}` is a hard error — silently leaving
 * the literal in place is worse than failing, because it produces
 * broken paths that confuse users weeks later.
 *
 * Tracked state through the recursion:
 *   - `currentKey`  — the key that owns this value, e.g. `token`.
 *   - `parentKey`   — the key two levels up, used for `headers: { ... }`.
 *   - `pathTrail`   — dotted key trail for error messages, e.g.
 *                     `sources.jira[0].project`.
 */
function resolveEnvVars(
  obj: unknown,
  currentKey: string | null = null,
  parentKey: string | null = null,
  pathTrail = "<root>"
): unknown {
  if (typeof obj === "string") {
    if (!ENV_PLACEHOLDER.test(obj)) {
      // Reset regex state — this RegExp is module-level with /g flag.
      ENV_PLACEHOLDER.lastIndex = 0;
      return obj;
    }
    ENV_PLACEHOLDER.lastIndex = 0;

    const leafAllowed =
      currentKey !== null &&
      ENV_INTERPOLATION_LEAF_KEYS.has(currentKey.toLowerCase());
    const parentAllowed =
      parentKey !== null &&
      ENV_INTERPOLATION_PARENT_KEYS.has(parentKey.toLowerCase());

    if (!leafAllowed && !parentAllowed) {
      throw new Error(
        `Config error at '${pathTrail}': \${VAR} environment-variable ` +
          `interpolation is only allowed in credential / URL / header ` +
          `fields (token, api_key, base_url, headers, email, …). ` +
          `Found placeholder in value: ${JSON.stringify(obj)}. ` +
          `If this field genuinely needs an env var, move the secret ` +
          `into a whitelisted field or set the value inline.`
      );
    }

    return obj.replace(ENV_PLACEHOLDER, (_, varName, fallback) => {
      return process.env[varName] ?? fallback ?? "";
    });
  }
  if (Array.isArray(obj)) {
    // Arrays inherit their owner's key so `tokens: [${A}, ${B}]` still
    // works. The pathTrail grows by index for clearer error messages.
    return obj.map((item, i) =>
      resolveEnvVars(item, currentKey, parentKey, `${pathTrail}[${i}]`)
    );
  }
  if (obj !== null && typeof obj === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const nextTrail = pathTrail === "<root>" ? key : `${pathTrail}.${key}`;
      resolved[key] = resolveEnvVars(value, key, currentKey, nextTrail);
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
      `No ${CONFIG_FILENAME} found. Run 'ctx setup' to create one.`
    );
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);

  // Run migrations BEFORE env-var interpolation so we're transforming
  // structural fields (e.g. costs.model → ai.model) on the raw shape,
  // not on values that have already been substituted with secrets.
  const migration = migrateConfig(parsed);

  // First-load notice: tell the user once that their old config was
  // upgraded in memory. We never rewrite the file — the upgrade is
  // lossless and rollback-safe, and users can call `ctx config
  // --migrate` to persist it.
  if (migration.notes.length > 0 && !migrationNoticeShown.has(path)) {
    migrationNoticeShown.add(path);
    const from = migration.fromVersion ?? "pre-1.4";
    // Use stderr so `--json` stdout isn't polluted.
    console.error(
      chalk.dim(
        `  ctx.yaml auto-migrated (${from} → ${CURRENT_VERSION}, in memory only).`
      )
    );
    for (const note of migration.notes) {
      console.error(chalk.dim(`    · ${note}`));
    }
    console.error(
      chalk.dim(
        `    Run 'ctx config --migrate' to persist the upgrade to disk.`
      )
    );
  }

  const resolved = resolveEnvVars(migration.config);
  const config = CtxConfigSchema.parse(resolved);

  // Install any user-declared model pricing into the global cost registry so
  // every call site (sync, ingest, query, review, …) picks it up automatically
  // — no need to thread config through every recordCall() invocation.
  // Used by teams on corporate / self-hosted endpoints (Core42, Azure OpenAI,
  // private vLLM) whose model names aren't in the built-in pricing table.
  setCustomPricing(config.ai?.pricing);

  return config;
}

/**
 * Get the project root directory (where ctx.yaml lives).
 */
export function getProjectRoot(configPath?: string): string {
  const path = configPath ?? findConfigFile();
  if (!path) {
    throw new Error(
      `No ${CONFIG_FILENAME} found. Run 'ctx setup' to create one.`
    );
  }
  return resolve(path, "..");
}
