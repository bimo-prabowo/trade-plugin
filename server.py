#!/usr/bin/env python3
"""Dependency-free local server for the Signal Deck Futures dashboard."""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
PORT = int(os.environ.get("PORT", "5174"))
ET_ZONE = ZoneInfo("America/New_York")
DEFAULT_SYMBOL = "ES=F"
YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
YAHOO_RSS_BASE = "https://feeds.finance.yahoo.com/rss/2.0/headline"
DISCLAIMER = (
    "Paper trading education only. This is not financial advice. Futures are "
    "leveraged instruments and can lose more than the initial deposit."
)


@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    et: dict | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "SignalDeckFutures/0.1"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if parsed.path == "/api/analyze":
            query = urllib.parse.parse_qs(parsed.query)
            symbol = sanitize_symbol(first(query.get("symbol"), DEFAULT_SYMBOL))
            account = clamp(to_float(first(query.get("account"), "1000")), 100, 1_000_000)
            try:
                self.send_json(200, build_analysis(symbol, account))
            except Exception as exc:
                self.send_json(
                    502,
                    {
                        "error": "DATA_UNAVAILABLE",
                        "action": "WAIT",
                        "confidence": "LOW",
                        "message": str(exc),
                        "disclaimer": DISCLAIMER,
                        "generatedAt": iso_now(),
                    },
                )
            return
        self.serve_static(parsed.path)

    def serve_static(self, url_path: str) -> None:
        request_path = "/index.html" if url_path == "/" else urllib.parse.unquote(url_path)
        file_path = (PUBLIC_DIR / request_path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(PUBLIC_DIR.resolve())):
            self.send_text(403, "Forbidden")
            return
        if not file_path.is_file():
            self.send_text(404, "Not found")
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", mimetypes.guess_type(file_path)[0] or "application/octet-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, indent=2).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, status: int, message: str) -> None:
        body = message.encode()
        self.send_response(status)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")


def build_analysis(symbol: str, account_size: float) -> dict:
    market = fetch_chart(symbol, "5d", "5m")
    if len(market["candles"]) < 60:
        raise RuntimeError("Not enough intraday candles returned by the market data source.")
    vix = safe(lambda: fetch_chart("^VIX", "2d", "15m"))
    tnx = safe(lambda: fetch_chart("^TNX", "2d", "15m"))
    news = safe(lambda: fetch_news(symbol)) or {"items": [], "url": news_url(symbol)}
    context = market_context(market, symbol)
    indicators = indicator_pack(context)
    macro = macro_read(vix, tnx, news["items"])
    decision = decide(context, indicators, macro, account_size)
    sources = [{"label": f"Yahoo Finance chart: {symbol}", "url": market["url"]}]
    if vix:
        sources.append({"label": "Yahoo Finance chart: VIX", "url": vix["url"]})
    if tnx:
        sources.append({"label": "Yahoo Finance chart: 10-year yield proxy (^TNX)", "url": tnx["url"]})
    sources.append({"label": "Yahoo Finance market headlines", "url": news["url"]})
    return {
        "generatedAt": iso_now(),
        "symbol": symbol,
        "contract": {
            "mes": {"label": "MES", "dollarsPerPoint": 5, "dollarsPerTick": 1.25},
            "es": {"label": "ES", "dollarsPerPoint": 50, "dollarsPerTick": 12.5},
            "tickSize": 0.25,
        },
        "source": {
            "name": "Yahoo Finance public chart/RSS APIs",
            "caveat": "Quotes may be delayed and ES=F is a continuous/front-month proxy. True bid/ask CVD is not available.",
        },
        "disclaimer": DISCLAIMER,
        "action": decision["action"],
        "confidence": decision["confidence"],
        "price": context["price"],
        "session": context["session"],
        "account": {
            "size": account_size,
            "maxRiskDollars": decision["maxRiskDollars"],
            "maxStopPoints": decision["maxStopPoints"],
        },
        "freshness": context["freshness"],
        "volume": context["volume"],
        "gap": context["gap"],
        "entryPlan": decision["entryPlan"],
        "keyLevels": context["keyLevels"],
        "scorecard": decision["scorecard"],
        "reasoning": decision["reasoning"],
        "exitTriggers": decision["exitTriggers"],
        "riskRules": decision["riskRules"],
        "newsImpact": macro["newsImpact"],
        "warnings": decision["warnings"],
        "chart": {
            "candles": [
                {"time": c.time, "close": rp(c.close), "high": rp(c.high), "low": rp(c.low), "volume": c.volume}
                for c in context["candles"][-160:]
            ],
            "levels": {
                "vwap": rn(context["keyLevels"].get("vwap")),
                "priorDayHigh": rn(context["keyLevels"].get("priorDayHigh")),
                "priorDayLow": rn(context["keyLevels"].get("priorDayLow")),
            },
        },
        "sources": sources,
    }


