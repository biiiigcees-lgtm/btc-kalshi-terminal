const express = require("express");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4007;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const REGIME_COOLDOWN_MS = Number.parseInt(process.env.REGIME_COOLDOWN_MS || "5000", 10);

const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let connected = false;
let lastRegime = null;
let lastPolicy = null;
let lastPublishedAt = 0;

function classifyRegime(feature) {
  const momentum = Math.abs(Number(feature.momentum || 0));
  const volatility = Number(feature.volatility || 0);
  const volatilityState = String(feature.volatility_state || "NORMAL");
  const liquidity = Number(feature.liquidity_thickness || 0.5);
  const spreadBps = Number(feature.spread_bps || 4);

  if (volatilityState === "SPIKE" || volatility > 0.0035) {
    return {
      regime: "news_spike_volatility_shock",
      confidence: 0.9,
      policy: "defensive",
      allow_trade: false,
    };
  }

  if (liquidity < 0.22 || spreadBps > 15) {
    return {
      regime: "liquidity_vacuum",
      confidence: 0.85,
      policy: "standby",
      allow_trade: false,
    };
  }

  if (momentum > 0.0018 && volatility > 0.0012) {
    return {
      regime: "trend_breakout",
      confidence: 0.78,
      policy: "trend_follow",
      allow_trade: true,
    };
  }

  if (volatility < 0.0007 && momentum < 0.0004) {
    return {
      regime: "low_volatility_chop",
      confidence: 0.74,
      policy: "avoid_noise",
      allow_trade: false,
    };
  }

  return {
    regime: "mean_reversion",
    confidence: 0.72,
    policy: "mean_revert",
    allow_trade: true,
  };
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
      const classification = classifyRegime(feature);
      const now = Date.now();
      const changed = classification.regime !== lastRegime || classification.policy !== lastPolicy;
      if (!changed && now - lastPublishedAt < REGIME_COOLDOWN_MS) {
        return;
      }

      lastRegime = classification.regime;
      lastPolicy = classification.policy;
      lastPublishedAt = now;

      await publish("regime_shift", {
        symbol: "BTC-USD",
        expiry: "15m",
        regime: classification.regime,
        confidence: classification.confidence,
        policy: classification.policy,
        allow_trade: classification.allow_trade,
        ts: feature.ts || new Date().toISOString(),
      });
    } catch (_error) {
      // malformed event ignored
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "regime",
    connected,
    regime: lastRegime,
    policy: lastPolicy,
  });
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
