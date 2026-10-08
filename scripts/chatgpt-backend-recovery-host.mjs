import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import "./chatgpt-dom-host.mjs";

const controllerModule = process.env.CODEXGPT_BRIDGE_BACKEND_TEST_CONTROLLER
  ? pathToFileURL(process.env.CODEXGPT_BRIDGE_BACKEND_TEST_CONTROLLER).href
  : new URL("../apps/desktop/dist/main/chatgpt-browser.js", import.meta.url)
      .href;
globalThis.ChatGptBrowserController = (
  await import(controllerModule)
).ChatGptBrowserController;