def fetch_chart(symbol: str, range_: str, interval: str) -> dict:
    url = f"{YAHOO_CHART_BASE}/{urllib.parse.quote(symbol, safe='')}?range={range_}&interval={interval}&includePrePost=true"
    data = fetch_json(url)
    chart = data.get("chart", {})
    if chart.get("error"):
        raise RuntimeError(chart["error"].get("description") or f"Yahoo Finance rejected {symbol}.")
    result = first(chart.get("result"), None)
    timestamps = result.get("timestamp") if result else None
    quote = first(result.get("indicators", {}).get("quote"), {}) if result else {}
    if not timestamps:
        raise RuntimeError(f"No chart data returned for {symbol}.")
    candles = []
    for i, ts in enumerate(timestamps):
        close = num_at(quote.get("close"), i)
        fallback = close if close is not None else num_at(quote.get("open"), i)
        if close is None:
            continue
        candle = Candle(
            int(ts * 1000),
            num_at(quote.get("open"), i) or fallback,
            num_at(quote.get("high"), i) or fallback,
            num_at(quote.get("low"), i) or fallback,
            close,
            max(0, num_at(quote.get("volume"), i) or 0),
        )
        if plausible_candle(candle):
            candles.append(candle)
    return {"symbol": symbol, "url": url, "meta": result.get("meta", {}), "candles": candles}



def plausible_candle(candle: Candle) -> bool:
    values = [candle.open, candle.high, candle.low, candle.close]
    if not all(finite(value) and value > 0 for value in values):
        return False
    if candle.high < candle.low:
        return False
    max_distance = max(candle.close * 0.08, 200)
    return abs(candle.high - candle.close) <= max_distance and abs(candle.low - candle.close) <= max_distance

def fetch_news(symbol: str) -> dict:
    url = news_url(symbol)
    root = ET.fromstring(fetch_text(url))
    items = []
    for item in root.findall(".//item")[:5]:
        items.append({"title": text_of(item, "title"), "link": text_of(item, "link"), "pubDate": text_of(item, "pubDate")})
    return {"url": url, "items": [item for item in items if item["title"]]}


def market_context(market: dict, symbol: str) -> dict:
    now = datetime.now(timezone.utc)
    session = trading_session(now)
    candles = market["candles"]
    for candle in candles:
        candle.et = et_parts(datetime.fromtimestamp(candle.time / 1000, tz=timezone.utc))
    latest = candles[-1]
    price = round_tick(latest.close)
    target = target_rth_date(now)
    prior = previous_business_date(target)
    overnight_start = previous_date(target)
    prior_rth = [c for c in candles if is_rth(c, prior)]
    target_rth = [c for c in candles if is_rth(c, target)]
    overnight = [
        c for c in candles
        if (c.et["dateKey"] == overnight_start and c.et["minutes"] >= 1080)
        or (c.et["dateKey"] == target and c.et["minutes"] < 570)
    ]
    current = current_session_candles(candles, session, target, overnight_start)
    vwap = compute_vwap(current) or compute_vwap(target_rth) or compute_vwap(overnight)
    atr = compute_atr(candles)
    pdc = prior_rth[-1].close if prior_rth else to_float(market["meta"].get("previousClose"))
    freshness_minutes = max(0, round((time.time() * 1000 - latest.time) / 60000))
    current_range = candle_range(current)
    prior_range = candle_range(prior_rth)
    overnight_range = candle_range(overnight)
    return {
        "symbol": symbol,
        "candles": candles,
        "price": price,
        "session": session,
        "atr": atr,
        "vwap": vwap,
        "freshness": {
            "latestCandleAt": datetime.fromtimestamp(latest.time / 1000, tz=timezone.utc).isoformat(),
            "latestCandleEt": datetime.fromtimestamp(latest.time / 1000, tz=timezone.utc).astimezone(ET_ZONE).strftime("%b %d, %I:%M %p %Z"),
            "minutesOld": freshness_minutes,
            "status": "fresh" if freshness_minutes <= 10 else "delayed" if freshness_minutes <= 30 else "stale",
        },
        "volume": volume_read(candles),
        "gap": None if pdc is None else {
            "points": rp(price - pdc),
            "mesDollars": rd((price - pdc) * 5),
            "esDollars": rd((price - pdc) * 50),
            "direction": "up" if price > pdc else "down" if price < pdc else "flat",
        },
        "keyLevels": {
            "overnightHigh": rn(overnight_range["high"]),
            "overnightLow": rn(overnight_range["low"]),
            "priorDayHigh": rn(prior_range["high"]),
            "priorDayLow": rn(prior_range["low"]),
            "priorDayClose": rn(pdc),
            "sessionHigh": rn(current_range["high"]),
            "sessionLow": rn(current_range["low"]),
            "vwap": rn(vwap),
        },
    }


