import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";
import { readModelSlider } from "../apps/desktop/dist/main/model-picker-surface.js";
import { observeModelMenu } from "../apps/desktop/dist/main/model-menu.js";
import {
  observeModelSelection,
  verifyModelSelection,
} from "../apps/desktop/dist/main/model-selection.js";

const thumb =
  '<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span>';
const proxy = (inner = thumb, attributes = "") =>
  `<div id="proxy" role="menuitem" tabindex="0" aria-keyshortcuts="ArrowLeft ArrowRight" ${attributes} style="width:200px;height:30px">${inner}</div>`;
const ordinalProxy = (status, attributes = "") =>
  `<span role="status" style="position:absolute;width:1px;height:1px">${status}</span>${proxy("<span>○ ○ ● ○ ○</span>", attributes)}`;
const cases = [
  {
    name: "hidden thumb without legacy wrapper",
    body: proxy(),
    accepted: true,
  },
  {
    name: "legacy wrapper",
    body: proxy(
      `<div data-model-reasoning-effort-slider style="width:200px;height:24px">${thumb}</div>`,
    ),
    accepted: true,
  },
  {
    name: "roving keyboard proxy with hidden numeric thumb",
    body: proxy().replace('tabindex="0"', 'tabindex="-1"'),
    accepted: true,
  },
  {
    name: "disabled roving keyboard proxy",
    body: proxy(thumb, 'aria-disabled="true"').replace(
      'tabindex="0"',
      'tabindex="-1"',
    ),
    accepted: true,
    disabled: true,
  },
  {
    name: "sliderless Traditional Chinese ordinal status",
    body: ordinalProxy("5.6 高，第 3 個，共 5 個。"),
    accepted: true,
  },
  {
    name: "sliderless Traditional Chinese item ordinal status",
    body: ordinalProxy("6 High，第 3 項，共 5 項。"),
    accepted: true,
  },
  {
    name: "sliderless Simplified Chinese item ordinal status",
    body: ordinalProxy("6 High，第 3 项，共 5 项。"),
    accepted: true,
  },
  {
    name: "sliderless English ordinal status",
    body: ordinalProxy("5.6 High, position 3 of 5."),
    accepted: true,
  },
  {
    name: "sliderless roving ordinal proxy",
    body: ordinalProxy("5.6 High, position 3 of 5.").replace(
      'tabindex="0"',
      'tabindex="-1"',
    ),
    accepted: true,
  },
  {
    name: "disabled sliderless ordinal proxy",
    body: ordinalProxy("5.6 High, 3 of 5.", 'aria-disabled="true"'),
    accepted: true,
    disabled: true,
  },
  {
    name: "disabled proxy",
    body: proxy(thumb, 'aria-disabled="true"'),
    accepted: true,
    disabled: true,
  },
  {
    name: "locked thumb",
    body: proxy(
      thumb.replace('role="slider"', 'role="slider" data-locked="true"'),
    ),
    accepted: true,
    disabled: true,
  },
  {
    name: "hidden unrelated numeric state",
    body: thumb,
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "keyboard menu without numeric state",
    body: proxy("High"),
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "invalid sliderless ordinal status",
    body: ordinalProxy("5.6 High, position 6 of 5."),
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "nonfocusable proxy",
    body: proxy().replace('tabindex="0"', ""),
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "hidden parent",
    body: `<div aria-hidden="true">${proxy()}</div>`,
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "inert thumb",
    body: proxy(thumb.replace('role="slider"', 'role="slider" inert')),
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "ambiguous proxies",
    body: proxy() + proxy().replace('id="proxy"', 'id="other"'),
    accepted: false,
  },
  {
    name: "invalid numeric state",
    body: proxy(thumb.replace('aria-valuenow="2"', 'aria-valuenow="99"')),
    accepted: false,
  },
  {
    name: "missing numeric state",
    body: proxy(thumb.replace('aria-valuemax="4"', "")),
    accepted: false,
    menuMustNotBeSlider: true,
  },
  {
    name: "outside owned menu",
    body: "",
    outside: proxy(),
    accepted: false,
    menuMustNotBeSlider: true,
  },
];
const directory = await mkdtemp(join(tmpdir(), "bridge-slider-contract-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-dom-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  const page = await app.firstWindow();
  for (const fixture of cases) {
    await page.setContent(
      `<main><div id="owned" role="menu">${fixture.body}</div></main>${fixture.outside ?? ""}`,
    );
    const result = await page.evaluate(`(() => {
      const roots = () => [document.querySelector('#owned')];
      return {
        menu: (${observeModelMenu.toString()})(roots),
        slider: (${readModelSlider.toString()})(roots, true),
        focused: document.activeElement.id,
      };
    })()`);
    if (fixture.accepted) {
      assert.equal(result.menu, "slider", fixture.name);
      assert.deepEqual(
        result.slider,
        { min: 0, max: 4, value: 2, disabled: fixture.disabled === true },
        fixture.name,
      );
      assert.equal(
        result.focused,
        fixture.disabled ? "" : "proxy",
        fixture.name,
      );
    } else {
      assert.equal(result.slider, undefined, fixture.name);
      assert.equal(result.focused, "", fixture.name);
      if (fixture.menuMustNotBeSlider)
        assert.notEqual(result.menu, "slider", fixture.name);
    }
    process.stdout.write(fixture.name + ": passed\n");
  }
  for (const [name, control, checked, description, accepted] of [
    [
      "localized model and effort",
      "5.6 Sol 極高",
      "GPT-5.6 Sol",
      "5.6 Sol 極高，第 4 個，共 5 個。",
      true,
    ],
    [
      "English model prefix alias",
      "5.6 Sol Extra High",
      "GPT-5.6 Sol",
      "5.6 Sol Extra High, position 4 of 5.",
      true,
    ],
    [
      "conflicting selected families",
      "5.6 Sol 極高",
      "6",
      "5.6 Sol 極高，第 4 個，共 5 個。",
      false,
    ],
    [
      "conflicting active version",
      "5.6 Sol 極高",
      "GPT-5.6 Sol",
      "6 極高，第 4 個，共 5 個。",
      false,
    ],
  ]) {
    await page.setContent(
      `<main><form><div id="prompt-textarea" contenteditable="true" style="width:400px;min-height:30px"></div><button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">${control}</button></form><div id="owned" role="menu" data-testid="composer-intelligence-picker-content"><button role="menuitemradio" aria-checked="true">${checked}</button><span id="native-status" role="status">${description}</span>${proxy(thumb.replace('aria-valuenow="2"', 'aria-valuenow="3"'), 'aria-describedby="native-status"')}</div></main>`,
    );
    const observed = await page.evaluate(
      `(${observeModelSelection.toString()})(() => [document.querySelector('#owned')])`,
    );
    const receipt = verifyModelSelection(
      "localized-contract",
      "extra-high",
      "bridge-native:5.6",
      observed,
    );
    assert.equal(
      receipt.confidence,
      accepted ? "UI_VERIFIED" : "REJECTED",
      JSON.stringify({ name, observed }),
    );
    if (accepted) {
      assert.equal(observed.model, "GPT-5.6 Sol");
      assert.equal(observed.ambiguous, false);
    }
    if (name === "conflicting selected families")
      assert.equal(observed.ambiguous, true);
    process.stdout.write(name + ": passed\n");
  }
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
