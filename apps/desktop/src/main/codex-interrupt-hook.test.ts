import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  isCodexInterruptHookFullyAbsent,
  reinstallCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
} from "./codex-interrupt-hook.js";

describe("Codex Interrupt hook integration", () => {
  it("adds a trusted synchronous hook after existing user hooks", () => {
    const original = [
      'model = "native"',
      "",
      "[[hooks.Interrupt]]",
      "[[hooks.Interrupt.hooks]]",
      'type = "command"',
      'command = "user-hook"',
      "",
    ].join("\r\n");
    const command =
      '"C:\\Bridge App\\bridge.exe" "--codex-interrupt-hook" "C:\\State\\control.json"';
    const result = installCodexInterruptHook(
      original,
      "C:\\Users\\test\\.codex\\config.toml",
      command,
    );

    assert.equal(result.installed.groupIndex, 1);
    assert.match(result.installed.trustedHash, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(result.text.startsWith(original));
    assert.doesNotThrow(() =>
      verifyCodexInterruptHook(result.text, result.installed),
    );
    assert.equal(
      restoreCodexInterruptHook(result.text, result.installed),
      original,
    );
  });

  it("uses Codex's canonical trusted hash identity", () => {
    assert.equal(
      codexInterruptHookHash("bridge hook"),
      "sha256:df9644b7b6c0bb7946ffc1cb62c7d1df6f649bd73b834fab34067759c2ec9b11",
    );
  });

  it("quotes every command argument on Windows", () => {
    assert.equal(
      codexInterruptHookCommand({
        executablePath: "C:\\Program Files\\Bridge\\Bridge.exe",
        hookScriptPath: "C:\\Program Files\\Bridge\\provider-hook-cli.js",
        metadataPath: "C:\\Users\\A B\\control.json",
        platform: "win32",
      }),
      'set "ELECTRON_RUN_AS_NODE=1" && "C:\\Program Files\\Bridge\\Bridge.exe" "C:\\Program Files\\Bridge\\provider-hook-cli.js" "C:\\Users\\A B\\control.json"',
    );
  });

  it("refuses partial edits but permits explicit repair after full removal", () => {
    const installed = installCodexInterruptHook(
      'model = "native"\n',
      "/tmp/config.toml",
      "bridge hook",
    );
    const modified = installed.text.replace("timeout = 3", "timeout = 9");
    assert.throws(
      () => restoreCodexInterruptHook(modified, installed.installed),
      /changed after setup/u,
    );
    const absent = 'model = "native"\n';
    assert.equal(
      isCodexInterruptHookFullyAbsent(absent, installed.installed),
      true,
    );
    assert.equal(
      restoreCodexInterruptHook(absent, installed.installed, {
        allowAbsent: true,
      }),
      absent,
    );
  });

  it("recognizes a moved hook only when its trust key was correctly rebased", () => {
    const original = 'model = "native"\n';
    const userHook = installCodexInterruptHook(
      original,
      "/tmp/config.toml",
      "user hook",
    );
    const bridge = installCodexInterruptHook(
      userHook.text.replaceAll(
        "CodexGPT Bridge managed Interrupt hook",
        "User Interrupt hook",
      ),
      "/tmp/config.toml",
      "bridge hook",
    );
    const moved = installCodexInterruptHook(
      original,
      "/tmp/config.toml",
      "bridge hook",
    );
    const after =
      moved.text +
      userHook.installed.fragment
        .replaceAll(
          "CodexGPT Bridge managed Interrupt hook",
          "User Interrupt hook",
        )
        .replace(":interrupt:0:0", ":interrupt:1:0");
    assert.doesNotThrow(() =>
      verifyCodexInterruptHook(after, bridge.installed),
    );
    assert.throws(
      () =>
        verifyCodexInterruptHook(
          after.replace(":interrupt:0:0", ":interrupt:1:0"),
          bridge.installed,
        ),
      /changed after setup/u,
    );
    for (const changed of [
      after.replace('command = "bridge hook"', 'command = "edited hook"'),
      after.replace("timeout = 3", "timeout = 9"),
      after.replace(
        moved.installed.trustedHash,
        userHook.installed.trustedHash,
      ),
      after.replace(
        JSON.stringify(moved.installed.stateKey),
        JSON.stringify(`other-config:interrupt:0:0`),
      ),
    ]) {
      assert.throws(
        () => verifyCodexInterruptHook(changed, bridge.installed),
        /changed after setup/u,
      );
    }
    const updated = reinstallCodexInterruptHook(
      after,
      "/tmp/config.toml",
      "new bridge hook",
      bridge.installed,
    );
    assert.equal(updated.installed.groupIndex, 0);
    assert.ok(updated.text.endsWith(after.slice(moved.text.length)));
    assert.doesNotThrow(() =>
      verifyCodexInterruptHook(updated.text, updated.installed),
    );
  });

  it("accepts changed line endings and keeps later hooks in place on reinstall", () => {
    const original = 'model = "native"\r\n';
    const bridge = installCodexInterruptHook(
      original,
      "/tmp/config.toml",
      "bridge hook",
    );
    const suffix =
      '\r\n[[hooks.Interrupt]]\r\n[[hooks.Interrupt.hooks]]\r\ncommand = "later user hook"\r\n';
    const reformatted = (bridge.text + suffix).replaceAll("\r\n", "\n");
    assert.doesNotThrow(() =>
      verifyCodexInterruptHook(reformatted, bridge.installed),
    );
    const updated = reinstallCodexInterruptHook(
      reformatted,
      "/tmp/config.toml",
      "updated hook",
      bridge.installed,
    );
    assert.equal(updated.installed.groupIndex, 0);
    assert.ok(updated.text.endsWith(suffix.replaceAll("\r\n", "\n")));
    assert.equal(
      restoreCodexInterruptHook(updated.text, updated.installed),
      original.replaceAll("\r\n", "\n") + suffix.replaceAll("\r\n", "\n"),
    );
  });
});