def current_session_candles(candles: list[Candle], session: dict, target: str, overnight_start: str) -> list[Candle]:
    if session["id"] == "rth":
        return [c for c in candles if is_rth(c, target)]
    if session["id"] in {"premarket", "eth-europe"}:
        return [
            c for c in candles
            if (c.et["dateKey"] == overnight_start and c.et["minutes"] >= 1080)
            or (c.et["dateKey"] == target and c.et["minutes"] < 570)
        ]
    if session["id"] in {"eth-asia", "eth-globex"}:
        start = previous_date(target)
        return [c for c in candles if c.et["dateKey"] == start and c.et["minutes"] >= 1080]
    return candles[-80:]


def indicator_pack(context: dict) -> dict:
    fast = context["session"]["id"] == "rth"
    macd_candles = context["candles"] if fast else resample(context["candles"], 15)
    return {
        "macd": macd_read(macd_candles, "5-minute" if fast else "15-minute"),
        "rsiVwap": rsi_vwap_read(context),
        "cvd": cvd_proxy_read(context),
        "historical": pattern_read(context),
    }


def macd_read(candles: list[Candle], timeframe: str) -> dict:
    data = compute_macd([c.close for c in candles])
    latest = find_last(data["histogram"])
    if latest < 1:
        return item("macd", "MACD Momentum", "neutral", f"{timeframe} MACD needs more candles before it can be trusted.")
    line, signal, hist = data["line"][latest], data["signal"][latest], data["histogram"][latest]
    prev_hist = data["histogram"][latest - 1] or 0
    direction = "bullish" if line > signal and hist > 0 else "bearish" if line < signal and hist < 0 else "neutral"
    cross = bars_since_cross(data["line"], data["signal"], latest)
    return {
        **item(
            "macd",
            "MACD Momentum",
            direction,
            f"{timeframe} MACD is {'above' if line >= signal else 'below'} signal; histogram is {'expanding' if abs(hist) > abs(prev_hist) else 'contracting'}; last crossover {'not found' if cross is None else str(cross) + ' bars ago'}.",
        ),
        "values": {"line": rp(line), "signal": rp(signal), "histogram": rp(hist)},
    }


def rsi_vwap_read(context: dict) -> dict:
    rsi_values = compute_rsi([c.close for c in context["candles"]])
    rsi = rsi_values[-1] if rsi_values else None
    vwap = context["vwap"]
    if not finite(rsi) or not finite(vwap):
        return {**item("rsiVwap", "RSI + VWAP", "neutral", "RSI or VWAP is unavailable from the returned candles, so this filter stays neutral."), "values": {"rsi": rn(rsi), "vwap": rn(vwap)}}
    distance = context["price"] - vwap
    stretched = finite(context["atr"]) and abs(distance) >= context["atr"] * 0.5
    if rsi < 30 and distance < 0 and stretched:
        direction, reason = "bullish", f"RSI {rp(rsi)} is oversold and price is {rp(abs(distance))} pts below VWAP."
    elif rsi > 70 and distance > 0 and stretched:
        direction, reason = "bearish", f"RSI {rp(rsi)} is overbought and price is {rp(distance)} pts above VWAP."
    elif distance > 0 and 40 <= rsi <= 70:
        direction, reason = "bullish", f"Price is above VWAP with RSI {rp(rsi)} in the trend zone."
    elif distance < 0 and 30 <= rsi <= 60:
        direction, reason = "bearish", f"Price is below VWAP with RSI {rp(rsi)} in the trend zone."
    else:
        direction, reason = "neutral", f"RSI {rp(rsi)} and VWAP distance {rp(distance)} pts do not line up cleanly."
    return {**item("rsiVwap", "RSI + VWAP", direction, reason), "values": {"rsi": rp(rsi), "vwap": rn(vwap), "distancePoints": rp(distance)}}


