import { describe, expect, test } from "bun:test";
import { parseBedrockFoundationModels, parseBedrockInferenceProfiles } from "./model-catalog";

describe("Amazon Bedrock model lists", () => {
  test("keeps text models and drops embeddings", () => {
    const models = parseBedrockFoundationModels({
      modelSummaries: [
        {
          modelId: "anthropic.claude-haiku-4-5",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
        },
        {
          modelId: "amazon.titan-embed-text-v2:0",
          inputModalities: ["TEXT"],
          outputModalities: ["EMBEDDING"],
        },
        {
          modelId: "stability.stable-image",
          inputModalities: ["TEXT"],
          outputModalities: ["IMAGE"],
        },
      ],
    });

    expect(models).toEqual(["anthropic.claude-haiku-4-5"]);
  });

  test("reads inference profile ids", () => {
    const models = parseBedrockInferenceProfiles({
      inferenceProfileSummaries: [
        { inferenceProfileId: "us.anthropic.claude-sonnet-4-6" },
        { inferenceProfileId: "us.amazon.nova-pro-v1:0" },
        { inferenceProfileId: 12 },
      ],
    });

    expect(models).toEqual([
      "us.anthropic.claude-sonnet-4-6",
      "us.amazon.nova-pro-v1:0",
    ]);
  });

  test("returns nothing for a payload that is not a Bedrock list", () => {
    expect(parseBedrockFoundationModels({ data: [{ id: "gpt" }] })).toEqual([]);
    expect(parseBedrockInferenceProfiles(null)).toEqual([]);
  });
});
