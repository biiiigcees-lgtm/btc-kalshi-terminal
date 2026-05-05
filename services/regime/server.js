const express = require("express");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4007;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";

const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let connected = false;
let lastRegime = null;

function nextRegime(feature) {
  if (feature.volatility_state === "SPIKE") return "volatile";
  if (Math.abs(Number(feature.momentum || 0)) > 0.0018) return "trend";
  if (Number(feature.liquidity_thickness || 0) < 0.3) return "fragile";
  return "mean_revert";
}

async function publish(eventType, payload) {
  const event = {
    id: crypto.randomUUID(),
    event_type: eventType,
    ts: new Date().toISOString(),
    payload,
  };
  await pub.publish(EVENT_CHANNEL, JSON.stringify(event));
}

async function start() {
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type !== "microstructure_update") return;

      const feature = evt.payload || {};
      const regime = nextRegime(feature);
      if (regime === lastRegime) return;

      lastRegime = regime;
      await publish("regime_shift", {
        symbol: "BTC-USD",
        expiry: "15m",
        regime,
        confidence: regime === "trend" || regime === "mean_revert" ? 0.7 : 0.82,
        ts: feature.ts || new Date().toISOString(),
      });
    } catch (_error) {
      // malformed event ignored
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "regime", connected, regime: lastRegime });
});

start()
  .catch((error) => {
    console.error("regime startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`regime service listening on ${PORT}`);
    });
  });
