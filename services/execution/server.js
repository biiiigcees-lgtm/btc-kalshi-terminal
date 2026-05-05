const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4010;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const EXECUTION_MODE = process.env.EXECUTION_MODE || "paper";
const FILL_DELAY_MIN_MS = Number.parseInt(process.env.FILL_DELAY_MIN_MS || "1000", 10);
const FILL_DELAY_MAX_MS = Number.parseInt(process.env.FILL_DELAY_MAX_MS || "3000", 10);
const BASE_SLIPPAGE_BPS = Number.parseFloat(process.env.BASE_SLIPPAGE_BPS || "2");
const LIQUIDITY_IMPACT_BPS = Number.parseFloat(process.env.LIQUIDITY_IMPACT_BPS || "20");
const SPREAD_WIDENING_MULTIPLIER = Number.parseFloat(process.env.SPREAD_WIDENING_MULTIPLIER || "0.4");

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let recentFills = [];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function buildExecutionSimulation(decision) {
  const feature = decision.feature_snapshot || {};
  const volatility = Number(feature.volatility || 0);
  const liquidity = Number(feature.liquidity_thickness || 0.5);
  const spreadBps = Number(feature.spread_bps || 4);

  const delayBase = randomBetween(FILL_DELAY_MIN_MS, FILL_DELAY_MAX_MS);
  const delayVolatilityPenalty = clamp(volatility * 200000, 0, 800);
  const delayMs = Math.round(delayBase + delayVolatilityPenalty);

  const spreadWideningBps = spreadBps * SPREAD_WIDENING_MULTIPLIER;
  const liquidityImpactBps = (1 - clamp(liquidity, 0, 1)) * LIQUIDITY_IMPACT_BPS;
  const randomSlippageBps = randomBetween(0, BASE_SLIPPAGE_BPS);
  const totalSlippageBps = spreadWideningBps + liquidityImpactBps + randomSlippageBps;

  return {
    delayMs,
    spreadWideningBps,
    liquidityImpactBps,
    randomSlippageBps,
    totalSlippageBps,
  };
}

async function initDb() {
  if (!pool) return;
  await pool.query("SELECT 1;");
  dbReady = true;
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

async function executeDecision(decision) {
  if (!pool || !dbReady || EXECUTION_MODE !== "paper") {
    return;
  }

  const expiresAtMs = Date.parse(decision.expires_at || "");
  if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
    await publish("execution_skipped", {
      decision_id: decision.decision_id,
      signal_id: decision.signal_id,
      reason: "signal expired before execution",
      ts: new Date().toISOString(),
    });
    return;
  }

  const simulation = buildExecutionSimulation(decision);
  setTimeout(async () => {
    try {
      if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
        await publish("execution_skipped", {
          decision_id: decision.decision_id,
          signal_id: decision.signal_id,
          reason: "signal expired during latency window",
          ts: new Date().toISOString(),
        });
        return;
      }

      const probability = Number(decision.probability || 0.5);
      const cost = Number(decision.cost || 50);
      const adjustedCost = Number(decision.adjusted_cost || cost);
      const size = Math.max(0.1, Number(decision.size_multiplier || 1));
      const fillPrice = clamp(adjustedCost * (1 + simulation.totalSlippageBps / 10000), 1, 99);
      const entryPrice = fillPrice;
      const expectedValue = probability * 100 - fillPrice;

      const write = await pool.query(
        `
          INSERT INTO paper_trades (
            signal_id,
            decision_id,
            action,
            mode,
            regime,
            size,
            entry_price,
            probability,
            cost,
            outcome,
            payout,
            expected_value,
            feature_snapshot,
            model_scores,
            weights,
            resolved
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 0, $10, $11, $12, $13, FALSE)
          RETURNING id, created_at;
        `,
        [
          decision.signal_id || null,
          decision.decision_id || null,
          decision.action || "HOLD",
          decision.mode || EXECUTION_MODE,
          decision.regime || "unknown",
          size,
          entryPrice,
          probability,
          fillPrice,
          expectedValue,
          JSON.stringify(decision.feature_snapshot || {}),
          JSON.stringify(decision.model_scores || {}),
          JSON.stringify(decision.weights || {}),
        ]
      );

      const tradeId = write.rows[0]?.id;
      const fill = {
        trade_id: tradeId,
        signal_id: decision.signal_id,
        decision_id: decision.decision_id,
        symbol: decision.symbol,
        expiry: decision.expiry,
        action: decision.action,
        mode: decision.mode || EXECUTION_MODE,
        regime: decision.regime,
        size,
        probability,
        raw_probability: Number(decision.raw_probability || probability),
        calibrated_probability: probability,
        confidence: Number(decision.confidence || 0),
        cost,
        adjusted_cost: adjustedCost,
        entry_price: entryPrice,
        expected_value: expectedValue,
        fill_price: fillPrice,
        size_multiplier: size,
        latency_ms: simulation.delayMs,
        slippage_bps: simulation.totalSlippageBps,
        spread_widening_bps: simulation.spreadWideningBps,
        liquidity_impact_bps: simulation.liquidityImpactBps,
        feature_snapshot: decision.feature_snapshot || {},
        baseline: decision.baseline || {},
        model_scores: decision.model_scores || {},
        weights: decision.weights || {},
        ts: write.rows[0]?.created_at || new Date().toISOString(),
      };

      recentFills.unshift(fill);
      recentFills = recentFills.slice(0, 100);

      await publish("execution_fill", fill);
    } catch (error) {
      await publish("execution_error", {
        decision_id: decision.decision_id,
        signal_id: decision.signal_id,
        error: error.message,
        ts: new Date().toISOString(),
      });
    }
  }, simulation.delayMs);
}

async function start() {
  await initDb();
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type !== "risk_update") return;

      const payload = evt.payload || {};
      if (!payload.allow) return;
      await executeDecision(payload.decision || {});
    } catch (error) {
      console.error("execution event handling failed:", error.message);
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "execution", connected, dbReady, mode: EXECUTION_MODE });
});

app.get("/fills", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || "20", 10)));
  res.json({ ok: true, count: Math.min(limit, recentFills.length), rows: recentFills.slice(0, limit) });
});

start()
  .catch((error) => {
    console.error("execution startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`execution service listening on ${PORT}`);
    });
  });
