import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeOriginalProviderBaseUrl,
  originalProviderBaseUrlFromConfig,
  parseOriginalProviderAssignment,
} from "./provider-upstream.js";

describe("original Codex provider discovery", () => {
  it("captures a top-level route without assuming a product or port", () => {
    assert.equal(
      originalProviderBaseUrlFromConfig(
        'model = "router/model"\nopenai_base_url = "https://models.example.test/custom/v1/" # owner\n',
      ),
      "https://models.example.test/custom/v1",
    );
  });

  it("resolves the active custom model provider table", () => {
    assert.equal(
      originalProviderBaseUrlFromConfig(
        [
          'model_provider = "company-router"',
          "[model_providers.unused]",
          'base_url = "https://unused.example/v1"',
          '[model_providers."company-router"]',
          "base_url = 'http://127.0.0.1:43123/responses/v1'",
          'wire_api = "responses"',
          "",
        ].join("\n"),
      ),
      "http://127.0.0.1:43123/responses/v1",
    );
  });

  it("uses the built-in provider when no custom base URL is active", () => {
    assert.equal(
      originalProviderBaseUrlFromConfig('model = "gpt"\n'),
      undefined,
    );
    assert.equal(
      originalProviderBaseUrlFromConfig('model_provider = "openai"\n'),
      undefined,
    );
  });

  it("reads an exact saved assignment for old journal migration", () => {
    assert.equal(
      parseOriginalProviderAssignment(
        "  openai_base_url = 'https://old-router.example/v1/' # preserved\r\n",
      ),
      "https://old-router.example/v1",
    );
    assert.equal(parseOriginalProviderAssignment(""), undefined);
  });

  it("rejects unresolved providers, unsafe URLs and Bridge loops", () => {
    assert.throws(
      () =>
        originalProviderBaseUrlFromConfig(
          'model_provider = "missing-provider"\n',
        ),
      /does not have a literal base_url/u,
    );
    assert.throws(
      () =>
        normalizeOriginalProviderBaseUrl("https://user:secret@example.test/v1"),
      /cannot contain credentials/u,
    );
    assert.throws(
      () =>
        normalizeOriginalProviderBaseUrl(
          "http://127.0.0.1:7767/original/v1",
          "http://127.0.0.1:7767/v1",
        ),
      /proxy loop/u,
    );
  });
});
