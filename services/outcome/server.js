const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4011;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const OUTCOME_DELAY_MS = Number.parseInt(process.env.OUTCOME_DELAY_MS || "900000", 10);

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let latestTick = null;
let resolvedCount = 0;

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

async function resolveTrade(fill) {
  if (!pool || !dbReady) return;

  const nowPrice = Number(latestTick?.price || 0);
  const entryPrice = Number(fill.entry_price || fill.feature_snapshot?.price || nowPrice || 0);
  const simulatedMove = (nowPrice || entryPrice) - entryPrice;
  const bullishCall = fill.action === "LONG" || fill.action === "SCALE_UP";
  const bearishCall = fill.action === "SHORT" || fill.action === "SCALE_DOWN";
  const outcome = bullishCall ? simulatedMove >= 0 : bearishCall ? simulatedMove <= 0 : false;

  const payout = outcome ? 100 : 0;
  await pool.query(`UPDATE paper_trades SET outcome = $1, payout = $2 WHERE id = $3;`, [outcome, payout, fill.trade_id]);

  const tradeCost = Number(fill.fill_price || fill.adjusted_cost || fill.cost || 0);
  const pnl = outcome ? payout - tradeCost : -tradeCost;
  resolvedCount += 1;

  await publish("trade_resolved", {
    trade_id: fill.trade_id,
    signal_id: fill.signal_id,
    decision_id: fill.decision_id,
    probability: Number(fill.probability || 0.5),
    raw_probability: Number(fill.raw_probability || fill.probability || 0.5),
    calibrated_probability: Number(fill.calibrated_probability || fill.probability || 0.5),
    outcome,
    pnl,
    cost: Number(fill.cost || 0),
    adjusted_cost: Number(fill.adjusted_cost || fill.cost || 0),
    fill_price: Number(fill.fill_price || fill.cost || 0),
    regime: fill.regime || "unknown",
    action: fill.action || "HOLD",
    baseline: fill.baseline || {},
    model_scores: fill.model_scores || {},
    weights: fill.weights || {},
    latency_ms: Number(fill.latency_ms || 0),
    slippage_bps: Number(fill.slippage_bps || 0),
    spread_widening_bps: Number(fill.spread_widening_bps || 0),
    liquidity_impact_bps: Number(fill.liquidity_impact_bps || 0),
    resolved_at: new Date().toISOString(),
  });
}

async function start() {
  await initDb();
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type === "tick_received") {
        latestTick = evt.payload || latestTick;
        return;
      }
      if (evt.event_type === "execution_fill") {
        const fill = evt.payload || {};
        setTimeout(() => {
          resolveTrade(fill).catch((error) => {
            console.error("resolve trade failed:", error.message);
          });
        }, OUTCOME_DELAY_MS);
      }
    } catch (_error) {
      // ignore malformed event
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "outcome", connected, dbReady, outcomeDelayMs: OUTCOME_DELAY_MS, resolvedCount });
});

start()
  .catch((error) => {
    console.error("outcome startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`outcome service listening on ${PORT}`);
    });
  });
