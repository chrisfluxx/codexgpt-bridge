import assert from "node:assert/strict";
import test from "node:test";
import type { WebRequest } from "electron";
import {
  ChatGptBackendAccess,
  subscribeChatGptBackendResponses,
  type ChatGptBackendResponse,
} from "./chatgpt-backend-recovery.js";

const response = (
  overrides: Partial<ChatGptBackendResponse> = {},
): ChatGptBackendResponse => ({
  url: "https://chatgpt.com/backend-api/models",
  webContentsId: 12,
  statusCode: 403,
  responseHeaders: { "CF-Mitigated": [" CHALLENGE "] },
  ...overrides,
});

test("backend challenges are isolated to the owned page, origin and endpoints", () => {
  const access = new ChatGptBackendAccess("https://chatgpt.com/", 12);
  for (const details of [
    response({ webContentsId: 13 }),
    response({ url: "https://other.invalid/backend-api/models" }),
    response({ url: "https://chatgpt.com/analytics" }),
    response({ url: "invalid" }),
    response({ responseHeaders: {} }),
    response({ statusCode: 401 }),
  ]) {
    assert.equal(access.observe(details), false);
    assert.equal(access.blocked, false);
  }
  assert.equal(access.observe(response()), true);
  assert.equal(access.blocked, true);
});

test("one reload is allowed until the challenged endpoint actually recovers", () => {
  const access = new ChatGptBackendAccess("https://chatgpt.com/", 12);
  access.observe(response());
  assert.equal(access.takeReload(), true);
  access.observe(response());
  access.observe(
    response({ statusCode: 200, url: "https://chatgpt.com/api/auth/session" }),
  );
  assert.equal(access.blocked, true);
  assert.equal(access.takeReload(), false);
  access.observe(response({ statusCode: 200, responseHeaders: {} }));
  assert.equal(access.blocked, false);
  access.observe(response());
  assert.equal(access.takeReload(), true);
});

test("session challenges can recover without declaring the account signed out", () => {
  const access = new ChatGptBackendAccess("https://chatgpt.com/", 12);
  access.markChallenge("https://chatgpt.com/api/auth/session");
  assert.equal(access.takeReload(), true);
  access.observe(
    response({
      url: "https://chatgpt.com/api/auth/session",
      statusCode: 200,
      responseHeaders: {},
    }),
  );
  assert.equal(access.blocked, false);
});

test("one session listener dispatches to all owned windows and removes only its subscription", () => {
  let installed = 0;
  let dispatch: ((details: ChatGptBackendResponse) => void) | undefined;
  const webRequest = {
    onCompleted: (_filter: unknown, listener: typeof dispatch) => {
      installed += 1;
      dispatch = listener;
    },
  } as unknown as WebRequest;
  const calls: number[] = [];
  const stopFirst = subscribeChatGptBackendResponses(webRequest, 12, () =>
    calls.push(12),
  );
  const stopSecond = subscribeChatGptBackendResponses(webRequest, 13, () =>
    calls.push(13),
  );
  assert.equal(installed, 1);
  dispatch?.(response());
  dispatch?.(response({ webContentsId: 13 }));
  stopFirst();
  dispatch?.(response());
  dispatch?.(response({ webContentsId: 13 }));
  stopSecond();
  dispatch?.(response({ webContentsId: 13 }));
  assert.deepEqual(calls, [12, 13, 13]);
});
