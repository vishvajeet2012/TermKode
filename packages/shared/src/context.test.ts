import { describe, expect, test } from "bun:test";
import {
  COMPACTION_THRESHOLD,
  estimateMessagesTokens,
  estimateTokens,
  formatTokenCount,
  getModelContextWindow,
  measureContext,
} from "./context";

describe("getModelContextWindow", () => {
  test("knows the families it lists", () => {
    expect(getModelContextWindow("anthropic/claude-sonnet-4-6")).toBe(200_000);
    expect(getModelContextWindow("openai/gpt-5.4")).toBe(272_000);
  });

  test("gives a local runtime a small window rather than an optimistic one", () => {
    expect(getModelContextWindow("local/qwen2.5-coder:7b")).toBe(32_768);
  });

  test("falls back to a conservative default for an unknown model", () => {
    expect(getModelContextWindow("someprovider/model-released-tomorrow")).toBe(128_000);
  });

  test("matches case-insensitively", () => {
    expect(getModelContextWindow("anthropic/Claude-Opus-4-6")).toBe(200_000);
  });
});

describe("estimateTokens", () => {
  test("counts roughly four characters per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("serializes anything that is not a string", () => {
    expect(estimateTokens({ a: 1 })).toBeGreaterThan(0);
  });

  test("adds per-message overhead", () => {
    expect(estimateMessagesTokens([{ role: "user" }])).toBeGreaterThan(4);
  });
});

describe("measureContext", () => {
  test("stays quiet while there is room", () => {
    const budget = measureContext([{ text: "short" }], "anthropic/claude-sonnet-4-6");
    expect(budget.shouldCompact).toBe(false);
    expect(budget.contextWindow).toBe(200_000);
  });

  test("asks for compaction once the window is nearly full", () => {
    // 32k window, so ~26k tokens is past the threshold.
    const big = { text: "x".repeat(4 * 30_000) };
    const budget = measureContext([big], "local/llama");

    expect(budget.usedFraction).toBeGreaterThan(COMPACTION_THRESHOLD);
    expect(budget.shouldCompact).toBe(true);
  });
});

describe("formatTokenCount", () => {
  test("shortens large counts", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_400)).toBe("12k");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});
