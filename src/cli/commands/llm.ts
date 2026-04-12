/**
 * `ctx llm` — quick check: "can I reach the LLM?"
 *
 * Resolves the provider from ctx.yaml / env, sends a single "ping"
 * message, and prints a clear yes/no with the provider name, model,
 * and endpoint URL. Exits 0 on success, 1 on failure.
 *
 * Zero flags. Zero ambiguity. The output you want before running a
 * paid command like `ctx ingest` or `ctx sync` for the first time.
 *
 * Internally reuses the same LLM factory as every other command, so
 * the test exercises the exact code path a real ingest would hit —
 * including api_key resolution, ai.base_url, ai.headers, and
 * ${VAR} interpolation.
 *
 * For the full diagnostic suite (config, network, sources, deps),
 * use `ctx doctor`.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { loadConfig, findConfigFile } from "../../config/loader.js";
import type { CtxConfig } from "../../types/config.js";

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  ollama: "(none — local)",
};

export function registerLlmCommand(program: Command): void {
  program
    .command("llm")
    .description("Check LLM connectivity — sends a single ping to your provider")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = opts.json === true;

      // ── Load config (best-effort) ──────────────────────────────
      let config: CtxConfig | null = null;
      const configPath = findConfigFile();
      if (configPath) {
        try {
          config = loadConfig(configPath);
        } catch {
          // No config is fine — the factory auto-detects from env.
        }
      }

      // ── Resolve provider metadata ─────────────────────────────
      const providerName = config?.ai?.provider ?? "anthropic";
      const envVar = PROVIDER_ENV[providerName] ?? PROVIDER_ENV.anthropic;

      let llm: ReturnType<typeof createLLMFromCtxConfig>;
      try {
        llm = createLLMFromCtxConfig(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, provider: providerName, error: msg }));
        } else {
          console.log();
          console.log(chalk.red(`  ✗ Cannot create ${providerName} provider`));
          console.log(chalk.dim(`    ${msg}`));
          console.log();
          console.log(chalk.dim(`  Hint: set ai.api_key in ctx.yaml, or export ${envVar}=<your-key>`));
          console.log();
        }
        process.exit(1);
      }

      const model = llm.getModel();
      const baseURL = llm.getBaseURL();

      // ── Ping ──────────────────────────────────────────────────
      const spinner = json ? null : ora({ text: `Pinging ${providerName}...`, indent: 2 }).start();

      const start = Date.now();
      let available: boolean;
      let error: string | null = null;

      try {
        available = await llm.isAvailable();
      } catch (err) {
        available = false;
        error = err instanceof Error ? err.message : String(err);
      }
      const latencyMs = Date.now() - start;

      spinner?.stop();

      // ── Output ────────────────────────────────────────────────
      if (json) {
        console.log(
          JSON.stringify({
            ok: available,
            provider: providerName,
            model,
            base_url: baseURL,
            latency_ms: latencyMs,
            ...(error ? { error } : {}),
            ...(configPath ? { config: configPath } : {}),
          }),
        );
        process.exit(available ? 0 : 1);
      }

      console.log();

      // Show where the key was resolved from — helps users understand
      // which path fired. env wins > yaml > nothing.
      const keySource = resolveKeySource(providerName, envVar, config);

      if (available) {
        console.log(chalk.green("  ✓ LLM connected"));
        console.log();
        console.log(`    Provider   ${chalk.bold(providerName)}`);
        console.log(`    Model      ${chalk.bold(model)}`);
        console.log(`    Endpoint   ${chalk.dim(baseURL)}`);
        console.log(`    Key from   ${chalk.dim(keySource)}`);
        console.log(`    Latency    ${chalk.dim(`${latencyMs}ms`)}`);
        if (configPath) {
          console.log(`    Config     ${chalk.dim(configPath)}`);
        }
        console.log();
      } else {
        console.log(chalk.red("  ✗ LLM not reachable"));
        console.log();
        console.log(`    Provider   ${chalk.bold(providerName)}`);
        console.log(`    Model      ${model}`);
        console.log(`    Endpoint   ${chalk.dim(baseURL)}`);
        console.log(`    Key from   ${chalk.dim(keySource)}`);
        if (error) {
          console.log(`    Error      ${chalk.red(error)}`);
        }
        console.log();
        console.log(chalk.dim("  Two ways to set your key:"));
        console.log();
        if (providerName !== "ollama") {
          console.log(chalk.dim("    ctx.yaml (recommended for solo / local use):"));
          console.log(chalk.dim("      ai:"));
          console.log(chalk.dim(`        provider: ${providerName}`));
          console.log(chalk.dim(`        api_key: sk-...`));
          console.log();
          console.log(chalk.dim("    Environment variable (recommended for CI / shared repos):"));
          console.log(chalk.dim(`      export ${envVar}=sk-...`));
          console.log();
          console.log(chalk.dim("    You can also reference the env var from yaml:"));
          console.log(chalk.dim(`      api_key: \${${envVar}}`));
        } else {
          console.log(chalk.dim("    1. Start Ollama:    ollama serve"));
          console.log(chalk.dim("    2. Pull a model:    ollama pull llama3"));
          console.log();
          console.log(chalk.dim("    Or set a custom endpoint in ctx.yaml:"));
          console.log(chalk.dim("      ai:"));
          console.log(chalk.dim("        provider: ollama"));
          console.log(chalk.dim("        base_url: http://gpu-box.corp:11434"));
        }
        if (baseURL !== "https://api.anthropic.com" && baseURL !== "https://api.openai.com/v1" &&
            baseURL !== "http://localhost:11434") {
          console.log();
          console.log(chalk.dim(`    Verify endpoint: curl -s ${baseURL}`));
        }
        console.log();
        console.log(chalk.dim("  For full diagnostics run: ctx doctor"));
        console.log();
      }

      process.exit(available ? 0 : 1);
    });
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Report where the API key was actually resolved from so the user
 * knows which path fired. Resolution order: env var > yaml > none.
 */
function resolveKeySource(
  providerName: string,
  envVar: string,
  config: CtxConfig | null,
): string {
  if (providerName === "ollama") return "not required (local)";

  const envVarName = envVar;
  if (process.env[envVarName] && process.env[envVarName]!.trim() !== "") {
    const key = process.env[envVarName]!;
    const masked = key.length > 12
      ? key.slice(0, 8) + "..." + key.slice(-4)
      : "****";
    return `${envVarName} env var (${masked})`;
  }

  if (config?.ai?.api_key && config.ai.api_key.trim() !== "") {
    const key = config.ai.api_key;
    const masked = key.length > 12
      ? key.slice(0, 8) + "..." + key.slice(-4)
      : "****";
    return `ctx.yaml ai.api_key (${masked})`;
  }

  return "not set — see fix below";
}
