/* global document, window, AbortController, URL, fetch */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const executable = process.argv
  .find((arg) => arg.startsWith("--executable="))
  ?.slice(13);
const directory = await mkdtemp(join(tmpdir(), "bridge-parity-"));
const userData = join(directory, "profile");
const codexHome = join(directory, "codex");
const cli = join(root, "apps", "cli", "dist", "main.js");
let application;
try {
  await mkdir(userData);
  await mkdir(codexHome);
  await writeFile(
    join(userData, "desktop-settings.json"),
    JSON.stringify({
      locale: "zh-CN",
      temporaryChat: false,
      chatGptProjects: { enabled: false },
      webToolMode: "full",
      fullMcpConnectorName: "CodexGPT Bridge",
    }),
  );
  application = await electron.launch({
    executablePath: executable
      ? resolve(executable)
      : createRequire(import.meta.url)("electron"),
    args: executable ? [] : [root],
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: userData,
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_AVAILABLE_WEB_MODES_JSON:
        '["instant","medium","high","extra-high","pro"]',
    },
  });
  const page = await application.firstWindow();
  await page.getByRole("heading", { name: "高级设置" }).waitFor();
  const check = async (label) => {
    await page.getByLabel(label).click();
    await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll("label")]
          .find((node) => node.innerText.includes(label))
          ?.querySelector("input")?.checked === true,
      label,
    );
  };
  await check("每个 Codex 回合开启新 ChatGPT 对话");
  await check("自动点击连接器工具的“允许一次”");
  await page.locator('input[name="silenceTimeoutSeconds"]').fill("123");
  await page
    .locator("form")
    .filter({ has: page.locator('input[name="silenceTimeoutSeconds"]') })
    .getByRole("button")
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector('select[aria-label="ChatGPT 发送方式"]')
        ?.disabled,
  );
  await page.getByLabel("ChatGPT 发送方式").selectOption("manual");
  await check("在手动模式启用 Pro 模型");
  await page.waitForFunction(
    () =>
      !document.querySelector('select[aria-label="ChatGPT 发送方式"]')
        ?.disabled,
  );
  const settings = JSON.parse(
    await readFile(join(userData, "desktop-settings.json"), "utf8"),
  );
  assert.equal(settings.interactionMode, "manual");
  assert.equal(settings.manualPro, true);
  assert.equal(settings.freshConversationPerTurn, true);
  assert.equal(settings.autoApproveToolCalls, true);
  assert.equal(settings.silenceTimeoutSeconds, 123);
  const baseline = await page.evaluate(() =>
    window.codexgptBridge.getWebProviderStatus(),
  );
  const controlFile = join(directory, "control.json");
  const mcp = await application.evaluate(
    async ({ app, ipcMain, clipboard }, { baseline, controlFile }) => {
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(`${app.getAppPath()}/package.json`);
      const { join } = require("node:path");
      const { writeFile } = require("node:fs/promises");
      const root = app.getAppPath();
      const gatewayModule = require(
        join(root, "packages", "responses-gateway", "dist", "index.js"),
      );
      const { ManualTurns } = require(
        join(root, "apps", "desktop", "dist", "main", "manual-turns.js"),
      );
      const broker = new gatewayModule.FullTurnBroker();
      const host = new ManualTurns(broker);
      const abort = new AbortController();
      const server = new gatewayModule.FullTurnMcpServer(
        broker,
        (token, text) => host.complete(token, text),
        (token) => host.assertSent(token),
      );
      const address = await server.start();
      const token = broker.register("desktop-manual-fixture", [], true);
      const status = () => ({
        ...baseline,
        installed: true,
        running: true,
        toolMode: "full",
        manualTasks: host.tasks(),
      });
      const gateway = new gatewayModule.ResponsesGateway({
        host: "127.0.0.1",
        port: 0,
        admin: {
          token: "a".repeat(64),
          onCommand: async (name) => {
            if (name === "provider:status") return status();
            throw new Error("Unsupported fixture command");
          },
        },
        runWebTurn: async () => "unused",
      });
      const endpoint = await gateway.start();
      await writeFile(
        controlFile,
        JSON.stringify({
          version: 1,
          endpoint: new URL(endpoint.baseUrl).origin,
          token: "a".repeat(64),
          instanceId: "test",
        }),
      );
      for (const name of [
        "provider:status",
        "manual:sent",
        "manual:complete",
        "manual:acknowledge",
        "manual:copy",
        "manual:cancel",
      ])
        ipcMain.removeHandler(name);
      ipcMain.handle("provider:status", status);
      ipcMain.handle("manual:sent", (_event, id) => host.sent(id));
      ipcMain.handle("manual:complete", (_event, id, text) =>
        host.completeFromUser(id, text),
      );
      ipcMain.handle("manual:acknowledge", (_event, id, ack) =>
        host.acknowledge(id, ack),
      );
      ipcMain.handle("manual:copy", (_event, id) =>
        clipboard.writeText(host.tasks().find((task) => task.id === id).prompt),
      );
      ipcMain.handle("manual:cancel", (_event, id) => host.cancel(id));
      const compiled = gatewayModule.compileResponsesPrompt({
        input: "Complete this manual fixture without opening a ChatGPT page.",
      });
      const fixture = {
        broker,
        host,
        abort,
        server,
        gateway,
        result: undefined,
        failure: undefined,
      };
      globalThis.parityFixture = fixture;
      fixture.work = host
        .runTurn({
          turnToken: token,
          threadId: "manual-ui-thread",
          turnId: "manual-ui-turn",
          mode: "high",
          modelFamily: "6.1",
          prompt: compiled.prompt,
          context: compiled.context,
          contract: "Use CodexGPT Bridge",
          images: [],
          signal: abort.signal,
          allowWebNativeTools: true,
          onContextStaging: () => broker.beginContextStaging(token),
          onContextCommit: () => broker.commitContextStaging(token),
        })
        .then(
          (text) => {
            fixture.result = text;
          },
          (error) => {
            fixture.failure = error.message;
          },
        );
      return { url: address.url, token };
    },
    { baseline, controlFile },
  );
  await page
    .getByRole("heading", { name: /手动任务: manual-ui-thread/ })
    .waitFor();
  await page.getByRole("button", { name: "复制提示", exact: true }).click();
  const copied = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  assert.match(copied, /bridge.control.manual_complete/);
  assert.match(copied, /family 6.1/);
  const initialized = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  const session = initialized.headers.get("mcp-session-id");
  const complete = async (id) =>
    (
      await (
        await fetch(mcp.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-session-id": session,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "codex_tool_call",
              arguments: {
                turn_token: mcp.token,
                wire_name: "bridge.control.manual_complete",
                arguments: { text: "MANUAL_GUI_COMPLETE" },
              },
            },
          }),
        })
      ).json()
    ).result;
  assert.equal((await complete(2)).isError, true);
  await page.getByRole("button", { name: "我已发送提示", exact: true }).click();
  await page.getByLabel("粘贴 ChatGPT 最终答案").fill("MANUAL_GUI_COMPLETE");
  await page.screenshot({
    path: join(root, "bridge-manual-return-0.1.88.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "将答案传回 Codex", exact: true })
    .click();
  await application.evaluate(async () => await globalThis.parityFixture.work);
  assert.equal(
    await application.evaluate(() => globalThis.parityFixture.result),
    "MANUAL_GUI_COMPLETE",
  );
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((window) =>
          window.webContents.getURL().startsWith("https://chatgpt.com/"),
        ).length,
    ),
    0,
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [cli, "status", "--control-file", controlFile],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(JSON.parse(stdout).running, true);
  assert.equal(stdout.includes("a".repeat(64)), false);
  const approval = await application.evaluate(
    async ({ app, BrowserWindow }) => {
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(`${app.getAppPath()}/package.json`);
      const { join } = require("node:path");
      const { oneTimeToolApprovalTarget } = require(
        join(
          app.getAppPath(),
          "apps",
          "desktop",
          "dist",
          "main",
          "tool-approval.js",
        ),
      );
      const fixture = new BrowserWindow({ show: false });
      try {
        await fixture.loadURL(
          'data:text/html,<div role="dialog">Other Connector<button>Allow once</button></div><div role="dialog">CodexGPT Bridge<button>Always allow</button><button id="once">Allow once</button></div>',
        );
        const target = await fixture.webContents.executeJavaScript(
          `(${oneTimeToolApprovalTarget.toString()})("CodexGPT Bridge")`,
        );
        if (!target) throw new Error("One-time approval target is missing.");
        const expected = await fixture.webContents.executeJavaScript(
          '(() => { const r=document.querySelector("#once").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()',
        );
        return { target, expected };
      } finally {
        fixture.destroy();
      }
    },
  );
  assert.deepEqual(approval.target, approval.expected);
  await page.screenshot({
    path: join(root, "bridge-parity-0.1.86.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("heading", { name: "高级设置" }).waitFor();
  assert.equal(
    await page.getByLabel("ChatGPT 发送方式").inputValue(),
    "manual",
  );
  assert.equal(
    await page.getByLabel("在手动模式启用 Pro 模型").isChecked(),
    true,
  );
  const devData = join(directory, "dev-profile");
  const devHome = join(directory, "dev-codex");
  const productionHome = join(directory, "production-codex");
  await mkdir(devData);
  await mkdir(devHome);
  await mkdir(productionHome);
  const sentinel = 'model = "production-must-remain-unchanged"\n';
  await writeFile(join(productionHome, "config.toml"), sentinel);
  const devApplication = await electron.launch({
    executablePath: executable
      ? resolve(executable)
      : createRequire(import.meta.url)("electron"),
    args: executable ? ["--dev"] : [root, "--dev"],
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: productionHome,
      CODEXGPT_BRIDGE_DEV_CODEX_HOME: devHome,
      CODEXGPT_BRIDGE_E2E_USER_DATA_DIR: devData,
      CODEXGPT_BRIDGE_E2E_NATIVE_MODELS_JSON: '{"models":[]}',
      CODEXGPT_BRIDGE_E2E_EXISTING_MODELS_JSON: '{"models":[]}',
    },
  });
  try {
    const devPage = await devApplication.firstWindow();
    await devPage.locator(".languagePicker select").waitFor();
    const devStatus = await devPage.evaluate(() =>
      window.codexgptBridge.getWebProviderStatus(),
    );
    assert.equal(devStatus.developmentProfile, true);
    assert.equal(devStatus.configPath, join(devHome, "config.toml"));
    assert.equal(
      await devApplication.evaluate(({ app }) => app.getPath("userData")),
      devData,
    );
    assert.equal(
      await readFile(join(productionHome, "config.toml"), "utf8"),
      sentinel,
    );
  } finally {
    await devApplication.close();
  }
  process.stdout.write(
    "Parity desktop E2E passed: persisted advanced settings, manual UI and real MCP completion, no ChatGPT page automation, authenticated CLI, DEV isolation and connector-specific one-time approval.\n",
  );
} finally {
  if (application) {
    await application
      .evaluate(async () => {
        const f = globalThis.parityFixture;
        if (f) {
          f.abort.abort();
          f.host.close();
          await f.work;
          await f.server.close();
          await f.gateway.close();
          f.broker.close();
        }
      })
      .catch(() => {});
    await application.close();
  }
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("bridge-parity-"));
  await rm(directory, { recursive: true, force: true });
}
