import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { retireWorkspaceService } from "./retired-workspace-service.js";

const directories: string[] = [];
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-retire-workspace-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  return {
    userDataDirectory: directory,
    configPath,
    decryptToken: (encrypted: Buffer): string => encrypted.toString(),
  };
}
async function registration(options: Awaited<ReturnType<typeof fixture>>) {
  const original = 'model = "native-fixture"\n';
  const block =
    '# >>> CodexGPT Bridge managed MCP\n[mcp_servers.codexgpt-bridge]\nurl = "http://127.0.0.1:7766/mcp"\n# <<< CodexGPT Bridge managed MCP\n';
  await writeFile(options.configPath, original + "\n" + block);
  await writeFile(
    join(options.userDataDirectory, "codex-integration.json"),
    JSON.stringify({
      version: 1,
      configPath: options.configPath,
      blockHash: hash(block),
      originalHash: hash(original),
      separator: "\n",
      createdConfig: false,
    }),
  );
  return { original, block };
}
describe("retired workspace service", () => {
  it("removes obsolete preferences without altering Web or Full MCP settings", async () => {
    const options = await fixture();
    const retained = {
      locale: "zh-TW",
      webToolMode: "full",
      fullMcpTunnelId: "fixture-tunnel",
      fullMcpRuntimeKeyFile: "fixture-key",
      chatGptProjects: { enabled: true },
      temporaryChat: true,
    };
    const path = join(options.userDataDirectory, "desktop-settings.json");
    await writeFile(
      path,
      JSON.stringify({
        ...retained,
        allowedRoots: ["C:/work"],
        permission: "execute",
        backgroundRuntime: true,
      }),
    );
    assert.deepEqual(await retireWorkspaceService(options), []);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), retained);
    assert.deepEqual(await retireWorkspaceService(options), []);
  });
  it("restores an owned MCP registration while preserving a Web provider and other edits", async () => {
    const options = await fixture();
    const { original, block } = await registration(options);
    const provider =
      '# >>> CodexGPT Bridge managed Web provider\nopenai_base_url = "http://127.0.0.1:7767/v1"\n# <<< CodexGPT Bridge managed Web provider\n';
    await writeFile(options.configPath, original + "\n" + block + provider);
    assert.deepEqual(await retireWorkspaceService(options), []);
    assert.equal(
      await readFile(options.configPath, "utf8"),
      original + "\n" + provider,
    );
    await assert.rejects(
      readFile(join(options.userDataDirectory, "codex-integration.json")),
      /ENOENT/u,
    );
  });
  it("restores the exact original config when its owned block is the only addition", async () => {
    const options = await fixture();
    const { original } = await registration(options);
    assert.deepEqual(await retireWorkspaceService(options), []);
    assert.equal(await readFile(options.configPath, "utf8"), original);
  });
  it("preserves edited, duplicate and unowned registrations", async () => {
    for (const scenario of ["edited", "duplicate", "unowned"]) {
      const options = await fixture();
      const { original, block } = await registration(options);
      const text =
        original + block + (scenario === "duplicate" ? block : "# user edit\n");
      await writeFile(
        options.configPath,
        scenario === "edited" ? text.replace("7766", "7768") : text,
      );
      if (scenario === "unowned")
        await rm(join(options.userDataDirectory, "codex-integration.json"));
      const before = await readFile(options.configPath, "utf8");
      const warnings = await retireWorkspaceService(options);
      assert.equal(warnings.length, scenario === "unowned" ? 0 : 1);
      assert.equal(await readFile(options.configPath, "utf8"), before);
    }
  });
  it("shuts down only the authenticated legacy service and retains credentials on failure", async () => {
    for (const accepted of [true, false]) {
      const options = await fixture();
      const token = "legacy-daemon-fixture-credential";
      const requests: string[] = [];
      const server = createServer((request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(accepted ? 200 : 401, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            transportSessions: 0,
            workspaces: [],
            processes: [],
            pendingApprovals: [],
          }),
        );
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const metadata = join(
          options.userDataDirectory,
          "runtime-connection.json",
        );
        await writeFile(
          metadata,
          JSON.stringify({
            version: 1,
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
            pid: 1,
          }),
        );
        await writeFile(
          join(options.userDataDirectory, "runtime-token.bin"),
          token,
        );
        const warnings = await retireWorkspaceService(options);
        assert.deepEqual(
          requests,
          accepted
            ? ["GET /admin/status", "POST /admin/shutdown"]
            : ["GET /admin/status"],
        );
        assert.equal(warnings.length, accepted ? 0 : 1);
        if (accepted) await assert.rejects(readFile(metadata), /ENOENT/u);
        else assert.ok(await readFile(metadata));
      } finally {
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
      }
    }
  });
  it("does not contact endpoints outside loopback", async () => {
    const options = await fixture();
    const metadata = join(options.userDataDirectory, "runtime-connection.json");
    await writeFile(
      metadata,
      JSON.stringify({
        version: 1,
        endpoint: "https://example.invalid/mcp",
        pid: 1,
      }),
    );
    const warnings = await retireWorkspaceService(options);
    assert.equal(warnings.length, 1);
    assert.ok(await readFile(metadata));
  });
});
