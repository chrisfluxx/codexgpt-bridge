import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRIDGE_IMAGE_TOKEN_RESERVE,
  BRIDGE_ORIGINAL_IMAGE_TOKEN_RESERVE,
  BRIDGE_PLATFORM_RESERVE_TOKENS,
  estimateBridgeInputTokenBreakdown,
  estimateBridgeInputTokens,
  estimateBridgeTextTokens,
} from "./input-tokens.js";

describe("Bridge input token accounting", () => {
  it("uses the GPT tokenizer instead of a fixed byte ratio", () => {
    const english = "ordinary English prose ".repeat(1_000);
    const denseJson = '{"value":1234567890}'.repeat(1_000);

    assert.notEqual(
      estimateBridgeTextTokens(english),
      Math.ceil(Buffer.byteLength(english) / 3),
    );
    assert.notEqual(
      estimateBridgeTextTokens(denseJson),
      Math.ceil(Buffer.byteLength(denseJson) / 3),
    );
  });

  it("includes platform reserve and de-duplicated image reserves", () => {
    const text = "目前內容";
    const tokens = estimateBridgeInputTokens({
      instructions: text,
      history: [],
      prompt: "",
      images: [
        { ref: "one", imageUrl: "data:image/png;base64,one" },
        {
          ref: "duplicate",
          imageUrl: "data:image/png;base64,one",
          detail: "original",
        },
        { ref: "two", imageUrl: "data:image/png;base64,two" },
      ],
    });

    assert.equal(
      tokens,
      BRIDGE_PLATFORM_RESERVE_TOKENS +
        estimateBridgeTextTokens(text) +
        BRIDGE_ORIGINAL_IMAGE_TOKEN_RESERVE +
        BRIDGE_IMAGE_TOKEN_RESERVE,
    );
  });

  it("exposes the same bounded token estimate as an auditable breakdown", () => {
    const input = {
      instructions: "system",
      history: ["retained turn"],
      conversationHistory: "browser history",
      contract: "tool contract",
      prompt: "current prompt",
      images: [
        {
          ref: "image",
          imageUrl: "data:image/png;base64,receipt",
          detail: "original",
        },
      ],
    } as const;
    const breakdown = estimateBridgeInputTokenBreakdown(input);

    assert.equal(breakdown.total, estimateBridgeInputTokens(input));
    assert.equal(breakdown.platformReserve, BRIDGE_PLATFORM_RESERVE_TOKENS);
    assert.equal(breakdown.imageReserve, BRIDGE_ORIGINAL_IMAGE_TOKEN_RESERVE);
    assert.equal(breakdown.imageCount, 1);
    assert.equal(
      breakdown.textCharacters,
      input.instructions.length +
        input.history[0].length +
        input.conversationHistory.length +
        input.contract.length +
        input.prompt.length,
    );
    assert.equal(
      breakdown.total,
      breakdown.text + breakdown.platformReserve + breakdown.imageReserve,
    );
  });
});
