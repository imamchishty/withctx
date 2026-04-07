import type { CtxDirectory } from "../storage/ctx-dir.js";

export type OperationType =
  | "ingest"
  | "sync"
  | "query"
  | "add"
  | "lint"
  | "chat";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostEntry {
  timestamp: string;
  operation: OperationType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface MonthlyCosts {
  month: string; // "YYYY-MM"
  entries: CostEntry[];
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface CostData {
  monthly: Record<string, MonthlyCosts>;
  budget?: number;
  alertAt?: number; // percentage (0-100)
}

/**
 * Model pricing in dollars per million tokens.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-haiku-3.5": { input: 0.8, output: 4.0 },
};

/**
 * Tracks token usage and costs per operation.
 * Reads/writes .ctx/costs.json for persistence.
 */
export class CostTracker {
  private ctx: CtxDirectory;
  private data: CostData;
  private budget?: number;
  private alertAt: number;

  constructor(
    ctx: CtxDirectory,
    options?: { budget?: number; alertAt?: number }
  ) {
    this.ctx = ctx;
    this.budget = options?.budget;
    this.alertAt = options?.alertAt ?? 80;

    // Load existing cost data
    const existing = ctx.readCosts();
    if (existing && isValidCostData(existing)) {
      this.data = existing as CostData;
    } else {
      this.data = { monthly: {} };
    }

    if (this.budget) {
      this.data.budget = this.budget;
    }
    this.data.alertAt = this.alertAt;
  }

  /**
   * Record token usage for an operation.
   */
  record(
    operation: OperationType,
    usage: TokenUsage,
    model: string = "claude-sonnet-4"
  ): CostEntry {
    const cost = calculateCost(model, usage);
    const entry: CostEntry = {
      timestamp: new Date().toISOString(),
      operation,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost,
    };

    const monthKey = entry.timestamp.slice(0, 7); // "YYYY-MM"

    if (!this.data.monthly[monthKey]) {
      this.data.monthly[monthKey] = {
        month: monthKey,
        entries: [],
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
    }

    const month = this.data.monthly[monthKey];
    month.entries.push(entry);
    month.totalCost += cost;
    month.totalInputTokens += usage.inputTokens;
    month.totalOutputTokens += usage.outputTokens;

    this.save();

    return entry;
  }

  /**
   * Get the current month's total cost.
   */
  getCurrentMonthCost(): number {
    const monthKey = new Date().toISOString().slice(0, 7);
    return this.data.monthly[monthKey]?.totalCost ?? 0;
  }

  /**
   * Get cost data for a specific month.
   */
  getMonth(monthKey: string): MonthlyCosts | null {
    return this.data.monthly[monthKey] ?? null;
  }

  /**
   * Get all cost data.
   */
  getData(): CostData {
    return this.data;
  }

  /**
   * Check if the budget alert threshold has been reached.
   * Returns null if no budget is set, or the percentage used.
   */
  checkBudget(): { percentUsed: number; alert: boolean } | null {
    const budget = this.data.budget ?? this.budget;
    if (!budget) return null;

    const currentCost = this.getCurrentMonthCost();
    const percentUsed = (currentCost / budget) * 100;
    const alertThreshold = this.data.alertAt ?? this.alertAt;

    return {
      percentUsed,
      alert: percentUsed >= alertThreshold,
    };
  }

  /**
   * Get per-operation breakdown for the current month.
   */
  getOperationBreakdown(): Record<
    OperationType,
    { count: number; cost: number; tokens: number }
  > {
    const monthKey = new Date().toISOString().slice(0, 7);
    const month = this.data.monthly[monthKey];

    const breakdown: Record<
      OperationType,
      { count: number; cost: number; tokens: number }
    > = {
      ingest: { count: 0, cost: 0, tokens: 0 },
      sync: { count: 0, cost: 0, tokens: 0 },
      query: { count: 0, cost: 0, tokens: 0 },
      add: { count: 0, cost: 0, tokens: 0 },
      lint: { count: 0, cost: 0, tokens: 0 },
      chat: { count: 0, cost: 0, tokens: 0 },
    };

    if (!month) return breakdown;

    for (const entry of month.entries) {
      const op = breakdown[entry.operation];
      op.count++;
      op.cost += entry.cost;
      op.tokens += entry.inputTokens + entry.outputTokens;
    }

    return breakdown;
  }

  private save(): void {
    this.ctx.writeCosts(this.data as unknown as Record<string, unknown>);
  }
}

/**
 * Calculate cost in dollars for a given model and token usage.
 */
function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4"];
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

function isValidCostData(data: unknown): data is CostData {
  return (
    typeof data === "object" &&
    data !== null &&
    "monthly" in data &&
    typeof (data as Record<string, unknown>).monthly === "object"
  );
}
