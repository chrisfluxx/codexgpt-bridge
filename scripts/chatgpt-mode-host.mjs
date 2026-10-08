import { ChatGptBrowserController } from "../apps/desktop/dist/main/chatgpt-browser.js";
import { ChromeChatGptHost } from "../apps/desktop/dist/main/chrome-chatgpt-window.js";
import * as ChatGptSessionProbe from "../apps/desktop/dist/main/chatgpt-session-probe.js";
import "./chatgpt-dom-host.mjs";

globalThis.ChatGptBrowserController = ChatGptBrowserController;
globalThis.ChromeChatGptHost = ChromeChatGptHost;
globalThis.ChatGptSessionProbe = ChatGptSessionProbe;
