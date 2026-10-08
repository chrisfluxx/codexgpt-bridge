import { get_encoding, type Tiktoken } from "tiktoken";
import type { CompiledResponsesImage } from "./prompt.js";

/** Hidden ChatGPT product instructions, tool routing, and response framing. */
export const BRIDGE_PLATFORM_RESERVE_TOKENS = 8_192;
export const BRIDGE_IMAGE_TOKEN_RESERVE = 4_096;
export const BRIDGE_ORIGINAL_IMAGE_TOKEN_RESERVE = 8_192;

const TOKENIZER_CHUNK_CHARS = 4_096;
let tokenizer: Tiktoken | undefined;

function bridgeTokenizer(): Tiktoken {
  tokenizer ??= get_encoding("o200k_base");
  return tokenizer;
}

/**
 * Count text with the GPT-5 tokenizer instead of a byte/character ratio.
 * Independent chunks may only over-count boundary merges, which is the safe
 * direction for enforcing a browser input limit.
 */
export function estimateBridgeTextTokens(text: string): number {
  if (!text) return 0;
  const encoding = bridgeTokenizer();
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (
        previous >= 0xd800 &&
        previous <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      ) {
        end -= 1;
      }
    }
    count += encoding.encode_ordinary(text.slice(start, end)).length;
    start = end;
  }
  return count;
}

export function bridgeImageTokenReserve(detail?: string): number {
  return detail === "original"
    ? BRIDGE_ORIGINAL_IMAGE_TOKEN_RESERVE
    : BRIDGE_IMAGE_TOKEN_RESERVE;
}

export interface BridgeInputTokenEstimate {
  readonly instructions: string;
  readonly history: readonly string[];
  readonly conversationHistory?: string;
  readonly contract?: string;
  readonly prompt: string;
  readonly images: readonly CompiledResponsesImage[];
}

export interface BridgeInputTokenBreakdown {
  /** Complete conservative estimate used by the send gate. */
  readonly total: number;
  /** Tokenized instructions, retained history, contracts and current prompt. */
  readonly text: number;
  /** UTF-16 character count for the same complete text surface. */
  readonly textCharacters: number;
  /** Fixed allowance for hidden ChatGPT product framing. */
  readonly platformReserve: number;
  /** Deduplicated allowance for normal/original image inputs. */
  readonly imageReserve: number;
  /** Number of distinct image payloads included in the reserve. */
  readonly imageCount: number;
}

/** Produce the auditable parts of the conservative browser-input estimate. */
export function estimateBridgeInputTokenBreakdown(
  input: BridgeInputTokenEstimate,
): BridgeInputTokenBreakdown {
  const textParts = [
    input.instructions,
    ...input.history,
    input.conversationHistory ?? "",
    input.contract ?? "",
    input.prompt,
  ];
  const text = textParts.reduce(
    (total, value) => total + estimateBridgeTextTokens(value),
    0,
  );
  const images = new Map<string, number>();
  for (const image of input.images) {
    images.set(
      image.imageUrl,
      Math.max(
        images.get(image.imageUrl) ?? 0,
        bridgeImageTokenReserve(image.detail),
      ),
    );
  }
  const imageReserve = [...images.values()].reduce(
    (total, tokens) => total + tokens,
    0,
  );
  return {
    total: BRIDGE_PLATFORM_RESERVE_TOKENS + text + imageReserve,
    text,
    textCharacters: textParts.reduce((total, value) => total + value.length, 0),
    platformReserve: BRIDGE_PLATFORM_RESERVE_TOKENS,
    imageReserve,
    imageCount: images.size,
  };
}

/** Estimate the complete model-visible input, including retained chat context. */
export function estimateBridgeInputTokens(
  input: BridgeInputTokenEstimate,
): number {
  return estimateBridgeInputTokenBreakdown(input).total;
}
