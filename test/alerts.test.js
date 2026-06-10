import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildSignalNotification,
  normalizeSignalAction,
  shouldNotifySignalChange
} from "../public/alerts.js";

describe("signal alerts", () => {
  test("normalizes unknown actions to WAIT", () => {
    assert.equal(normalizeSignalAction(" long "), "LONG");
    assert.equal(normalizeSignalAction("short"), "SHORT");
    assert.equal(normalizeSignalAction("nonsense"), "WAIT");
    assert.equal(normalizeSignalAction(null), "WAIT");
  });

  test("only alerts when WAIT transitions to LONG or SHORT", () => {
    assert.equal(shouldNotifySignalChange("WAIT", "LONG"), true);
    assert.equal(shouldNotifySignalChange("WAIT", "SHORT"), true);
    assert.equal(shouldNotifySignalChange(null, "LONG"), false);
    assert.equal(shouldNotifySignalChange("LONG", "SHORT"), false);
    assert.equal(shouldNotifySignalChange("SHORT", "WAIT"), false);
    assert.equal(shouldNotifySignalChange("WAIT", "WAIT"), false);
  });

  test("builds a readable notification payload", () => {
    assert.deepEqual(buildSignalNotification({
      action: "LONG",
      instrument: { label: "MES/ES" },
      price: 7360,
      session: { label: "RTH" },
      confidence: "MEDIUM"
    }), {
      title: "MES/ES: LONG",
      body: "Price 7360.00 | RTH | MEDIUM confidence"
    });
  });
});
