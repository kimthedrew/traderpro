import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { DerivClient } from "./derivClient.js";

// A minimal stand-in for Deriv's API: echoes req_id and replies according to
// request shape, so DerivClient's request/response matching and event
// re-emission can be tested without hitting the real network.
async function startMockDerivServer() {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.authorize) {
        ws.send(JSON.stringify({
          req_id: msg.req_id,
          msg_type: "authorize",
          authorize: { loginid: "CR900000", currency: "USD", email: "trader@example.com" },
        }));
      } else if (msg.ticks) {
        ws.send(JSON.stringify({
          req_id: msg.req_id,
          msg_type: "tick",
          tick: { symbol: msg.ticks, quote: 1234.56, epoch: 1700000000 },
        }));
      } else if (msg.ping) {
        ws.send(JSON.stringify({ req_id: msg.req_id, msg_type: "ping", ping: "pong" }));
      } else if (msg.fail) {
        ws.send(JSON.stringify({ req_id: msg.req_id, error: { code: "TestError", message: "forced failure" } }));
      }
    });
  });
  const { port } = wss.address() as AddressInfo;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

test("DerivClient: authorize resolves with the account payload", async () => {
  const { wss, url } = await startMockDerivServer();
  const client = new DerivClient("1089", url);
  try {
    await client.connect();
    const result = await client.authorize("faketoken");
    assert.equal(result.authorize.loginid, "CR900000");
    assert.equal(result.authorize.currency, "USD");
  } finally {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("DerivClient: subscribeTicks resolves and matches req_id to the right request", async () => {
  const { wss, url } = await startMockDerivServer();
  const client = new DerivClient("1089", url);
  try {
    await client.connect();
    const [r100, r75] = await Promise.all([client.subscribeTicks("R_100"), client.subscribeTicks("R_75")]);
    assert.equal(r100.tick.symbol, "R_100");
    assert.equal(r75.tick.symbol, "R_75");
  } finally {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("DerivClient: emits msg_type events for streamed (subscribed) messages", async () => {
  const { wss, url } = await startMockDerivServer();
  const client = new DerivClient("1089", url);
  try {
    await client.connect();
    const tickEvent = new Promise((resolve) => client.once("tick", resolve));
    await client.subscribeTicks("R_100");
    const emitted: any = await tickEvent;
    assert.equal(emitted.tick.symbol, "R_100");
  } finally {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("DerivClient: a request-level error rejects that request and emits api_error", async () => {
  const { wss, url } = await startMockDerivServer();
  const client = new DerivClient("1089", url);
  try {
    await client.connect();
    const apiError = new Promise((resolve) => client.once("api_error", resolve));
    await assert.rejects(() => client.send({ fail: 1 }));
    const err: any = await apiError;
    assert.equal(err.code, "TestError");
  } finally {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("DerivClient: send() rejects if called before connect()", async () => {
  const client = new DerivClient("1089", "ws://127.0.0.1:0");
  await assert.rejects(() => client.send({ ping: 1 }), /socket not open/);
});

test("DerivClient: connect() rejects when nothing is listening", async () => {
  const client = new DerivClient("1089", "ws://127.0.0.1:1");
  await assert.rejects(() => client.connect());
});