def cvd_proxy_read(context: dict) -> dict:
    recent = context["candles"][-60:]
    if sum(1 for c in recent if c.volume > 0) < 20:
        return item("cvd", "CVD Divergence", "neutral", "True bid/ask CVD is unavailable and returned volume is too sparse for a useful proxy.")
    cvd, running = [], 0
    for c in recent:
        running += c.volume if c.close > c.open else -c.volume if c.close < c.open else 0
        cvd.append(running)
    split = len(recent) // 2
    first, second = recent[:split], recent[split:]
    if max(c.high for c in second) > max(c.high for c in first) and max(cvd[split:]) < max(cvd[:split]):
        return item("cvd", "CVD Divergence", "bearish", "Price made a higher recent high while the volume-delta proxy made a lower high.")
    if min(c.low for c in second) < min(c.low for c in first) and min(cvd[split:]) > min(cvd[:split]):
        return item("cvd", "CVD Divergence", "bullish", "Price made a lower recent low while the volume-delta proxy made a higher low.")
    price_slope, cvd_slope = recent[-1].close - recent[0].close, cvd[-1] - cvd[0]
    if price_slope > 0 and cvd_slope > 0:
        return item("cvd", "CVD Divergence", "bullish", "Price and the volume-delta proxy are rising together, confirming upside flow.")
    if price_slope < 0 and cvd_slope < 0:
        return item("cvd", "CVD Divergence", "bearish", "Price and the volume-delta proxy are falling together, confirming downside flow.")
    return item("cvd", "CVD Divergence", "neutral", "No useful divergence or flow confirmation is visible in the proxy.")


def pattern_read(context: dict) -> dict:
    levels, price = context["keyLevels"], context["price"]
    ema20 = last_finite(ema([c.close for c in context["candles"]], 20))
    ema50 = last_finite(ema([c.close for c in context["candles"]], 50))
    if finite(levels.get("priorDayHigh")) and price > levels["priorDayHigh"]:
        return item("historical", "Historical Match", "bullish", "Price is breaking above prior day high, a local breakout pattern that favors upside follow-through until it fails.")
    if finite(levels.get("priorDayLow")) and price < levels["priorDayLow"]:
        return item("historical", "Historical Match", "bearish", "Price is breaking below prior day low, a local breakdown pattern that favors downside follow-through until reclaimed.")
    if finite(ema20) and finite(ema50) and finite(levels.get("vwap")):
        if ema20 > ema50 and price > levels["vwap"]:
            return item("historical", "Historical Match", "bullish", "The 5-day local pattern is trending up: EMA20 is above EMA50 and price is holding above VWAP.")
        if ema20 < ema50 and price < levels["vwap"]:
            return item("historical", "Historical Match", "bearish", "The 5-day local pattern is trending down: EMA20 is below EMA50 and price is holding below VWAP.")
    if finite(levels.get("sessionHigh")) and finite(levels.get("sessionLow")) and finite(context["atr"]):
        if levels["sessionHigh"] - levels["sessionLow"] < context["atr"] * 2:
            return item("historical", "Historical Match", "neutral", "Current range is compressed versus ATR, so this looks more like chop than a clean trend.")
    return item("historical", "Historical Match", "neutral", "No strong local trend, range, or breakout pattern is visible in the returned data.")


def macro_read(vix: dict | None, tnx: dict | None, headlines: list[dict]) -> dict:
    notes, score = [], 0.0
    if vix and len(vix["candles"]) > 4:
        start = vix["candles"][-12].close if len(vix["candles"]) >= 12 else vix["candles"][0].close
        change = pct(start, vix["candles"][-1].close)
        if finite(change):
            if change <= -1:
                score += 1; notes.append(f"VIX is down {rp(abs(change))}% over the sampled window, easing pressure on equities.")
            elif change >= 1:
                score -= 1; notes.append(f"VIX is up {rp(change)}% over the sampled window, adding short-term pressure.")
            else:
                notes.append(f"VIX is little changed ({rp(change)}%), so volatility is not a strong directional input.")
    if tnx and len(tnx["candles"]) > 4:
        start = tnx["candles"][-12].close if len(tnx["candles"]) >= 12 else tnx["candles"][0].close
        change = tnx["candles"][-1].close - start
        if finite(change) and abs(change) >= 0.05:
            score += -0.5 if change > 0 else 0.5
            notes.append(f"10-year yield proxy is {'rising' if change > 0 else 'falling'} by {rp(abs(change))} pts.")
    fresh_headlines = recent_headlines(headlines)
    headline_score, headline_note = headline_bias(fresh_headlines)
    if not fresh_headlines and headlines:
        headline_note = "Headline feed returned items, but none were published in the last 48 hours; headline sentiment stays neutral."
    score += headline_score
    if headline_note:
        notes.append(headline_note)
    sentiment = "BULLISH" if score >= 1 else "BEARISH" if score <= -1 else "NEUTRAL"
    return {
        "direction": "bullish" if sentiment == "BULLISH" else "bearish" if sentiment == "BEARISH" else "neutral",
        "sentiment": sentiment,
        "binaryEventRisk": any(binary_headline(h) for h in headlines),
        "newsImpact": {
            "headline": fresh_headlines[0]["title"] if fresh_headlines else "No fresh market headline returned in the last 48 hours.",
            "sentiment": sentiment,
            "explanation": notes[0] if notes else "Macro inputs are mixed or unavailable, so news impact stays neutral.",
            "headlines": fresh_headlines,
        },
    }


