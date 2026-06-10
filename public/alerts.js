export function normalizeSignalAction(action) {
  const normalized = String(action || "").trim().toUpperCase();
  return ["WAIT", "LONG", "SHORT"].includes(normalized) ? normalized : "WAIT";
}

export function shouldNotifySignalChange(previousAction, nextAction) {
  if (previousAction == null) return false;

  const previous = normalizeSignalAction(previousAction);
  const next = normalizeSignalAction(nextAction);
  return previous === "WAIT" && (next === "LONG" || next === "SHORT");
}

export function buildSignalNotification(analysis = {}) {
  const action = normalizeSignalAction(analysis.action);
  const label = analysis.instrument?.label || analysis.symbol || "Signal Deck";
  const price = Number.isFinite(analysis.price) ? analysis.price.toFixed(2) : "n/a";
  const session = analysis.session?.label || "unknown session";
  const confidence = analysis.confidence || "unknown confidence";

  return {
    title: `${label}: ${action}`,
    body: `Price ${price} | ${session} | ${confidence} confidence`
  };
}
