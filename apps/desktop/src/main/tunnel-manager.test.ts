import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { parseTunnelStatusOutput, TunnelManager } from "./tunnel-manager.js";

describe("OpenAI Tunnel status", () => {
  it("finds the Bridge user-directory client and honors explicit overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-discovery-"));
    const savedEnvironment = new Map(
      ["USERPROFILE", "HOME", "CODEXGPT_BRIDGE_TUNNEL_CLIENT"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    try {
      const binaryDirectory = join(root, ".codexgpt-bridge", "bin");
      await mkdir(binaryDirectory, { recursive: true });
      const defaultBinary = join(
        binaryDirectory,
        process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client",
      );
      const environmentBinary = join(root, "environment-client");
      const configuredBinary = join(root, "configured-client");
      const key = join(root, "runtime.key");
      await Promise.all(
        [defaultBinary, environmentBinary, configuredBinary, key].map((file) =>
          writeFile(file, "fixture"),
        ),
      );
      process.env.USERPROFILE = root;
      process.env.HOME = root;
      delete process.env.CODEXGPT_BRIDGE_TUNNEL_CLIENT;

      const calls: string[] = [];
      const manager = new TunnelManager(root, async (executable) => {
        calls.push(executable);
        return {
          status: 0,
          stdout: '{"running":true,"healthy":true,"ready":true}',
          stderr: "",
        };
      });
      const settings = {
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        runtimeKeyFile: key,
      };
      const connect = async (configured?: string) => {
        calls.length = 0;
        const status = await manager.connect(
          {
            ...settings,
            ...(configured ? { tunnelClientPath: configured } : {}),
          },
          "http://127.0.0.1:11485/mcp",
        );
        assert.equal(status.ready, true);
        await manager.stop();
      };

      await connect();
      assert.ok(calls.every((binary) => binary === defaultBinary));
      process.env.CODEXGPT_BRIDGE_TUNNEL_CLIENT = environmentBinary;
      await connect();
      assert.ok(calls.every((binary) => binary === environmentBinary));
      await connect(configuredBinary);
      assert.ok(calls.every((binary) => binary === configuredBinary));
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts connect and status JSON only when healthy and ready", () => {
    assert.deepEqual(
      parseTunnelStatusOutput(
        JSON.stringify({ running: true, healthy: true, ready: true }),
      ),
      {
        configured: true,
        running: true,
        healthy: true,
        ready: true,
        detail: '{"running":true,"healthy":true,"ready":true}',
      },
    );
    assert.equal(
      parseTunnelStatusOutput(
        JSON.stringify({
          process_running: true,
          healthy: true,
          ready: false,
        }),
      ).ready,
      false,
    );
    assert.equal(
      parseTunnelStatusOutput(
        JSON.stringify({
          process_running: true,
          healthy: true,
          ready: true,
        }),
      ).ready,
      true,
    );
  });

  it("fails closed and redacts tunnel identifiers in diagnostics", () => {
    const status = parseTunnelStatusOutput(
      "tunnel_0123456789abcdef0123456789abcdef is not JSON",
    );
    assert.equal(status.running, false);
    assert.equal(status.ready, false);
    assert.doesNotMatch(status.detail ?? "", /tunnel_0123456789abcdef/u);
  });

  it("stops a surviving alias before connecting the current MCP port", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-manager-"));
    try {
      const binary = join(root, "tunnel-client");
      const key = join(root, "runtime.key");
      await Promise.all([
        writeFile(binary, "fixture"),
        writeFile(key, "fixture"),
      ]);
      const calls: string[][] = [];
      const manager = new TunnelManager(root, async (_executable, args) => {
        calls.push([...args]);
        if (args[1] === "stop") {
          return { status: 0, stdout: '{"stopped":true}', stderr: "" };
        }
        return {
          status: 0,
          stdout: '{"running":true,"healthy":true,"ready":true}',
          stderr: "",
        };
      });

      await manager.connect(
        {
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
          runtimeKeyFile: key,
          tunnelClientPath: binary,
        },
        "http://127.0.0.1:11485/mcp",
      );

      assert.equal(calls[0]?.[1], "stop");
      assert.equal(calls[1]?.[1], "connect");
      assert.deepEqual(calls[1]?.slice(-3), [
        "--mcp-server-url",
        "http://127.0.0.1:11485/mcp",
        "--json",
      ]);
      assert.equal(calls[2]?.[1], "status");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not connect when the surviving alias cannot be stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-manager-"));
    try {
      const binary = join(root, "tunnel-client");
      const key = join(root, "runtime.key");
      await Promise.all([
        writeFile(binary, "fixture"),
        writeFile(key, "fixture"),
      ]);
      let calls = 0;
      const manager = new TunnelManager(root, async () => {
        calls += 1;
        return { status: 1, stdout: "", stderr: "access denied" };
      });

      await assert.rejects(
        manager.connect(
          {
            tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
            runtimeKeyFile: key,
            tunnelClientPath: binary,
          },
          "http://127.0.0.1:11485/mcp",
        ),
        /failed to replace its previous runtime/u,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
