import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 5174);
const ET_ZONE = "America/New_York";
const DEFAULT_SYMBOL = "ES=F";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_RSS_BASE = "https://feeds.finance.yahoo.com/rss/2.0/headline";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const PAPER_TRADING_DISCLAIMER =
  "Paper trading education only. This is not financial advice. Futures are leveraged instruments and can lose more than the initial deposit.";

function createDashboardServer() {
  return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/analyze") {
      await handleAnalyze(url, res);
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: "SERVER_ERROR",
      message: error instanceof Error ? error.message : "Unexpected server error"
    });
  }
  });
}

if (isMainModule()) {
  const server = createDashboardServer();
  server.listen(PORT, () => {
    console.log(`Signal Deck Futures dashboard running at http://localhost:${PORT}`);
  });
}

function isMainModule() {
  return process.argv[1] && normalize(fileURLToPath(import.meta.url)) === normalize(process.argv[1]);
}

async function handleAnalyze(url, res) {
  const symbol = sanitizeSymbol(url.searchParams.get("symbol") || DEFAULT_SYMBOL);
  const accountSize = clamp(Number(url.searchParams.get("account") || 1000), 100, 1000000);

  try {
    const analysis = await buildAnalysis(symbol, accountSize);
    sendJson(res, 200, analysis);
  } catch (error) {
    sendJson(res, 502, {
      error: "DATA_UNAVAILABLE",
      action: "WAIT",
      confidence: "LOW",
      message: error instanceof Error ? error.message : "Market data could not be loaded",
      disclaimer: PAPER_TRADING_DISCLAIMER,
      generatedAt: new Date().toISOString()
    });
  }
}

