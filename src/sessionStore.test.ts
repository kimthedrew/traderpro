import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, destroySession, getSession } from "./sessionStore.js";

test("createSession/getSession round-trip the stored data", () => {
  const id = createSession({ loginid: "CR123", currency: "USD", accessToken: "fake-token" });

  assert.ok(id.length >= 32);
  assert.deepEqual(getSession(id), { loginid: "CR123", currency: "USD", accessToken: "fake-token" });

  destroySession(id);
});

test("destroySession removes the session", () => {
  const id = createSession({ loginid: "CR456", currency: "USD", accessToken: "fake-token" });

  destroySession(id);

  assert.equal(getSession(id), undefined);
});

test("getSession/destroySession are safe no-ops for unknown or undefined ids", () => {
  assert.equal(getSession(undefined), undefined);
  assert.equal(getSession("does-not-exist"), undefined);
  assert.doesNotThrow(() => destroySession(undefined));
  assert.doesNotThrow(() => destroySession("does-not-exist"));
});