def decide(context: dict, indicators: dict, macro: dict, account_size: float) -> dict:
    components = [
        {**indicators["macd"], "weight": 1.25},
        {**indicators["rsiVwap"], "weight": 1.25},
        {**indicators["cvd"], "weight": 0.75},
        {**indicators["historical"], "weight": 1},
        {"label": "News/Macro", "direction": macro["direction"], "reason": macro["newsImpact"]["explanation"], "weight": 1},
    ]
    score = sum(c["weight"] * direction_value(c["direction"]) for c in components)
    warnings = []
    if context["freshness"]["status"] == "delayed":
        warnings.append(f"Latest candle is {context['freshness']['minutesOld']} minutes old; treat this as delayed.")
    if context["freshness"]["status"] == "stale":
        warnings.append(f"Latest candle is {context['freshness']['minutesOld']} minutes old; signal must wait for fresher data.")
    if context["session"]["id"] != "rth":
        warnings.append(f"{context['session']['label']} has thinner liquidity and wider spreads than RTH.")
    if macro["binaryEventRisk"]:
        warnings.append("Recent CPI/FOMC/NFP/PCE-style headline detected; do not hold through binary events.")
    risk_cap = clamp(account_size * 0.02, 20, 60)
    max_stop = rp(risk_cap / 5)
    ideal_stop = round_tick(clamp((context["atr"] or 6) * 0.8, 4, 12))
    action = "LONG" if score >= 2.5 else "SHORT" if score <= -2.5 else "WAIT"
    if context["session"]["id"] == "closed":
        action = "WAIT"; warnings.append("Futures are closed; wait for Globex reopen or RTH.")
    if context["freshness"]["status"] == "stale" or macro["binaryEventRisk"]:
        action = "WAIT"
    if action != "WAIT" and ideal_stop > max_stop:
        action = "WAIT"; warnings.append(f"Volatility implies a {ideal_stop} pt stop, above the {max_stop} pt paper-risk cap.")
    reference = action if action != "WAIT" else "LONG" if score > 0.75 else "SHORT" if score < -0.75 else "WAIT"
    plan = entry_plan(action, context["price"], ideal_stop, max_stop)
    return {
        "action": action,
        "confidence": confidence(action, score, warnings),
        "maxRiskDollars": risk_cap,
        "maxStopPoints": max_stop,
        "entryPlan": plan,
        "scorecard": [
            {
                "label": c["label"],
                "rating": macro["sentiment"] if c["label"] == "News/Macro" else rate(c["direction"], reference),
                "bias": c["direction"].upper(),
                "reason": c["reason"],
            }
            for c in components
        ],
        "reasoning": reasoning(action, score, indicators, macro, warnings),
        "warnings": warnings,
        "exitTriggers": exits(action, plan),
        "riskRules": [
            f"Max risk per trade: 2% of paper account, capped at ${rd(risk_cap)} MES risk.",
            "Position size: 1 MES contract until the paper strategy is consistently profitable.",
            "Max trades per day: 3. If 2 consecutive losers occur, stop for the session.",
            "Do not hold through CPI, FOMC, NFP, PCE, or other binary macro releases.",
        ],
    }


def entry_plan(action: str, price: float, ideal_stop: float, max_stop: float) -> dict:
    if action == "WAIT":
        return {"entry": None, "stop": None, "target1": None, "target2": None, "riskReward": None, "note": "No trade. Wait for at least three framework checks to align with fresh data and acceptable stop distance."}
    stop_distance = round_tick(min(ideal_stop, max_stop))
    entry = round_tick(price)
    direction = 1 if action == "LONG" else -1
    stop = round_tick(entry - direction * stop_distance)
    target1 = round_tick(entry + direction * stop_distance * 1.5)
    target2 = round_tick(entry + direction * stop_distance * 2.5)
    return {
        "entry": entry,
        "stop": stop,
        "target1": target1,
        "target2": target2,
        "riskPoints": stop_distance,
        "target1Points": rp(abs(target1 - entry)),
        "target2Points": rp(abs(target2 - entry)),
        "riskMesDollars": rd(stop_distance * 5),
        "riskEsDollars": rd(stop_distance * 50),
        "target1MesDollars": rd(abs(target1 - entry) * 5),
        "target1EsDollars": rd(abs(target1 - entry) * 50),
        "target2MesDollars": rd(abs(target2 - entry) * 5),
        "target2EsDollars": rd(abs(target2 - entry) * 50),
        "riskReward": f"1:{rp(abs(target2 - entry) / stop_distance)}",
        "note": "Paper setup only. Do not chase; invalidate if price hits the stop before entry.",
    }


