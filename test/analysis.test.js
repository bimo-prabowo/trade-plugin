import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeMacd,
  computeRsi,
  getTradingSession,
  isPlausibleCandle,
  describeInstrument,
  roundToTick,
  sanitizeSymbol
} from "../server.js";

describe("analysis helpers", () => {
  test("rejects impossible candles from quote glitches", () => {
    assert.equal(isPlausibleCandle({ open: 7310, high: 7320, low: 7305, close: 7315 }), true);
    assert.equal(isPlausibleCandle({ open: 0, high: 0, low: 0, close: 0 }), false);
    assert.equal(isPlausibleCandle({ open: 7310, high: 7320, low: 0, close: 7315 }), false);
    assert.equal(isPlausibleCandle({ open: 7310, high: 7000, low: 7320, close: 7315 }), false);
    assert.equal(isPlausibleCandle({ open: 7310, high: 7315, low: 1, close: 7315 }), false);
  });

  test("classifies futures sessions in Eastern time", () => {
    assert.equal(getTradingSession(new Date("2026-06-10T14:00:00Z")).label, "RTH");
    assert.equal(getTradingSession(new Date("2026-06-10T11:00:00Z")).label, "Pre-Market");
    assert.equal(getTradingSession(new Date("2026-06-10T06:00:00Z")).label, "ETH-Europe");
    assert.equal(getTradingSession(new Date("2026-06-10T22:30:00Z")).label, "ETH-Asia");
    assert.equal(getTradingSession(new Date("2026-06-10T21:30:00Z")).label, "Closed");
    assert.equal(getTradingSession(new Date("2026-06-13T14:00:00Z")).label, "Closed");
  });

  test("sanitizes supported quote symbols", () => {
    assert.equal(sanitizeSymbol(" es=f "), "ES=F");
    assert.equal(sanitizeSymbol("nq=f"), "NQ=F");
    assert.equal(sanitizeSymbol("../../etc/passwd"), "ES=F");
  });

  test("describes instrument labels for the dashboard header", () => {
    assert.deepEqual(describeInstrument("ES=F"), { label: "MES/ES", priceLabel: "MES Price", root: "ES" });
    assert.deepEqual(describeInstrument("MES=F"), { label: "MES/ES", priceLabel: "MES Price", root: "MES" });
    assert.deepEqual(describeInstrument("NQ=F"), { label: "MNQ/NQ", priceLabel: "MNQ Price", root: "NQ" });
  });

  test("rounds futures prices to tick size", () => {
    assert.equal(roundToTick(7314.37), 7314.25);
    assert.equal(roundToTick(7314.38), 7314.5);
    assert.equal(roundToTick(Number.NaN), null);
  });

  test("computes RSI and MACD without changing series length", () => {
    const rising = Array.from({ length: 40 }, (_, index) => 7000 + index);
    const rsi = computeRsi(rising, 14);
    assert.equal(rsi.length, rising.length);
    assert.equal(rsi.at(-1), 100);

    const wavy = Array.from({ length: 90 }, (_, index) => 7000 + index * 0.4 + Math.sin(index / 3) * 3);
    const macd = computeMacd(wavy);
    assert.equal(macd.line.length, wavy.length);
    assert.equal(macd.signal.length, wavy.length);
    assert.equal(macd.histogram.length, wavy.length);
    assert.equal(Number.isFinite(macd.histogram.at(-1)), true);
  });
});
