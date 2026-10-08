import assert from "node:assert/strict";
import { it } from "node:test";
import {
  assertProjectDestination,
  normalizeChatGptProjectUrl,
  normalizeProjectPath,
  parseChatGptProjectSettings,
} from "./chatgpt-projects.js";

const projectUrl = "https://chatgpt.com/g/g-p-abc123-example/project";
it("normalizes native Windows extended-length drive and UNC paths", () => {
  assert.equal(
    normalizeProjectPath("\\\\?\\C:\\Code\\Bridge\\"),
    normalizeProjectPath("c:/code/bridge"),
  );
  assert.equal(
    normalizeProjectPath("\\\\?\\UNC\\Server\\Share\\Bridge"),
    normalizeProjectPath("\\\\server\\share\\bridge"),
  );
});
it("defaults off and ignores removed legacy manual mappings", () => {
  assert.deepEqual(parseChatGptProjectSettings(undefined), { enabled: false });
  assert.deepEqual(
    parseChatGptProjectSettings({
      enabled: true,
      mappings: [
        { localPath: "C:\\Code\\", projectUrl },
        {
          localPath: "c:/code/bridge",
          projectUrl: projectUrl.replace("abc123", "nested"),
        },
      ],
    }),
    { enabled: true },
  );
  assert.throws(() => parseChatGptProjectSettings({ enabled: "yes" }));
});

it("validates project landing URLs and strips URL tracking", () => {
  assert.equal(
    normalizeChatGptProjectUrl(projectUrl + "/?tracking=ignored#fragment"),
    projectUrl,
  );
  for (const url of [
    "https://evil.example/g/g-p-abc123/project",
    "http://chatgpt.com/g/g-p-abc123/project",
    "https://user:secret@chatgpt.com/g/g-p-abc123/project",
    "https://chatgpt.com/c/abc123",
    "https://chatgpt.com/g/custom-gpt/project",
    "https://chatgpt.com/g/g-p-abc123/c/abc123",
    "https://chatgpt.com/g/g-p-abc123%2fother/project",
  ]) {
    assert.throws(() => normalizeChatGptProjectUrl(url));
  }
});

it("blocks a missing project redirect before submission but accepts a retained exact chat", () => {
  assertProjectDestination(projectUrl, projectUrl);
  assertProjectDestination(
    projectUrl.replace("/project", "/c/chat-123"),
    projectUrl,
  );
  assertProjectDestination(
    "https://chatgpt.com/c/retained-chat",
    projectUrl,
    "https://chatgpt.com/c/retained-chat",
  );
  for (const url of [
    "https://chatgpt.com/",
    "https://chatgpt.com/auth/login",
    projectUrl.replace("abc123", "different"),
    "https://chatgpt.com/c/another-chat",
  ]) {
    assert.throws(() => assertProjectDestination(url, projectUrl), /尚未送出/);
  }
});