def reasoning(action: str, score: float, indicators: dict, macro: dict, warnings: list[str]) -> str:
    if action == "WAIT":
        warning = f" {warnings[0]}" if warnings else ""
        return f"Framework score is {rp(score)}, which is not clean enough after risk/session filters. MACD is {indicators['macd']['direction']}, RSI/VWAP is {indicators['rsiVwap']['direction']}, and macro is {macro['sentiment'].lower()}.{warning}"
    side = "bullish" if action == "LONG" else "bearish"
    return f"Framework score is {rp(score)} with a {side} bias. The trade is only valid while momentum, VWAP position, and macro context remain aligned; otherwise the correct paper-trading action is WAIT."


def exits(action: str, plan: dict) -> list[str]:
    if action == "WAIT":
        return [
            "Check back after the next 5-minute candle closes with fresh data.",
            "Only consider a paper trade after MACD, RSI/VWAP, and local pattern align.",
            "Stay flat ahead of binary macro events or if the required MES risk exceeds the account cap.",
        ]
    side = "above" if action == "LONG" else "below"
    return [
        f"Take partial profit at T1 ({fmt_price(plan['target1'])}) or if momentum starts contracting hard.",
        f"Hold runner toward T2 ({fmt_price(plan['target2'])}) only while price stays {side} VWAP.",
        f"Stop out at {fmt_price(plan['stop'])} with no averaging down.",
        "Exit by 3:45pm ET before the futures close window unless this is explicitly paper-tested for ETH.",
    ]


def trading_session(date: datetime) -> dict:
    et = et_parts(date)
    weekday, minutes = weekday_index(et["dateKey"]), et["minutes"]
    if weekday == 6 or (weekday == 0 and minutes < 1080) or (weekday == 5 and minutes >= 1020):
        return {"id": "closed", "label": "Closed", "quality": "closed", "note": "Weekly futures session is closed."}
    if 1020 <= minutes < 1080:
        return {"id": "closed", "label": "Closed", "quality": "closed", "note": "Daily 5:00pm-6:00pm ET maintenance break."}
    if 1 <= weekday <= 5 and 570 <= minutes < 960:
        return {"id": "rth", "label": "RTH", "quality": "best", "note": "Regular Trading Hours: best liquidity and tightest spreads."}
    if 360 <= minutes < 570:
        return {"id": "premarket", "label": "Pre-Market", "quality": "medium", "note": "Liquidity is improving, but spreads can still be wider than RTH."}
    if minutes < 360:
        return {"id": "eth-europe", "label": "ETH-Europe", "quality": "thin", "note": "Europe/overnight trade can move on macro headlines with thinner liquidity."}
    if minutes >= 1080:
        return {"id": "eth-asia", "label": "ETH-Asia", "quality": "thin", "note": "Globex evening trade is usually thin; paper trade smaller and be selective."}
    return {"id": "eth-globex", "label": "ETH-Globex", "quality": "thin", "note": "Extended-hours trade has wider spreads and lower volume than RTH."}


def target_rth_date(date: datetime) -> str:
    parts = et_parts(date)
    if parts["minutes"] >= 1080 or weekday_index(parts["dateKey"]) in {0, 6}:
        return next_business_date(parts["dateKey"])
    return parts["dateKey"]


def et_parts(date: datetime) -> dict:
    local = date.astimezone(ET_ZONE)
    return {"dateKey": local.strftime("%Y-%m-%d"), "hour": local.hour, "minute": local.minute, "minutes": local.hour * 60 + local.minute}


def is_rth(candle: Candle, date_key: str) -> bool:
    return candle.et["dateKey"] == date_key and 570 <= candle.et["minutes"] < 960


def previous_business_date(date_key: str) -> str:
    current = previous_date(date_key)
    while weekday_index(current) not in {1, 2, 3, 4, 5}:
        current = previous_date(current)
    return current


def next_business_date(date_key: str) -> str:
    current = next_date(date_key)
    while weekday_index(current) not in {1, 2, 3, 4, 5}:
        current = next_date(current)
    return current


def previous_date(date_key: str) -> str:
    return add_days(date_key, -1)


def next_date(date_key: str) -> str:
    return add_days(date_key, 1)


