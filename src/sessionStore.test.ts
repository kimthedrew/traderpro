import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, destroySession, getSession } from "./sessionStore.js";
import type { DerivClient } from "./derivClient.js";

function fakeClient(): { client: DerivClient; closed: boolean } {
  const state = { closed: false };
  const client = { close: () => { state.closed = true; } } as unknown as DerivClient;
  return { client, get closed() { return state.closed; } };
}

test("createSession/getSession round-trip the stored data", () => {
  const { client } = fakeClient();
  const id = createSession({ loginid: "CR123", currency: "USD", client });

  assert.ok(id.length >= 32);
  assert.deepEqual(getSession(id), { loginid: "CR123", currency: "USD", client });

  destroySession(id);
});

test("destroySession closes the underlying client and removes the session", () => {
  const state = fakeClient();
  const id = createSession({ loginid: "CR456", currency: "USD", client: state.client });

  destroySession(id);

  assert.equal(getSession(id), undefined);
  assert.equal(state.closed, true);
});

test("getSession/destroySession are safe no-ops for unknown or undefined ids", () => {
  assert.equal(getSession(undefined), undefined);
  assert.equal(getSession("does-not-exist"), undefined);
  assert.doesNotThrow(() => destroySession(undefined));
  assert.doesNotThrow(() => destroySession("does-not-exist"));
});
