/**
 * Cost accounting.
 *
 * Trap 18: prices must come from `getModelsForProvider(providerId)` in `@cline/llms`
 * (`pricing.input` / `output` / `cacheRead` / `cacheWrite`, USD per million tokens). The
 * static table below is only a fallback for when the catalog has no entry.
 */
import { getModelsForProvider } from "@cline/llms";
import { inrPerUsd } from "../config.ts";
import type { UsageTotals } from "../types.ts";

export interface TokenUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelPricingLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Static fallback, USD per million tokens. Only used when the catalog lacks the model. */
export const CLAUDE_FALLBACK_PRICING: Record<string, ModelPricingLike> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costInr: 0,
    byStage: {},
  };
}

export function addUsage(target: UsageTotals, add: UsageTotals): UsageTotals {
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.cacheReadTokens += add.cacheReadTokens;
  target.cacheWriteTokens += add.cacheWriteTokens;
  target.costUsd = round(target.costUsd + add.costUsd);
  target.costInr = round(target.costInr + add.costInr);
  return target;
}

export function recordStage(
  totals: UsageTotals,
  stage: string,
  usage: UsageTotals
): UsageTotals {
  if (!totals.byStage) totals.byStage = {};
  const current = totals.byStage[stage] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, costInr: 0 };
  current.inputTokens += usage.inputTokens;
  current.outputTokens += usage.outputTokens;
  current.costUsd = round(current.costUsd + usage.costUsd);
  current.costInr = round(current.costInr + usage.costInr);
  totals.byStage[stage] = current;
  return totals;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function usd(tokens: number, pricePerMillion?: number): number {
  if (!pricePerMillion || !Number.isFinite(pricePerMillion)) return 0;
  return (tokens / 1_000_000) * pricePerMillion;
}

/** Prices USD → USD + INR. */
export function computeCost(usage: TokenUsageLike, pricing: ModelPricingLike | undefined): UsageTotals {
  const costUsd = round(
    usd(usage.inputTokens, pricing?.input) +
      usd(usage.outputTokens, pricing?.output) +
      usd(usage.cacheReadTokens, pricing?.cacheRead) +
      usd(usage.cacheWriteTokens, pricing?.cacheWrite)
  );
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd,
    costInr: round(costUsd * inrPerUsd()),
  };
}

/** Looks a model up in the live catalog, falling back to the static table. */
export async function resolvePricing(
  providerId: string,
  modelId: string
): Promise<ModelPricingLike | undefined> {
  try {
    const models = await getModelsForProvider(providerId);
    const pricing = models?.[modelId]?.pricing;
    if (pricing) return pricing as ModelPricingLike;
  } catch {
    // The catalog is optional; fall through to the static table.
  }
  return CLAUDE_FALLBACK_PRICING[modelId];
}