def add_days(date_key: str, days: int) -> str:
    return (datetime.strptime(date_key, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def weekday_index(date_key: str) -> int:
    return (datetime.strptime(date_key, "%Y-%m-%d").weekday() + 1) % 7


def candle_range(candles: list[Candle]) -> dict:
    highs = [c.high for c in candles if finite(c.high)]
    lows = [c.low for c in candles if finite(c.low)]
    return {"high": max(highs) if highs else None, "low": min(lows) if lows else None}


def volume_read(candles: list[Candle]) -> dict:
    vols = [c.volume for c in candles if c.volume > 0]
    if len(vols) < 40:
        return {"status": "unknown", "ratio": None, "note": "Volume was sparse or unavailable from the source."}
    recent, baseline = mean(vols[-20:]), mean(vols[-120:-20])
    ratio = recent / baseline if baseline else None
    status = "unknown" if ratio is None else "above normal" if ratio >= 1.2 else "below normal" if ratio <= 0.8 else "normal"
    return {"status": status, "ratio": rp(ratio), "note": "Not enough baseline volume." if ratio is None else f"Recent 5m volume is {rp(ratio)}x its local baseline."}


def compute_vwap(candles: list[Candle]) -> float | None:
    pv = vol = 0.0
    for c in candles:
        if c.volume > 0 and finite(c.high) and finite(c.low) and finite(c.close):
            pv += ((c.high + c.low + c.close) / 3) * c.volume
            vol += c.volume
    return pv / vol if vol else None


def compute_macd(values: list[float]) -> dict:
    fast, slow = ema(values, 12), ema(values, 26)
    line = [f - s if finite(f) and finite(s) else None for f, s in zip(fast, slow)]
    signal = ema(line, 9)
    histogram = [v - s if finite(v) and finite(s) else None for v, s in zip(line, signal)]
    return {"line": line, "signal": signal, "histogram": histogram}


def compute_rsi(values: list[float], period: int = 14) -> list[float | None]:
    out = [None] * len(values)
    if len(values) <= period:
        return out
    gain = loss = 0.0
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        gain += max(change, 0)
        loss += max(-change, 0)
    avg_gain, avg_loss = gain / period, loss / period
    out[period] = rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, len(values)):
        change = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0)) / period
        out[i] = rsi_value(avg_gain, avg_loss)
    return out


def rsi_value(avg_gain: float, avg_loss: float) -> float:
    return 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)


def compute_atr(candles: list[Candle], period: int = 14) -> float | None:
    if len(candles) <= period:
        return None
    ranges = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        ranges.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
    return mean(ranges[-period:])


def ema(values: list[float | None], period: int) -> list[float | None]:
    out, seed, current = [None] * len(values), [], None
    multiplier = 2 / (period + 1)
    for i, value in enumerate(values):
        if not finite(value):
            continue
        if current is None:
            seed.append(value)
            if len(seed) == period:
                current = mean(seed)
                out[i] = current
            continue
        current = (value - current) * multiplier + current
        out[i] = current
    return out


