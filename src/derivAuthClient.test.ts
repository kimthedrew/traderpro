import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { AuthenticatedDerivClient } from "./derivAuthClient.js";

async function startMockServer() {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.proposal) {
        ws.send(JSON.stringify({ req_id: msg.req_id, proposal: { id: "p1", ask_price: 10, payout: 19, spot: 600 } }));
      } else if (msg.buy) {
        ws.send(JSON.stringify({ req_id: msg.req_id, buy: { contract_id: 1, transaction_id: 2, buy_price: 10, payout: 19 } }));
      }
    });
  });
  const { port } = wss.address() as AddressInfo;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

test("AuthenticatedDerivClient: req_id correlation works for proposal and buy", async () => {
  const { wss, url } = await startMockServer();
  const client = new AuthenticatedDerivClient(url);
  try {
    await client.connect();
    const proposal = await client.send({ proposal: 1 });
    assert.equal(proposal.proposal.id, "p1");
    const buy = await client.send({ buy: "p1", price: 10 });
    assert.equal(buy.buy.contract_id, 1);
  } finally {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("AuthenticatedDerivClient: send() rejects if called before connect()", async () => {
  const client = new AuthenticatedDerivClient("ws://127.0.0.1:0");
  await assert.rejects(() => client.send({ proposal: 1 }), /socket not open/);
});

// The critical regression test: derivClient.ts's `ws.once("error", reject)`
// only matters until connect() resolves. This client is meant to survive a
// full proposal -> buy round trip after that, so a raw socket error in that
// window must not crash the process -- it must instead surface as a
// "socket_error" event on the client.
test("AuthenticatedDerivClient: a post-connect socket error does not crash the process, and surfaces as socket_error", async () => {
  const { wss, url } = await startMockServer();
  const client = new AuthenticatedDerivClient(url);
  try {
    await client.connect();
    const errorEvent = new Promise((resolve) => client.once("socket_error", resolve));
    // Simulate a raw socket-level error on the already-open connection.
    (client as any).ws.emit("error", new Error("simulated post-connect socket error"));
    const err: any = await errorEvent;
    assert.match(err.message, /simulated post-connect socket error/);
  } finally {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});
