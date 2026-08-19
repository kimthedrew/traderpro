import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, destroySession, getSession } from "./sessionStore.js";

test("createSession/getSession round-trip the stored data", async () => {
  const id = await createSession({ loginid: "CR123", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });

  assert.ok(id.length >= 32);
  assert.deepEqual(await getSession(id), { loginid: "CR123", currency: "USD", accessToken: "fake-token" });

  await destroySession(id);
});

test("destroySession removes the session", async () => {
  const id = await createSession({ loginid: "CR456", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });

  await destroySession(id);

  assert.equal(await getSession(id), undefined);
});

test("an expired session is not returned", async () => {
  const id = await createSession({ loginid: "CR789", currency: "USD", accessToken: "fake-token", expiresInSeconds: -1 });

  assert.equal(await getSession(id), undefined);

  await destroySession(id);
});

test("getSession/destroySession are safe no-ops for unknown or undefined ids", async () => {
  assert.equal(await getSession(undefined), undefined);
  assert.equal(await getSession("does-not-exist"), undefined);
  await assert.doesNotReject(() => destroySession(undefined));
  await assert.doesNotReject(() => destroySession("does-not-exist"));
});
