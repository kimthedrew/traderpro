import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, destroySession, getSession, switchSessionAccount } from "./sessionStore.js";

test("createSession/getSession round-trip the stored data, defaulting to a single real account", async () => {
  const id = await createSession({ loginid: "CR123", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });

  assert.ok(id.length >= 32);
  assert.deepEqual(await getSession(id), {
    loginid: "CR123",
    currency: "USD",
    accountType: "real",
    accounts: [{ accountId: "CR123", accountType: "real", currency: "USD" }],
    accessToken: "fake-token",
  });

  await destroySession(id);
});

test("switchSessionAccount moves the session onto another account it's own, e.g. demo -- no new login needed", async () => {
  const id = await createSession({
    loginid: "CR001",
    currency: "USD",
    accessToken: "fake-token",
    expiresInSeconds: 3600,
    accountType: "real",
    accounts: [
      { accountId: "CR001", accountType: "real", currency: "USD" },
      { accountId: "VRTC001", accountType: "demo", currency: "USD" },
    ],
  });

  const switched = await switchSessionAccount(id, "VRTC001");
  assert.equal(switched?.loginid, "VRTC001");
  assert.equal(switched?.accountType, "demo");

  // The switch persists -- a fresh getSession() reflects it too.
  const session = await getSession(id);
  assert.equal(session?.loginid, "VRTC001");
  assert.equal(session?.accountType, "demo");

  await destroySession(id);
});

test("switchSessionAccount rejects an account id that isn't one of the session's own", async () => {
  const id = await createSession({ loginid: "CR002", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });

  assert.equal(await switchSessionAccount(id, "someone-elses-account"), undefined);

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
