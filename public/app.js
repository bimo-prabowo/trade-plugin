import { buildSignalNotification, shouldNotifySignalChange } from "./alerts.js";

const els = {
  controls: document.querySelector("#controls"),
  symbol: document.querySelector("#symbol"),
  account: document.querySelector("#account"),
  interval: document.querySelector("#interval"),
  autoRefresh: document.querySelector("#autoRefresh"),
  alertsEnabled: document.querySelector("#alertsEnabled"),
  testAlert: document.querySelector("#testAlert"),
  statusStrip: document.querySelector("#statusStrip"),
  confidence: document.querySelector("#confidence"),
  signalLabel: document.querySelector("#signalLabel"),
  action: document.querySelector("#action"),
  priceLabel: document.querySelector("#priceLabel"),
  price: document.querySelector("#price"),
  session: document.querySelector("#session"),
  volume: document.querySelector("#volume"),
  gap: document.querySelector("#gap"),
  sessionNote: document.querySelector("#sessionNote"),
  freshness: document.querySelector("#freshness"),
  chart: document.querySelector("#priceChart"),
  entryPlan: document.querySelector("#entryPlan"),
  keyLevels: document.querySelector("#keyLevels"),
  scorecard: document.querySelector("#scorecard"),
  reasoning: document.querySelector("#reasoning"),
  exitTriggers: document.querySelector("#exitTriggers"),
  riskRules: document.querySelector("#riskRules"),
  newsSentiment: document.querySelector("#newsSentiment"),
  newsHeadline: document.querySelector("#newsHeadline"),
  newsExplanation: document.querySelector("#newsExplanation"),
  headlineList: document.querySelector("#headlineList"),
  warnings: document.querySelector("#warnings"),
  sources: document.querySelector("#sources"),
  disclaimer: document.querySelector("#disclaimer")
};

const ALERTS_STORAGE_KEY = "signalDeckAlertsEnabled";

let refreshTimer = null;
let latestAnalysis = null;
let previousAction = null;
let previousSymbol = null;

els.controls.addEventListener("submit", (event) => {
  event.preventDefault();
  loadAnalysis();
});

els.autoRefresh.addEventListener("change", scheduleRefresh);
els.interval.addEventListener("change", scheduleRefresh);
els.symbol.addEventListener("change", resetSignalMemory);
els.account.addEventListener("change", resetSignalMemory);
els.alertsEnabled.addEventListener("change", handleAlertsToggle);
els.testAlert.addEventListener("click", testAlertSound);
window.addEventListener("resize", () => {
  if (latestAnalysis) drawChart(latestAnalysis.chart);
});

initializeAlerts();
loadAnalysis();
scheduleRefresh();