def resample(candles: list[Candle], minutes: int) -> list[Candle]:
    bucket_ms, buckets = minutes * 60 * 1000, {}
    for c in candles:
        t = int(c.time // bucket_ms * bucket_ms)
        if t not in buckets:
            buckets[t] = Candle(t, c.open, c.high, c.low, c.close, c.volume, c.et)
        else:
            b = buckets[t]
            b.high, b.low, b.close, b.volume = max(b.high, c.high), min(b.low, c.low), c.close, b.volume + c.volume
    return [buckets[key] for key in sorted(buckets)]


def bars_since_cross(line: list, signal: list, latest: int) -> int | None:
    prev = sign((line[latest] or 0) - (signal[latest] or 0))
    for i in range(latest - 1, -1, -1):
        if not finite(line[i]) or not finite(signal[i]):
            continue
        current = sign(line[i] - signal[i])
        if current and prev and current != prev:
            return latest - i
        if current:
            prev = current
    return None


def headline_bias(headlines: list[dict]) -> tuple[float, str]:
    if not headlines:
        return 0, "No fresh headline feed was returned, so headline sentiment stays neutral."
    bearish = re.compile(r"\b(hawkish|inflation|tariff|war|sanction|selloff|recession|higher yields|rate hike|default|risk-off)\b", re.I)
    bullish = re.compile(r"\b(rate cut|cuts|easing|rally|soft landing|beats estimates|risk-on|cooling inflation|deal)\b", re.I)
    score, matched = 0.0, []
    for h in headlines[:5]:
        title = h.get("title", "")
        if bearish.search(title):
            score -= 0.25; matched.append(f"bearish headline: {title}")
        elif bullish.search(title):
            score += 0.25; matched.append(f"bullish headline: {title}")
    return score, matched[0] if matched else f"Latest headline is \"{headlines[0]['title']}\", with no strong keyword bias."


def recent_headlines(headlines: list[dict], hours: int = 48) -> list[dict]:
    fresh = []
    for headline in headlines:
        age = headline_age_hours(headline)
        if age is None or age <= hours:
            fresh.append(headline)
    return fresh


def headline_age_hours(item_: dict) -> float | None:
    if not item_.get("pubDate"):
        return None
    try:
        parsed = parsedate_to_datetime(item_["pubDate"]).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None
    return (datetime.now(timezone.utc) - parsed).total_seconds() / 3600


def binary_headline(item_: dict) -> bool:
    recent = True
    if item_.get("pubDate"):
        try:
            recent = datetime.now(timezone.utc) - parsedate_to_datetime(item_["pubDate"]).astimezone(timezone.utc) < timedelta(hours=8)
        except (TypeError, ValueError):
            recent = True
    return recent and bool(re.search(r"\b(CPI|FOMC|NFP|nonfarm|PCE|rate decision|jobs report)\b", item_.get("title", ""), re.I))


def fetch_json(url: str) -> dict:
    return json.loads(fetch_text(url))


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"accept": "application/json,application/rss+xml,text/xml,text/plain,*/*", "user-agent": "SignalDeckFutures/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=9) as response:
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {urllib.parse.urlparse(url).hostname}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {urllib.parse.urlparse(url).hostname}: {exc.reason}") from exc


def news_url(symbol: str) -> str:
    return f"{YAHOO_RSS_BASE}?s={urllib.parse.quote(symbol, safe='')}&region=US&lang=en-US"


def item(key: str, label: str, direction: str, reason: str) -> dict:
    return {"key": key, "label": label, "direction": direction, "reason": reason}


def confidence(action: str, score: float, warnings: list[str]) -> str:
    if action == "WAIT":
        return "MEDIUM" if abs(score) >= 2 else "LOW"
    if len(warnings) >= 2:
        return "LOW"
    return "HIGH" if abs(score) >= 4 else "MEDIUM" if abs(score) >= 3 else "LOW"


def rate(direction: str, action: str) -> str:
    if action == "WAIT" or direction == "neutral":
        return "NEUTRAL"
    return "PASS" if (action == "LONG" and direction == "bullish") or (action == "SHORT" and direction == "bearish") else "FAIL"


def direction_value(direction: str) -> int:
    return 1 if direction == "bullish" else -1 if direction == "bearish" else 0


def safe(fn):
    try:
        return fn()
    except Exception:
        return None


def text_of(node: ET.Element, tag: str) -> str:
    child = node.find(tag)
    return (child.text or "").strip() if child is not None else ""


def num_at(values, index: int) -> float | None:
    return to_float(values[index]) if isinstance(values, list) and index < len(values) else None


def to_float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def sanitize_symbol(symbol: str) -> str:
    normalized = (symbol or DEFAULT_SYMBOL).strip().upper()
    return normalized if re.fullmatch(r"[A-Z0-9=.^-]{1,20}", normalized) else DEFAULT_SYMBOL


def first(values, default=None):
    return values[0] if isinstance(values, list) and values else values if values is not None and not isinstance(values, list) else default


def clamp(value: float | None, low: float, high: float) -> float:
    return low if value is None or not math.isfinite(value) else min(high, max(low, value))


def finite(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def mean(values: list[float]) -> float | None:
    valid = [value for value in values if finite(value)]
    return statistics.fmean(valid) if valid else None


def last_finite(values: list[float | None]) -> float | None:
    return next((value for value in reversed(values) if finite(value)), None)


def find_last(values: list[float | None]) -> int:
    for i in range(len(values) - 1, -1, -1):
        if finite(values[i]):
            return i
    return -1


def pct(previous: float, current: float) -> float | None:
    return ((current - previous) / abs(previous)) * 100 if finite(previous) and previous != 0 and finite(current) else None


def sign(value: float) -> int:
    return 1 if value > 0 else -1 if value < 0 else 0


def round_tick(value: float | None, tick: float = 0.25) -> float | None:
    return round(value / tick) * tick if finite(value) else None


def rp(value: float | None) -> float | None:
    return round(value, 2) if finite(value) else None


def rn(value: float | None) -> float | None:
    return rp(value)


def rd(value: float | None) -> float | None:
    return round(value, 2) if finite(value) else None


def fmt_price(value: float | None) -> str:
    return f"{value:.2f}" if finite(value) else "n/a"


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Signal Deck Futures dashboard running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