async function serveStatic(pathname, res) {
  const requestPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const safePath = normalize(join(PUBLIC_DIR, requestPath));

  if (!safePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(safePath);
    const contentType = MIME_TYPES[extname(safePath)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-cache"
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function buildAnalysis(symbol, accountSize) {
  const market = await fetchYahooChart(symbol, "5d", "5m");
  if (market.candles.length < 60) {
    throw new Error("Not enough intraday candles returned by the market data source.");
  }

  const [vixResult, tnxResult, newsResult] = await Promise.allSettled([
    fetchYahooChart("^VIX", "2d", "15m"),
    fetchYahooChart("^TNX", "2d", "15m"),
    fetchYahooNews(symbol)
  ]);

  const vix = vixResult.status === "fulfilled" ? vixResult.value : null;
  const tnx = tnxResult.status === "fulfilled" ? tnxResult.value : null;
  const headlines = newsResult.status === "fulfilled" ? newsResult.value.items : [];
  const sources = [
    { label: `Yahoo Finance chart: ${symbol}`, url: market.url }
  ];

  if (vix) sources.push({ label: "Yahoo Finance chart: VIX", url: vix.url });
  if (tnx) sources.push({ label: "Yahoo Finance chart: 10-year yield proxy (^TNX)", url: tnx.url });
  if (newsResult.status === "fulfilled") sources.push({ label: "Yahoo Finance market headlines", url: newsResult.value.url });

  const context = buildMarketContext(market, symbol);
  const indicators = buildIndicatorPack(context);
  const macro = buildMacroRead(vix, tnx, headlines);
  const decision = decideSignal(context, indicators, macro, accountSize);

  return {
    generatedAt: new Date().toISOString(),
    symbol,
    instrument: describeInstrument(symbol),
    contract: {
      mes: { label: "MES", dollarsPerPoint: 5, dollarsPerTick: 1.25 },
      es: { label: "ES", dollarsPerPoint: 50, dollarsPerTick: 12.5 },
      tickSize: 0.25
    },
    source: {
      name: "Yahoo Finance public chart/RSS APIs",
      caveat: "Quotes may be delayed and the ES=F symbol is a continuous/front-month proxy. True bid/ask CVD is not available from this source."
    },
    disclaimer: PAPER_TRADING_DISCLAIMER,
    action: decision.action,
    confidence: decision.confidence,
    price: context.price,
    session: context.session,
    account: {
      size: accountSize,
      maxRiskDollars: decision.maxRiskDollars,
      maxStopPoints: decision.maxStopPoints
    },
    freshness: context.freshness,
    volume: context.volume,
    gap: context.gap,
    entryPlan: decision.entryPlan,
    keyLevels: context.keyLevels,
    scorecard: decision.scorecard,
    reasoning: decision.reasoning,
    exitTriggers: decision.exitTriggers,
    riskRules: decision.riskRules,
    newsImpact: macro.newsImpact,
    warnings: decision.warnings,
    chart: buildChartPayload(context),
    sources
  };
}

async function fetchYahooChart(symbol, range, interval) {
  const encoded = encodeURIComponent(symbol);
  const url = `${YAHOO_CHART_BASE}/${encoded}?range=${range}&interval=${interval}&includePrePost=true`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  const error = data?.chart?.error;

  if (error) {
    throw new Error(error.description || `Yahoo Finance rejected ${symbol}.`);
  }

  if (!result?.timestamp?.length) {
    throw new Error(`No chart data returned for ${symbol}.`);
  }

  const quote = result.indicators?.quote?.[0] || {};
  const candles = result.timestamp
    .map((timestamp, index) => {
      const close = numeric(quote.close?.[index]);
      const fallback = close ?? numeric(quote.open?.[index]);

      return {
        time: timestamp * 1000,
        open: numeric(quote.open?.[index]) ?? fallback,
        high: numeric(quote.high?.[index]) ?? fallback,
        low: numeric(quote.low?.[index]) ?? fallback,
        close,
        volume: Math.max(0, numeric(quote.volume?.[index]) ?? 0)
      };
    })
    .filter(isPlausibleCandle);

  return {
    symbol,
    url,
    meta: result.meta || {},
    candles
  };
}


function isPlausibleCandle(candle) {
  const values = [candle.open, candle.high, candle.low, candle.close];
  if (!values.every((value) => Number.isFinite(value) && value > 0)) return false;
  if (candle.high < candle.low) return false;

  const reference = candle.close;
  const maxDistance = Math.max(reference * 0.08, 200);
  return Math.abs(candle.high - reference) <= maxDistance && Math.abs(candle.low - reference) <= maxDistance;
}

async function fetchYahooNews(symbol) {
  const url = `${YAHOO_RSS_BASE}?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const xml = await fetchText(url);
  return {
    url,
    items: parseRssItems(xml).slice(0, 5)
  };
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": "SignalDeckFutures/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/rss+xml,text/xml,text/plain,*/*",
      "user-agent": "SignalDeckFutures/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }

  return response.text();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildMarketContext(market, symbol) {
  const now = new Date();
  const session = getTradingSession(now);
  const enriched = market.candles.map((candle) => ({
    ...candle,
    et: getEtParts(new Date(candle.time))
  }));
  const latest = enriched.at(-1);
  const price = roundToTick(latest.close);
  const targetRthDate = getTargetRthDateKey(now);
  const priorRthDate = previousBusinessDateKey(targetRthDate);
  const overnightStartDate = previousCalendarDateKey(targetRthDate);

  const priorRth = enriched.filter((candle) => isRthCandle(candle, priorRthDate));
  const targetRth = enriched.filter((candle) => isRthCandle(candle, targetRthDate));
  const overnight = enriched.filter((candle) => (
    (candle.et.dateKey === overnightStartDate && candle.et.minutes >= 1080) ||
    (candle.et.dateKey === targetRthDate && candle.et.minutes < 570)
  ));

  const currentSessionCandles = pickCurrentSessionCandles(enriched, session, targetRthDate, overnightStartDate);
  const vwap = computeVwap(currentSessionCandles) ?? computeVwap(targetRth) ?? computeVwap(overnight);
  const atr = computeAtr(enriched, 14);
  const pdc = priorRth.at(-1)?.close ?? numeric(market.meta.previousClose) ?? null;
  const currentRange = rangeFromCandles(currentSessionCandles);
  const priorRange = rangeFromCandles(priorRth);
  const overnightRange = rangeFromCandles(overnight);
  const volumeRead = readVolume(enriched);
  const freshnessMinutes = Math.max(0, Math.round((Date.now() - latest.time) / 60000));

  return {
    symbol,
    candles: enriched,
    price,
    now: now.toISOString(),
    session,
    targetRthDate,
    atr,
    vwap,
    currentSessionCandles,
    freshness: {
      latestCandleAt: new Date(latest.time).toISOString(),
      latestCandleEt: formatEtDateTime(new Date(latest.time)),
      minutesOld: freshnessMinutes,
      status: freshnessMinutes <= 10 ? "fresh" : freshnessMinutes <= 30 ? "delayed" : "stale"
    },
    volume: volumeRead,
    gap: pdc == null ? null : {
      points: roundPrice(price - pdc),
      mesDollars: roundDollars((price - pdc) * 5),
      esDollars: roundDollars((price - pdc) * 50),
      direction: price > pdc ? "up" : price < pdc ? "down" : "flat"
    },
    keyLevels: {
      overnightHigh: roundNullable(overnightRange.high),
      overnightLow: roundNullable(overnightRange.low),
      priorDayHigh: roundNullable(priorRange.high),
      priorDayLow: roundNullable(priorRange.low),
      priorDayClose: roundNullable(pdc),
      sessionHigh: roundNullable(currentRange.high),
      sessionLow: roundNullable(currentRange.low),
      vwap: roundNullable(vwap)
    }
  };
}

function pickCurrentSessionCandles(candles, session, targetRthDate, overnightStartDate) {
  if (session.id === "rth") {
    return candles.filter((candle) => isRthCandle(candle, targetRthDate));
  }

  if (session.id === "premarket" || session.id === "eth-europe") {
    return candles.filter((candle) => (
      (candle.et.dateKey === overnightStartDate && candle.et.minutes >= 1080) ||
      (candle.et.dateKey === targetRthDate && candle.et.minutes < 570)
    ));
  }

  if (session.id === "eth-asia" || session.id === "eth-globex") {
    return candles.filter((candle) => (
      candle.et.dateKey === previousCalendarDateKey(targetRthDate) && candle.et.minutes >= 1080
    ));
  }

  return candles.slice(-80);
}

function buildIndicatorPack(context) {
  const useFastMacd = context.session.id === "rth";
  const macdCandles = useFastMacd ? context.candles : resampleCandles(context.candles, 15);
  const macd = analyzeMacd(macdCandles, useFastMacd ? "5-minute" : "15-minute");
  const rsiVwap = analyzeRsiVwap(context);
  const cvd = analyzeCvdProxy(context);
  const historical = analyzeLocalPattern(context);

  return {
    macd,
    rsiVwap,
    cvd,
    historical
  };
}

function analyzeMacd(candles, timeframe) {
  const closes = candles.map((candle) => candle.close);
  const macd = computeMacd(closes);
  const latestIndex = findLastIndex(macd.histogram, Number.isFinite);

  if (latestIndex < 1) {
    return {
      key: "macd",
      label: "MACD Momentum",
      direction: "neutral",
      reason: `${timeframe} MACD needs more candles before it can be trusted.`
    };
  }

  const line = macd.line[latestIndex];
  const signal = macd.signal[latestIndex];
  const hist = macd.histogram[latestIndex];
  const prevHist = macd.histogram[latestIndex - 1] ?? 0;
  const direction = line > signal && hist > 0 ? "bullish" : line < signal && hist < 0 ? "bearish" : "neutral";
  const expanding = Math.abs(hist) > Math.abs(prevHist);
  const crossoverBars = barsSinceMacdCross(macd.line, macd.signal, latestIndex);

  return {
    key: "macd",
    label: "MACD Momentum",
    direction,
    values: {
      line: roundPrice(line),
      signal: roundPrice(signal),
      histogram: roundPrice(hist)
    },
    reason: `${timeframe} MACD is ${line >= signal ? "above" : "below"} signal; histogram is ${expanding ? "expanding" : "contracting"}; last crossover ${crossoverBars == null ? "not found" : `${crossoverBars} bars ago`}.`
  };
}

function analyzeRsiVwap(context) {
  const closes = context.candles.map((candle) => candle.close);
  const rsi = computeRsi(closes, 14).at(-1);

  if (!Number.isFinite(rsi) || !Number.isFinite(context.vwap)) {
    return {
      key: "rsiVwap",
      label: "RSI + VWAP",
      direction: "neutral",
      values: { rsi: roundNullable(rsi), vwap: roundNullable(context.vwap) },
      reason: "RSI or VWAP is unavailable from the returned candles, so this filter stays neutral."
    };
  }

  const distance = context.price - context.vwap;
  const stretched = Number.isFinite(context.atr) && Math.abs(distance) >= context.atr * 0.5;
  let direction = "neutral";
  let reason;

  if (rsi < 30 && distance < 0 && stretched) {
    direction = "bullish";
    reason = `RSI ${roundPrice(rsi)} is oversold and price is ${roundPrice(Math.abs(distance))} pts below VWAP, favoring a paper mean-reversion long.`;
  } else if (rsi > 70 && distance > 0 && stretched) {
    direction = "bearish";
    reason = `RSI ${roundPrice(rsi)} is overbought and price is ${roundPrice(distance)} pts above VWAP, favoring a paper mean-reversion short.`;
  } else if (distance > 0 && rsi >= 40 && rsi <= 70) {
    direction = "bullish";
    reason = `Price is above VWAP with RSI ${roundPrice(rsi)} in the trend zone.`;
  } else if (distance < 0 && rsi >= 30 && rsi <= 60) {
    direction = "bearish";
    reason = `Price is below VWAP with RSI ${roundPrice(rsi)} in the trend zone.`;
  } else {
    reason = `RSI ${roundPrice(rsi)} and VWAP distance ${roundPrice(distance)} pts do not line up cleanly.`;
  }

  return {
    key: "rsiVwap",
    label: "RSI + VWAP",
    direction,
    values: {
      rsi: roundPrice(rsi),
      vwap: roundNullable(context.vwap),
      distancePoints: roundPrice(distance)
    },
    reason
  };
}

function analyzeCvdProxy(context) {
  const recent = context.candles.slice(-60);
  const hasVolume = recent.filter((candle) => candle.volume > 0).length >= 20;

  if (!hasVolume) {
    return {
      key: "cvd",
      label: "CVD Divergence",
      direction: "neutral",
      reason: "True bid/ask CVD is unavailable and returned volume is too sparse for a useful proxy."
    };
  }

  const cvd = [];
  let running = 0;
  for (const candle of recent) {
    const delta = candle.close > candle.open ? candle.volume : candle.close < candle.open ? -candle.volume : 0;
    running += delta;
    cvd.push(running);
  }

  const split = Math.floor(recent.length / 2);
  const first = recent.slice(0, split);
  const second = recent.slice(split);
  const cvdFirst = cvd.slice(0, split);
  const cvdSecond = cvd.slice(split);
  const firstHigh = Math.max(...first.map((candle) => candle.high));
  const secondHigh = Math.max(...second.map((candle) => candle.high));
  const firstLow = Math.min(...first.map((candle) => candle.low));
  const secondLow = Math.min(...second.map((candle) => candle.low));
  const firstCvdHigh = Math.max(...cvdFirst);
  const secondCvdHigh = Math.max(...cvdSecond);
  const firstCvdLow = Math.min(...cvdFirst);
  const secondCvdLow = Math.min(...cvdSecond);
  const priceSlope = recent.at(-1).close - recent[0].close;
  const cvdSlope = cvd.at(-1) - cvd[0];

  if (secondHigh > firstHigh && secondCvdHigh < firstCvdHigh) {
    return {
      key: "cvd",
      label: "CVD Divergence",
      direction: "bearish",
      reason: "Price made a higher recent high while the volume-delta proxy made a lower high."
    };
  }

  if (secondLow < firstLow && secondCvdLow > firstCvdLow) {
    return {
      key: "cvd",
      label: "CVD Divergence",
      direction: "bullish",
      reason: "Price made a lower recent low while the volume-delta proxy made a higher low."
    };
  }

  if (priceSlope > 0 && cvdSlope > 0) {
    return {
      key: "cvd",
      label: "CVD Divergence",
      direction: "bullish",
      reason: "Price and the volume-delta proxy are rising together, confirming upside flow."
    };
  }

  if (priceSlope < 0 && cvdSlope < 0) {
    return {
      key: "cvd",
      label: "CVD Divergence",
      direction: "bearish",
      reason: "Price and the volume-delta proxy are falling together, confirming downside flow."
    };
  }

  return {
    key: "cvd",
    label: "CVD Divergence",
    direction: "neutral",
    reason: "No useful divergence or flow confirmation is visible in the proxy."
  };
}

function analyzeLocalPattern(context) {
  const closes = context.candles.map((candle) => candle.close);
  const ema20 = emaSeries(closes, 20).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const { priorDayHigh, priorDayLow, sessionHigh, sessionLow, vwap } = context.keyLevels;
  const sessionRange = Number.isFinite(sessionHigh) && Number.isFinite(sessionLow) ? sessionHigh - sessionLow : null;
  const atr = context.atr;

  if (Number.isFinite(priorDayHigh) && context.price > priorDayHigh) {
    return {
      key: "historical",
      label: "Historical Match",
      direction: "bullish",
      reason: "Price is breaking above prior day high, a local breakout pattern that favors upside follow-through until it fails."
    };
  }

  if (Number.isFinite(priorDayLow) && context.price < priorDayLow) {
    return {
      key: "historical",
      label: "Historical Match",
      direction: "bearish",
      reason: "Price is breaking below prior day low, a local breakdown pattern that favors downside follow-through until reclaimed."
    };
  }

  if (Number.isFinite(ema20) && Number.isFinite(ema50) && Number.isFinite(vwap)) {
    if (ema20 > ema50 && context.price > vwap) {
      return {
        key: "historical",
        label: "Historical Match",
        direction: "bullish",
        reason: "The 5-day local pattern is trending up: EMA20 is above EMA50 and price is holding above VWAP."
      };
    }

    if (ema20 < ema50 && context.price < vwap) {
      return {
        key: "historical",
        label: "Historical Match",
        direction: "bearish",
        reason: "The 5-day local pattern is trending down: EMA20 is below EMA50 and price is holding below VWAP."
      };
    }
  }

  if (Number.isFinite(sessionRange) && Number.isFinite(atr) && sessionRange < atr * 2) {
    return {
      key: "historical",
      label: "Historical Match",
      direction: "neutral",
      reason: "Current range is compressed versus ATR, so this looks more like chop than a clean trend."
    };
  }

  return {
    key: "historical",
    label: "Historical Match",
    direction: "neutral",
    reason: "No strong local trend, range, or breakout pattern is visible in the returned data."
  };
}

function buildMacroRead(vix, tnx, headlines) {
  const notes = [];
  let score = 0;

  if (vix?.candles?.length > 4) {
    const vixChange = percentChange(vix.candles.at(-12)?.close ?? vix.candles[0].close, vix.candles.at(-1).close);
    if (Number.isFinite(vixChange)) {
      if (vixChange <= -1) {
        score += 1;
        notes.push(`VIX is down ${roundPrice(Math.abs(vixChange))}% over the sampled window, easing pressure on equities.`);
      } else if (vixChange >= 1) {
        score -= 1;
        notes.push(`VIX is up ${roundPrice(vixChange)}% over the sampled window, adding short-term pressure.`);
      } else {
        notes.push(`VIX is little changed (${roundPrice(vixChange)}%), so volatility is not a strong directional input.`);
      }
    }
  }

  if (tnx?.candles?.length > 4) {
    const yieldChange = tnx.candles.at(-1).close - (tnx.candles.at(-12)?.close ?? tnx.candles[0].close);
    if (Number.isFinite(yieldChange)) {
      if (yieldChange >= 0.05) {
        score -= 0.5;
        notes.push(`10-year yield proxy is rising by ${roundPrice(yieldChange)} pts, a headwind for index futures.`);
      } else if (yieldChange <= -0.05) {
        score += 0.5;
        notes.push(`10-year yield proxy is falling by ${roundPrice(Math.abs(yieldChange))} pts, a tailwind for index futures.`);
      }
    }
  }

  const freshHeadlines = recentHeadlines(headlines);
  const headlineBias = scoreHeadlines(freshHeadlines);
  if (!freshHeadlines.length && headlines.length) {
    headlineBias.note = "Headline feed returned items, but none were published in the last 48 hours; headline sentiment stays neutral.";
  }
  score += headlineBias.score;
  if (headlineBias.note) notes.push(headlineBias.note);

  const sentiment = score >= 1 ? "BULLISH" : score <= -1 ? "BEARISH" : "NEUTRAL";
  const latestHeadline = freshHeadlines[0]?.title || "No fresh market headline returned in the last 48 hours.";
  const binaryEventRisk = headlines.some((item) => {
    const date = Date.parse(item.pubDate || "");
    const isRecent = Number.isFinite(date) ? Date.now() - date < 8 * 60 * 60 * 1000 : true;
    return isRecent && /\b(CPI|FOMC|NFP|nonfarm|PCE|rate decision|jobs report)\b/i.test(item.title || "");
  });

  return {
    direction: sentiment === "BULLISH" ? "bullish" : sentiment === "BEARISH" ? "bearish" : "neutral",
    sentiment,
    binaryEventRisk,
    newsImpact: {
      headline: latestHeadline,
      sentiment,
      explanation: notes[0] || "Macro inputs are mixed or unavailable, so news impact stays neutral.",
      headlines: freshHeadlines
    }
  };
}

function recentHeadlines(headlines, hours = 48) {
  return headlines.filter((item) => {
    const date = Date.parse(item.pubDate || "");
    if (!Number.isFinite(date)) return true;
    return Date.now() - date <= hours * 60 * 60 * 1000;
  });
}

function scoreHeadlines(headlines) {
  if (!headlines.length) {
    return { score: 0, note: "No fresh headline feed was returned, so headline sentiment stays neutral." };
  }

  const bearishWords = /\b(hawkish|inflation|tariff|war|sanction|selloff|recession|higher yields|rate hike|default|risk-off)\b/i;
  const bullishWords = /\b(rate cut|cuts|easing|rally|soft landing|beats estimates|risk-on|cooling inflation|deal)\b/i;
  let score = 0;
  const matched = [];

  for (const item of headlines.slice(0, 5)) {
    if (bearishWords.test(item.title)) {
      score -= 0.25;
      matched.push(`bearish headline: ${item.title}`);
    } else if (bullishWords.test(item.title)) {
      score += 0.25;
      matched.push(`bullish headline: ${item.title}`);
    }
  }

  return {
    score,
    note: matched[0] || `Latest headline is "${headlines[0].title}", with no strong keyword bias.`
  };
}

function decideSignal(context, indicators, macro, accountSize) {
  const components = [
    { ...indicators.macd, weight: 1.25 },
    { ...indicators.rsiVwap, weight: 1.25 },
    { ...indicators.cvd, weight: 0.75 },
    { ...indicators.historical, weight: 1 },
    {
      key: "macro",
      label: "News/Macro",
      direction: macro.direction,
      reason: macro.newsImpact.explanation,
      weight: 1
    }
  ];

  const rawScore = components.reduce((score, item) => {
    if (item.direction === "bullish") return score + item.weight;
    if (item.direction === "bearish") return score - item.weight;
    return score;
  }, 0);

  const warnings = [];
  if (context.freshness.status === "delayed") warnings.push(`Latest candle is ${context.freshness.minutesOld} minutes old; treat this as delayed.`);
  if (context.freshness.status === "stale") warnings.push(`Latest candle is ${context.freshness.minutesOld} minutes old; signal must wait for fresher data.`);
  if (context.session.id !== "rth") warnings.push(`${context.session.label} has thinner liquidity and wider spreads than RTH.`);
  if (macro.binaryEventRisk) warnings.push("Recent CPI/FOMC/NFP/PCE-style headline detected; do not hold through binary events.");

  const riskCap = clamp(accountSize * 0.02, 20, 60);
  const maxStopPoints = roundPrice(riskCap / 5);
  const idealStopPoints = roundToTick(clamp((context.atr || 6) * 0.8, 4, 12));
  let action = "WAIT";

  if (rawScore >= 2.5) action = "LONG";
  if (rawScore <= -2.5) action = "SHORT";

  if (context.session.id === "closed") {
    action = "WAIT";
    warnings.push("Futures are closed; wait for Globex reopen or RTH.");
  }

  if (context.freshness.status === "stale") {
    action = "WAIT";
  }

  if (macro.binaryEventRisk) {
    action = "WAIT";
  }

  if (action !== "WAIT" && idealStopPoints > maxStopPoints) {
    action = "WAIT";
    warnings.push(`Volatility implies a ${idealStopPoints} pt stop, above the ${maxStopPoints} pt paper-risk cap.`);
  }

  const referenceAction = action === "WAIT"
    ? rawScore > 0.75 ? "LONG" : rawScore < -0.75 ? "SHORT" : "WAIT"
    : action;

  const scorecard = components.map((item) => ({
    label: item.label,
    rating: item.label === "News/Macro" ? macro.sentiment : rateComponent(item.direction, referenceAction),
    bias: item.direction.toUpperCase(),
    reason: item.reason
  }));

  const confidence = confidenceFor(action, rawScore, warnings);
  const entryPlan = buildEntryPlan(action, context.price, idealStopPoints, maxStopPoints);
  const reasoning = buildReasoning(action, rawScore, indicators, macro, warnings);

  return {
    action,
    confidence,
    maxRiskDollars: riskCap,
    maxStopPoints,
    entryPlan,
    scorecard,
    reasoning,
    warnings,
    exitTriggers: buildExitTriggers(action, entryPlan),
    riskRules: [
      `Max risk per trade: 2% of paper account, capped at $${roundDollars(riskCap)} MES risk.`,
      "Position size: 1 MES contract until the paper strategy is consistently profitable.",
      "Max trades per day: 3. If 2 consecutive losers occur, stop for the session.",
      "Do not hold through CPI, FOMC, NFP, PCE, or other binary macro releases."
    ]
  };
}

function buildEntryPlan(action, price, idealStopPoints, maxStopPoints) {
  if (action === "WAIT") {
    return {
      entry: null,
      stop: null,
      target1: null,
      target2: null,
      riskReward: null,
      note: "No trade. Wait for at least three framework checks to align with fresh data and acceptable stop distance."
    };
  }

  const stopDistance = roundToTick(Math.min(idealStopPoints, maxStopPoints));
  const entry = roundToTick(price);
  const direction = action === "LONG" ? 1 : -1;
  const stop = roundToTick(entry - direction * stopDistance);
  const target1 = roundToTick(entry + direction * stopDistance * 1.5);
  const target2 = roundToTick(entry + direction * stopDistance * 2.5);

  return {
    entry,
    stop,
    target1,
    target2,
    riskPoints: stopDistance,
    target1Points: roundPrice(Math.abs(target1 - entry)),
    target2Points: roundPrice(Math.abs(target2 - entry)),
    riskMesDollars: roundDollars(stopDistance * 5),
    riskEsDollars: roundDollars(stopDistance * 50),
    target1MesDollars: roundDollars(Math.abs(target1 - entry) * 5),
    target1EsDollars: roundDollars(Math.abs(target1 - entry) * 50),
    target2MesDollars: roundDollars(Math.abs(target2 - entry) * 5),
    target2EsDollars: roundDollars(Math.abs(target2 - entry) * 50),
    riskReward: `1:${roundPrice(Math.abs(target2 - entry) / stopDistance)}`,
    note: "Paper setup only. Do not chase; invalidate if price hits the stop before entry."
  };
}

function buildReasoning(action, rawScore, indicators, macro, warnings) {
  if (action === "WAIT") {
    const warning = warnings[0] ? ` ${warnings[0]}` : "";
    return `Framework score is ${roundPrice(rawScore)}, which is not clean enough after risk/session filters. MACD is ${indicators.macd.direction}, RSI/VWAP is ${indicators.rsiVwap.direction}, and macro is ${macro.sentiment.toLowerCase()}.${warning}`;
  }

  const side = action === "LONG" ? "bullish" : "bearish";
  return `Framework score is ${roundPrice(rawScore)} with a ${side} bias. The trade is only valid while momentum, VWAP position, and macro context remain aligned; otherwise the correct paper-trading action is WAIT.`;
}

function buildExitTriggers(action, entryPlan) {
  if (action === "WAIT") {
    return [
      "Check back after the next 5-minute candle closes with fresh data.",
      "Only consider a paper trade after MACD, RSI/VWAP, and local pattern align.",
      "Stay flat ahead of binary macro events or if the required MES risk exceeds the account cap."
    ];
  }

  const long = action === "LONG";
  return [
    `Take partial profit at T1 (${formatPrice(entryPlan.target1)}) or if momentum starts contracting hard.`,
    `Hold runner toward T2 (${formatPrice(entryPlan.target2)}) only while price stays ${long ? "above" : "below"} VWAP.`,
    `Stop out at ${formatPrice(entryPlan.stop)} with no averaging down.`,
    "Exit by 3:45pm ET before the futures close window unless this is explicitly paper-tested for ETH."
  ];
}

function confidenceFor(action, rawScore, warnings) {
  if (action === "WAIT") return Math.abs(rawScore) >= 2 ? "MEDIUM" : "LOW";
  if (warnings.length >= 2) return "LOW";
  if (Math.abs(rawScore) >= 4) return "HIGH";
  if (Math.abs(rawScore) >= 3) return "MEDIUM";
  return "LOW";
}

function buildChartPayload(context) {
  return {
    candles: context.candles.slice(-160).map((candle) => ({
      time: candle.time,
      close: roundPrice(candle.close),
      high: roundPrice(candle.high),
      low: roundPrice(candle.low),
      volume: candle.volume
    })),
    levels: {
      vwap: roundNullable(context.keyLevels.vwap),
      priorDayHigh: roundNullable(context.keyLevels.priorDayHigh),
      priorDayLow: roundNullable(context.keyLevels.priorDayLow)
    }
  };
}

function getTradingSession(date) {
  const et = getEtParts(date);
  const weekday = weekdayIndexFromDateKey(et.dateKey);

  if (weekday === 6 || (weekday === 0 && et.minutes < 1080) || (weekday === 5 && et.minutes >= 1020)) {
    return {
      id: "closed",
      label: "Closed",
      quality: "closed",
      note: "Weekly futures session is closed."
    };
  }

  if (et.minutes >= 1020 && et.minutes < 1080) {
    return {
      id: "closed",
      label: "Closed",
      quality: "closed",
      note: "Daily 5:00pm-6:00pm ET maintenance break."
    };
  }

  if (weekday >= 1 && weekday <= 5 && et.minutes >= 570 && et.minutes < 960) {
    return {
      id: "rth",
      label: "RTH",
      quality: "best",
      note: "Regular Trading Hours: best liquidity and tightest spreads."
    };
  }

  if (et.minutes >= 360 && et.minutes < 570) {
    return {
      id: "premarket",
      label: "Pre-Market",
      quality: "medium",
      note: "Liquidity is improving, but spreads can still be wider than RTH."
    };
  }

  if (et.minutes < 360) {
    return {
      id: "eth-europe",
      label: "ETH-Europe",
      quality: "thin",
      note: "Europe/overnight trade can move on macro headlines with thinner liquidity."
    };
  }

  if (et.minutes >= 1080) {
    return {
      id: "eth-asia",
      label: "ETH-Asia",
      quality: "thin",
      note: "Globex evening trade is usually thin; paper trade smaller and be selective."
    };
  }

  return {
    id: "eth-globex",
    label: "ETH-Globex",
    quality: "thin",
    note: "Extended-hours trade has wider spreads and lower volume than RTH."
  };
}

function getTargetRthDateKey(date) {
  const et = getEtParts(date);
  const weekday = weekdayIndexFromDateKey(et.dateKey);

  if (et.minutes >= 1080 || weekday === 0 || weekday === 6) {
    return nextBusinessDateKey(et.dateKey);
  }

  return et.dateKey;
}

function getEtParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour,
    minute,
    minutes: hour * 60 + minute
  };
}

function formatEtDateTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function isRthCandle(candle, dateKey) {
  return candle.et.dateKey === dateKey && candle.et.minutes >= 570 && candle.et.minutes < 960;
}

function previousBusinessDateKey(dateKey) {
  let candidate = previousCalendarDateKey(dateKey);
  while (![1, 2, 3, 4, 5].includes(weekdayIndexFromDateKey(candidate))) {
    candidate = previousCalendarDateKey(candidate);
  }
  return candidate;
}

function nextBusinessDateKey(dateKey) {
  let candidate = nextCalendarDateKey(dateKey);
  while (![1, 2, 3, 4, 5].includes(weekdayIndexFromDateKey(candidate))) {
    candidate = nextCalendarDateKey(candidate);
  }
  return candidate;
}

function previousCalendarDateKey(dateKey) {
  return addDaysToDateKey(dateKey, -1);
}

function nextCalendarDateKey(dateKey) {
  return addDaysToDateKey(dateKey, 1);
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function weekdayIndexFromDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function rangeFromCandles(candles) {
  if (!candles.length) return { high: null, low: null };
  return {
    high: Math.max(...candles.map((candle) => candle.high).filter(Number.isFinite)),
    low: Math.min(...candles.map((candle) => candle.low).filter(Number.isFinite))
  };
}

function readVolume(candles) {
  const volumes = candles.map((candle) => candle.volume).filter((volume) => volume > 0);
  if (volumes.length < 40) {
    return {
      status: "unknown",
      ratio: null,
      note: "Volume was sparse or unavailable from the source."
    };
  }

  const recent = average(volumes.slice(-20));
  const baseline = average(volumes.slice(-120, -20));
  const ratio = baseline > 0 ? recent / baseline : null;
  const status = ratio == null ? "unknown" : ratio >= 1.2 ? "above normal" : ratio <= 0.8 ? "below normal" : "normal";

  return {
    status,
    ratio: roundPrice(ratio),
    note: ratio == null ? "Not enough baseline volume." : `Recent 5m volume is ${roundPrice(ratio)}x its local baseline.`
  };
}

function computeVwap(candles) {
  let priceVolume = 0;
  let volume = 0;

  for (const candle of candles) {
    if (candle.volume > 0 && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close)) {
      const typical = (candle.high + candle.low + candle.close) / 3;
      priceVolume += typical * candle.volume;
      volume += candle.volume;
    }
  }

  return volume > 0 ? priceVolume / volume : null;
}

function computeMacd(values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const line = values.map((_, index) => (
    Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : null
  ));
  const signal = emaSeries(line, 9);
  const histogram = line.map((value, index) => (
    Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null
  ));

  return { line, signal, histogram };
}

function computeRsi(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gain = 0;
  let loss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  output[period] = rsiFromAverages(avgGain, avgLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = rsiFromAverages(avgGain, avgLoss);
  }

  return output;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trueRanges = [];

  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return average(trueRanges.slice(-period));
}

function emaSeries(values, period) {
  const output = Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  const seed = [];
  let ema = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;

    if (ema == null) {
      seed.push(value);
      if (seed.length === period) {
        ema = average(seed);
        output[index] = ema;
      }
      continue;
    }

    ema = (value - ema) * multiplier + ema;
    output[index] = ema;
  }

  return output;
}

function resampleCandles(candles, minutes) {
  const bucketMs = minutes * 60 * 1000;
  const buckets = new Map();

  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketTime);

    if (!bucket) {
      buckets.set(bucketTime, { ...candle, time: bucketTime });
      continue;
    }

    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    bucket.close = candle.close;
    bucket.volume += candle.volume;
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function barsSinceMacdCross(line, signal, latestIndex) {
  let previousSign = Math.sign((line[latestIndex] ?? 0) - (signal[latestIndex] ?? 0));

  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    if (!Number.isFinite(line[index]) || !Number.isFinite(signal[index])) continue;
    const sign = Math.sign(line[index] - signal[index]);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) {
      return latestIndex - index;
    }
    if (sign !== 0) previousSign = sign;
  }

  return null;
}

function rateComponent(direction, action) {
  if (action === "WAIT" || direction === "neutral") return "NEUTRAL";
  if (action === "LONG" && direction === "bullish") return "PASS";
  if (action === "SHORT" && direction === "bearish") return "PASS";
  return "FAIL";
}

function parseRssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    return {
      title: decodeXml(extractXmlTag(block, "title")),
      link: decodeXml(extractXmlTag(block, "link")),
      pubDate: decodeXml(extractXmlTag(block, "pubDate"))
    };
  }).filter((item) => item.title);
}

function extractXmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeXml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function scoreDirection(direction) {
  if (direction === "bullish") return 1;
  if (direction === "bearish") return -1;
  return 0;
}

function percentChange(previous, current) {
  return Number.isFinite(previous) && previous !== 0 && Number.isFinite(current)
    ? ((current - previous) / Math.abs(previous)) * 100
    : null;
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function describeInstrument(symbol) {
  const profiles = {
    "ES=F": { label: "MES/ES", priceLabel: "MES Price", root: "ES" },
    "MES=F": { label: "MES/ES", priceLabel: "MES Price", root: "MES" },
    "NQ=F": { label: "MNQ/NQ", priceLabel: "MNQ Price", root: "NQ" }
  };

  return profiles[symbol] || { label: symbol, priceLabel: `${symbol} Price`, root: symbol.replace(/=F$/, "") };
}

function sanitizeSymbol(symbol) {
  const normalized = String(symbol || DEFAULT_SYMBOL).trim().toUpperCase();
  return /^[A-Z0-9=.^-]{1,20}$/.test(normalized) ? normalized : DEFAULT_SYMBOL;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundToTick(value, tick = 0.25) {
  return Number.isFinite(value) ? Math.round(value / tick) * tick : null;
}

function roundPrice(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function roundNullable(value) {
  return Number.isFinite(value) ? roundPrice(value) : null;
}

function roundDollars(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function formatPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, message) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(message);
}


export {
  buildAnalysis,
  computeMacd,
  computeRsi,
  createDashboardServer,
  getTradingSession,
  isPlausibleCandle,
  describeInstrument,
  roundToTick,
  sanitizeSymbol
};
