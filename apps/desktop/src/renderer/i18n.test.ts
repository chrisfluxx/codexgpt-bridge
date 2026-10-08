import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOGS, translator } from "./i18n.js";

describe("renderer i18n catalog", () => {
  it("keeps complete, non-empty English, Traditional Chinese, Simplified Chinese, Japanese and Korean catalogs", () => {
    const expected = Object.keys(CATALOGS.en).sort();
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      assert.deepEqual(Object.keys(catalog).sort(), expected, locale);
      assert.equal(
        Object.values(catalog).every((value) => value.trim().length > 0),
        true,
        locale,
      );
    }
  });

  it("interpolates stage values", () => {
    assert.equal(
      translator("zh-TW")("stageCooldown", { seconds: 12 }),
      "限流冷卻中，約 12 秒",
    );
  });
});
