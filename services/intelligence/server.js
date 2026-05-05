const express = require("express");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4008;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const EV_THRESHOLD = Number.parseFloat(process.env.EV_THRESHOLD || "2.5");

const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let connected = false;
let lastSignal = null;
let activeRegime = "mean_revert";

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function regimeAdjustment(regime) {
  if (regime === "trend") return 0.22;
  if (regime === "mean_revert") return -0.14;
  if (regime === "volatile") return -0.2;
  return -0.05;
}

function actionFromScore(score, confidence) {
  if (confidence < 0.4) return "HOLD";
  if (score > 0.35 && confidence > 0.8) return "SCALE_UP";
  if (score < -0.35 && confidence > 0.8) return "SCALE_DOWN";
  if (score > 0.05) return "LONG";
  if (score < -0.05) return "SHORT";
  return "HOLD";
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

async function generateSignal(feature) {
  const momentum = Number(feature.momentum || 0);
  const imbalance = Number(feature.imbalance || 0);
  const volatility = Number(feature.volatility || 0);
  const liquidity = Number(feature.liquidity_thickness || 0.5);

  const statisticalModel = Math.tanh(momentum * 220 + imbalance * 1.4 - volatility * 16);
  const rlPolicy = Math.tanh(imbalance * 1.8 + momentum * 180 + (liquidity - 0.5) * 1.2);
  const regimeAdj = regimeAdjustment(activeRegime);

  const finalSignal = 0.4 * statisticalModel + 0.4 * rlPolicy + 0.2 * regimeAdj;
  const probability = sigmoid(finalSignal * 4);
  const confidence = Math.abs(probability - 0.5) * 2;

  const kalshiYesCost = 50 + Math.max(-20, Math.min(20, momentum * 10000));
  const expectedValue = probability * 100 - kalshiYesCost;
  const decisionEligible = expectedValue > EV_THRESHOLD && confidence > 0.65;
  const action = decisionEligible ? actionFromScore(finalSignal, confidence) : "HOLD";

  const signalId = crypto.randomUUID();
  const payload = {
    signal_id: signalId,
    symbol: "BTC-USD",
    expiry: "15m",
    ts: feature.ts || new Date().toISOString(),
    regime: activeRegime,
    model_scores: {
      statistical_model: statisticalModel,
      rl_policy: rlPolicy,
      regime_adjustment: regimeAdj,
    },
    baseline: {
      random_model: 0.5,
      naive_momentum: sigmoid(momentum * 200),
    },
    final_signal: finalSignal,
    probability,
    confidence,
    kalshi_yes_cost: kalshiYesCost,
    expected_value: expectedValue,
    action,
    no_trade: !decisionEligible,
  };

  lastSignal = payload;
  await publish("signal_generated", payload);

  if (decisionEligible && action !== "HOLD") {
    await publish("trade_decision", {
      decision_id: crypto.randomUUID(),
      signal_id: signalId,
      symbol: "BTC-USD",
      expiry: "15m",
      action,
      probability,
      confidence,
      expected_value: expectedValue,
      cost: kalshiYesCost,
      regime: activeRegime,
      ts: payload.ts,
    });
  }
}

async function start() {
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type === "regime_shift") {
        activeRegime = evt.payload?.regime || activeRegime;
        return;
      }
      if (evt.event_type === "microstructure_update") {
        await generateSignal(evt.payload || {});
      }
    } catch (_error) {
      // ignore malformed event
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "intelligence", connected, regime: activeRegime });
});

app.get("/latest", (_req, res) => {
  res.json({ ok: true, signal: lastSignal });
});

start()
  .catch((error) => {
    console.error("intelligence startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`intelligence service listening on ${PORT}`);
    });
  });