async function loadAnalysis() {
  setStatus("loading", "Loading live analysis...");

  try {
    const params = new URLSearchParams({
      symbol: els.symbol.value,
      account: els.account.value
    });
    const response = await fetch(`/api/analyze?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || "Analysis API failed.");
    }

    const lastAction = previousSymbol === payload.symbol ? previousAction : null;
    latestAnalysis = payload;
    render(payload);
    maybeNotifySignalChange(lastAction, payload);
    previousAction = payload.action || "WAIT";
    previousSymbol = payload.symbol || els.symbol.value;
    setStatus("ok", `Updated ${formatTime(payload.generatedAt)} from ${payload.source.name}.`);
  } catch (error) {
    setStatus("error", error.message || "Unable to load analysis.");
    renderError(error);
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!els.autoRefresh.checked) return;
  refreshTimer = setInterval(loadAnalysis, Number(els.interval.value));
}

function initializeAlerts() {
  if (!supportsNotifications()) {
    els.alertsEnabled.checked = false;
    els.alertsEnabled.disabled = true;
    els.alertsEnabled.closest("label").title = "Browser notifications are not supported here";
    return;
  }

  els.alertsEnabled.checked = localStorage.getItem(ALERTS_STORAGE_KEY) === "true" && Notification.permission === "granted";
}

async function handleAlertsToggle() {
  if (!els.alertsEnabled.checked) {
    localStorage.setItem(ALERTS_STORAGE_KEY, "false");
    setStatus("ok", "Signal alerts disabled.");
    return;
  }

  const granted = await requestNotificationPermission();
  els.alertsEnabled.checked = granted;
  localStorage.setItem(ALERTS_STORAGE_KEY, granted ? "true" : "false");
  setStatus(granted ? "ok" : "error", granted ? "Signal alerts enabled for WAIT to LONG/SHORT changes." : "Browser notification permission was not granted.");
}

function resetSignalMemory() {
  previousAction = null;
  previousSymbol = null;
}

async function testAlertSound() {
  playAlertTone();

  if (supportsNotifications() && Notification.permission !== "denied") {
    const granted = await requestNotificationPermission();
    if (granted) {
      const notification = buildSignalNotification(latestAnalysis || {
        action: "LONG",
        instrument: { label: "Signal Deck" },
        price: null,
        session: { label: "Test" },
        confidence: "TEST"
      });
      new Notification(`Test ${notification.title}`, {
        body: notification.body,
        tag: "signal-deck-test"
      });
    }
  }

  setStatus("ok", "Played test alert tone.");
}

function maybeNotifySignalChange(lastAction, analysis) {
  if (!alertsAreActive()) return;
  if (!shouldNotifySignalChange(lastAction, analysis.action)) return;

  const notification = buildSignalNotification(analysis);
  new Notification(notification.title, {
    body: notification.body,
    tag: `signal-deck-${analysis.symbol || "signal"}`,
    requireInteraction: true
  });
  playAlertTone();
}

function alertsAreActive() {
  return supportsNotifications() && els.alertsEnabled.checked && Notification.permission === "granted";
}

function supportsNotifications() {
  return "Notification" in window;
}

async function requestNotificationPermission() {
  if (!supportsNotifications()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return await Notification.requestPermission() === "granted";
}

function playAlertTone() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.45);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.48);
  } catch {
    // Notification is the primary alert; audio is only a best-effort cue.
  }
}

function render(data) {
  const action = (data.action || "WAIT").toLowerCase();
  els.action.textContent = data.action || "WAIT";
  els.action.className = `action ${action}`;

  setPill(els.confidence, data.confidence || "LOW");
  els.signalLabel.textContent = `${data.instrument?.label || data.symbol || "MES/ES"} signal`;
  els.priceLabel.textContent = data.instrument?.priceLabel || `${data.symbol || "MES"} Price`;
  els.price.textContent = formatPrice(data.price);
  els.session.textContent = data.session?.label || "--";
  els.volume.textContent = data.volume?.status || "--";
  els.gap.textContent = data.gap ? `${signed(data.gap.points)} pts (${formatDollars(data.gap.mesDollars)} MES)` : "--";
  els.sessionNote.textContent = data.session?.note || "";
  els.freshness.textContent = data.freshness
    ? `${data.freshness.latestCandleEt}, ${data.freshness.minutesOld}m old`
    : "--";

  renderDefinitionList(els.entryPlan, entryPlanRows(data.entryPlan));
  renderDefinitionList(els.keyLevels, keyLevelRows(data.keyLevels));
  renderScorecard(data.scorecard || []);
  els.reasoning.textContent = data.reasoning || "";
  renderList(els.exitTriggers, data.exitTriggers || []);
  renderList(els.riskRules, data.riskRules || []);
  renderNews(data.newsImpact || {});
  renderWarnings(data.warnings || []);
  renderSources(data.sources || []);
  els.disclaimer.textContent = data.disclaimer || "";
  drawChart(data.chart);
}

function renderError(error) {
  els.action.textContent = "WAIT";
  els.action.className = "action wait";
  setPill(els.confidence, "LOW");
  els.reasoning.textContent = error.message || "The data source did not return a usable response. Stay flat.";
}

function entryPlanRows(plan = {}) {
  if (!plan.entry) {
    return [
      ["Entry", "No trade"],
      ["Stop", "--"],
      ["Target 1", "--"],
      ["Target 2", "--"],
      ["Risk/Reward", plan.note || "--"]
    ];
  }

  return [
    ["Entry", formatPrice(plan.entry)],
    ["Stop", `${formatPrice(plan.stop)} (${plan.riskPoints} pts = MES -${formatDollars(plan.riskMesDollars)} / ES -${formatDollars(plan.riskEsDollars)})`],
    ["Target 1", `${formatPrice(plan.target1)} (${plan.target1Points} pts = MES +${formatDollars(plan.target1MesDollars)} / ES +${formatDollars(plan.target1EsDollars)})`],
    ["Target 2", `${formatPrice(plan.target2)} (${plan.target2Points} pts = MES +${formatDollars(plan.target2MesDollars)} / ES +${formatDollars(plan.target2EsDollars)})`],
    ["Risk/Reward", plan.riskReward]
  ];
}

function keyLevelRows(levels = {}) {
  return [
    ["Overnight High", formatPrice(levels.overnightHigh)],
    ["Overnight Low", formatPrice(levels.overnightLow)],
    ["Prior Day High", formatPrice(levels.priorDayHigh)],
    ["Prior Day Low", formatPrice(levels.priorDayLow)],
    ["Prior Day Close", formatPrice(levels.priorDayClose)],
    ["VWAP", formatPrice(levels.vwap)]
  ];
}

function renderDefinitionList(node, rows) {
  node.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value ?? "--";
    row.append(dt, dd);
    node.append(row);
  }
}

function renderScorecard(items) {
  els.scorecard.replaceChildren();
  for (const item of items) {
    const card = document.createElement("div");
    const title = document.createElement("strong");
    const pill = document.createElement("span");
    const reason = document.createElement("p");

    card.className = "score-item";
    title.textContent = item.label;
    setPill(pill, item.rating || "NEUTRAL");
    reason.textContent = item.reason || "";
    card.append(title, pill, reason);
    els.scorecard.append(card);
  }
}

function renderNews(news) {
  setPill(els.newsSentiment, news.sentiment || "NEUTRAL");
  els.newsHeadline.textContent = news.headline || "No headline returned.";
  els.newsExplanation.textContent = news.explanation || "";
  els.headlineList.replaceChildren();

  for (const headline of news.headlines || []) {
    const anchor = document.createElement("a");
    anchor.href = headline.link || "#";
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = headline.title;
    els.headlineList.append(anchor);
  }
}

function renderWarnings(warnings) {
  els.warnings.replaceChildren();
  if (!warnings.length) {
    const clean = document.createElement("p");
    clean.className = "muted";
    clean.textContent = "No additional warnings beyond the paper-trading disclaimer.";
    els.warnings.append(clean);
    return;
  }

  for (const warning of warnings) {
    const item = document.createElement("div");
    item.className = "warning";
    item.textContent = warning;
    els.warnings.append(item);
  }
}

function renderSources(sources) {
  els.sources.replaceChildren();
  for (const source of sources) {
    const item = document.createElement("li");
    const anchor = document.createElement("a");
    anchor.href = source.url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = source.label;
    item.append(anchor);
    els.sources.append(item);
  }
}

function renderList(node, items) {
  node.replaceChildren();
  for (const value of items) {
    const item = document.createElement("li");
    item.textContent = value;
    node.append(item);
  }
}

function drawChart(chart) {
  const canvas = els.chart;
  const parentWidth = canvas.clientWidth || 800;
  const parentHeight = canvas.clientHeight || 280;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(parentWidth * ratio);
  canvas.height = Math.round(parentHeight * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, parentWidth, parentHeight);
  ctx.fillStyle = "#fbfcfa";
  ctx.fillRect(0, 0, parentWidth, parentHeight);

  const candles = (chart?.candles || []).filter(isDrawableCandle);
  if (candles.length < 2) {
    drawEmptyChart(ctx, parentWidth, parentHeight);
    return;
  }

  const padding = { top: 18, right: 58, bottom: 28, left: 14 };
  const values = candles.flatMap((candle) => [candle.high, candle.low]).filter(Number.isFinite);
  for (const level of Object.values(chart.levels || {})) {
    if (Number.isFinite(level)) values.push(level);
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const plotWidth = parentWidth - padding.left - padding.right;
  const plotHeight = parentHeight - padding.top - padding.bottom;
  const xFor = (index) => padding.left + (index / (candles.length - 1)) * plotWidth;
  const yFor = (value) => padding.top + (1 - (value - min) / span) * plotHeight;

  drawGrid(ctx, parentWidth, parentHeight, padding);
  drawLevel(ctx, chart.levels?.priorDayHigh, yFor, parentWidth, padding, "#8a6500", "PDH");
  drawLevel(ctx, chart.levels?.priorDayLow, yFor, parentWidth, padding, "#8a6500", "PDL");
  drawLevel(ctx, chart.levels?.vwap, yFor, parentWidth, padding, "#0f6f78", "VWAP");

  ctx.beginPath();
  candles.forEach((candle, index) => {
    const x = xFor(index);
    const y = yFor(candle.close);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#171918";
  ctx.lineWidth = 2.2;
  ctx.stroke();

  const latest = candles.at(-1).close;
  const latestY = yFor(latest);
  ctx.fillStyle = "#171918";
  ctx.beginPath();
  ctx.arc(xFor(candles.length - 1), latestY, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#667069";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(formatPrice(max), parentWidth - 8, padding.top + 4);
  ctx.fillText(formatPrice(min), parentWidth - 8, parentHeight - padding.bottom);
  ctx.fillStyle = "#171918";
  ctx.fillText(formatPrice(latest), parentWidth - 8, latestY + 4);
}

function drawGrid(ctx, width, height, padding) {
  ctx.strokeStyle = "#e4e8e1";
  ctx.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + ((height - padding.top - padding.bottom) / 4) * index;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }
}

function drawLevel(ctx, value, yFor, width, padding, color, label) {
  if (!Number.isFinite(value)) return;
  const y = yFor(value);
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(padding.left, y);
  ctx.lineTo(width - padding.right, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(label, width - 8, y - 4);
  ctx.restore();
}


function isDrawableCandle(candle) {
  return [candle.close, candle.high, candle.low].every((value) => Number.isFinite(value) && value > 0)
    && candle.high >= candle.low
    && Math.abs(candle.high - candle.close) <= Math.max(candle.close * 0.08, 200)
    && Math.abs(candle.low - candle.close) <= Math.max(candle.close * 0.08, 200);
}

function drawEmptyChart(ctx, width, height) {
  ctx.fillStyle = "#667069";
  ctx.font = "14px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("No chart candles returned", width / 2, height / 2);
}

function setStatus(kind, message) {
  const dot = els.statusStrip.querySelector(".dot");
  dot.className = `dot ${kind}`;
  els.statusStrip.querySelector("span:last-child").textContent = message;
}

function setPill(node, value) {
  const normalized = String(value || "NEUTRAL").toLowerCase();
  node.textContent = value || "NEUTRAL";
  node.className = `pill ${normalized}`;
}

function formatPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function formatDollars(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "$--";
}

function signed(value) {
  if (!Number.isFinite(value)) return "--";
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
