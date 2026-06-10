import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createDashboardServer } from "../server.js";

let server;
let baseUrl;

describe("dashboard server", () => {
  before(async () => {
    server = createDashboardServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  test("serves health JSON", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  test("serves dashboard HTML", async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /Signal Deck Futures/);
  });

  test("returns 404 for missing static assets", async () => {
    const response = await fetch(`${baseUrl}/missing.js`);
    assert.equal(response.status, 404);
  });
});
