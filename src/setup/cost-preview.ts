/**
 * Cost preview for the first ingest — the single biggest trust-builder
 * in the Setup axis. Surprise spend is the #1 reason a new user
 * distrusts the tool. We'd rather prompt once than silently bill $2.
 *
 * The estimator is deliberately rough: we over-estimate input tokens
 * (4 chars / token), use the resolved pricing table (with any user
 * ai.pricing overrides applied), and round UP so real spend almost
 * always beats the preview.
 *
 * Behaviour:
 *   - Runs before the Claude call in `ctx setup` and `ctx ingest`.
 *   - Prints a one-block summary: docs, pages target, model, estimate.
 *   - Prompts unless `-y` / `--yes` or non-TTY (CI, pipes).
 *   - Env var CTX_SKIP_COST_PREVIEW=1 also bypasses (for scripts).
 */

import chalk from "chalk";
import { createInterface } from "node:readline";
import { resolvePricing } from "../usage/recorder.js";

export interface CostPreviewInput {
  /** Human-friendly operation name shown in the header. */
  operation: string;
  /** How many source documents will be compiled. */
  documentCount: number;
  /** Combined size of the input payload in characters. */
  totalChars: number;
  /** Model the LLM client will actually use. */
  model: string;
  /** Upper bound on output tokens we'll allow the model to emit. */
  maxOutputTokens: number;
  /** Non-interactive mode (skip the prompt, still print the summary). */
  skipPrompt: boolean;
}

export interface CostPreviewResult {
  /** Rough estimated cost in USD. */
  estimatedCostUsd: number;
  /** Rough estimated input tokens. */
  estimatedInputTokens: number;
  /** Did the user approve (or was the prompt skipped)? */
  approved: boolean;
}

/**
 * Very rough char→token heuristic. Claude + GPT both sit around
 * ~4 chars per token for English. We round UP so the estimate is
 * a pessimistic upper bound, not a wishful lower bound.
 */
function charsToTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function formatUsd(amount: number): string {
  if (amount < 0.01) return "<$0.01";
  if (amount < 1) return `~$${amount.toFixed(3)}`;
  return `~$${amount.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}k`;
  return `${tokens}`;
}

async function promptConfirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(defaultYes);
      else resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Print a cost preview block and optionally prompt for confirmation.
 *
 * Call this BEFORE the LLM call. If it returns `approved: false`, the
 * caller should abort cleanly and not charge a single token.
 */
export async function previewCost(
  input: CostPreviewInput
): Promise<CostPreviewResult> {
  const estimatedInputTokens = charsToTokens(input.totalChars) + 200; // +200 system prompt overhead
  const pricing =
    resolvePricing(input.model) ??
    resolvePricing("claude-sonnet-4") ??
    { input: 3, output: 15 };

  const inputCost = (estimatedInputTokens / 1_000_000) * pricing.input;
  const outputCost = (input.maxOutputTokens / 1_000_000) * pricing.output;
  const estimatedCostUsd = inputCost + outputCost;

  // Skip everything for scripted callers.
  if (process.env.CTX_SKIP_COST_PREVIEW === "1") {
    return { estimatedCostUsd, estimatedInputTokens, approved: true };
  }

  // Always print the summary — users want to see what was estimated
  // even when they passed -y.
  console.log();
  console.log(chalk.bold(`  Cost preview — ${input.operation}`));
  console.log(
    `    ${chalk.dim("Documents:    ")}${chalk.bold(String(input.documentCount))}`
  );
  console.log(
    `    ${chalk.dim("Input size:   ")}~${formatTokens(estimatedInputTokens)} tokens`
  );
  console.log(
    `    ${chalk.dim("Output cap:   ")}~${formatTokens(input.maxOutputTokens)} tokens`
  );
  console.log(`    ${chalk.dim("Model:        ")}${input.model}`);
  console.log(
    `    ${chalk.dim("Estimate:     ")}${chalk.yellow(formatUsd(estimatedCostUsd))}`
  );
  console.log(
    chalk.dim(
      `    (rough — based on ${pricing.input}/${pricing.output} USD per 1M in/out tokens)`
    )
  );
  console.log();

  if (input.skipPrompt) {
    return { estimatedCostUsd, estimatedInputTokens, approved: true };
  }

  const approved = await promptConfirm(
    chalk.bold("  Continue? [Y/n] "),
    true
  );
  if (!approved) {
    console.log(chalk.dim("  Cancelled — no tokens spent."));
    console.log();
  }
  return { estimatedCostUsd, estimatedInputTokens, approved };
}
