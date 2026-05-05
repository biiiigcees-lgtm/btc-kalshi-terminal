const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4011;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const OUTCOME_DELAY_MS = Number.parseInt(process.env.OUTCOME_DELAY_MS || "900000", 10);
const RESOLUTION_SCAN_MS = Number.parseInt(process.env.RESOLUTION_SCAN_MS || "60000", 10);

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let latestTick = null;
let resolvedCount = 0;

function isBullishAction(action) {
  return ["LONG", "SCALE_UP", "BUY", "BUY_UP"].includes(String(action || "").toUpperCase());
}

function isBearishAction(action) {
  return ["SHORT", "SCALE_DOWN", "SELL", "BUY_DOWN"].includes(String(action || "").toUpperCase());
}

async function computeMetricsSnapshot() {
  if (!pool || !dbReady) {
    return null;
  }

  const resolved = await pool.query(
    `
      WITH resolved_rows AS (
        SELECT
          COALESCE(resolved_at, created_at) AS ts,
          COALESCE(
            pnl,
            CASE
              WHEN outcome = TRUE THEN payout - cost
              WHEN outcome = FALSE THEN -cost
              ELSE 0
            END,
            0
          ) AS pnl
        FROM paper_trades
        WHERE resolved = TRUE OR outcome IS NOT NULL OR pnl IS NOT NULL
        ORDER BY COALESCE(resolved_at, created_at) ASC
      ),
      curve AS (
        SELECT
          ts,
          pnl,
          SUM(pnl) OVER (ORDER BY ts ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS equity
        FROM resolved_rows
      ),
      peak_curve AS (
        SELECT
          ts,
          pnl,
          equity,
          MAX(equity) OVER (ORDER BY ts ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak_equity
        FROM curve
      )
      SELECT
        COALESCE(MAX(equity), 0)::DOUBLE PRECISION AS equity,
        COALESCE(MAX(peak_equity), 0)::DOUBLE PRECISION AS peak_equity,
        COALESCE(MAX(peak_equity - equity), 0)::DOUBLE PRECISION AS drawdown,
        COALESCE(SUM(pnl), 0)::DOUBLE PRECISION AS pnl,
        COUNT(*)::INTEGER AS trade_count
      FROM peak_curve;
    `
  );

  const exposureRead = await pool.query(
    `
      SELECT COALESCE(SUM(size), 0)::DOUBLE PRECISION AS exposure
      FROM paper_trades
      WHERE resolved = FALSE OR resolved IS NULL;
    `
  );

  return {
    equity: Number(resolved.rows[0]?.equity || 0),
    peak_equity: Number(resolved.rows[0]?.peak_equity || 0),
    drawdown: Number(resolved.rows[0]?.drawdown || 0),
    pnl: Number(resolved.rows[0]?.pnl || 0),
    trade_count: Number(resolved.rows[0]?.trade_count || 0),
    exposure: Number(exposureRead.rows[0]?.exposure || 0),
  };
}

async function saveMetricsSnapshot(scope, extraPayload = {}) {
  if (!pool || !dbReady) {
    return;
  }

  const snapshot = await computeMetricsSnapshot();
  if (!snapshot) {
    return;
  }

  await pool.query(
    `
      INSERT INTO metric_snapshots (scope, equity, peak_equity, drawdown, exposure, pnl, trade_count, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb);
    `,
    [
      scope,
      snapshot.equity,
      snapshot.peak_equity,
      snapshot.drawdown,
      snapshot.exposure,
      snapshot.pnl,
      snapshot.trade_count,
      JSON.stringify({
        ...snapshot,
        ...extraPayload,
      }),
    ]
  );
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

async function resolveTrade(fill) {
  if (!pool || !dbReady) return;

  const tradeCost = Number(fill.entry_price || fill.fill_price || fill.adjusted_cost || fill.cost || 0);
  const size = Math.max(0.1, Number(fill.size_multiplier || fill.size || 1));
  const nowPrice = Number(latestTick?.price || tradeCost || 0);
  const bullishCall = isBullishAction(fill.action);
  const bearishCall = isBearishAction(fill.action);
  let outcome;
  if (bullishCall) {
    outcome = nowPrice >= tradeCost;
  } else if (bearishCall) {
    outcome = nowPrice <= tradeCost;
  } else {
    outcome = nowPrice >= tradeCost;
  }

  const exitPrice = outcome ? 100 : 0;
  const payout = outcome ? 100 * size : 0;
  const pnl = outcome ? (100 - tradeCost) * size : -tradeCost * size;
  resolvedCount += 1;

  await pool.query(
    `
      UPDATE paper_trades
      SET outcome = $1,
          payout = $2,
          exit_price = $3,
          pnl = $4,
          resolved = TRUE,
          resolved_at = NOW()
      WHERE id = $5;
    `,
    [outcome, payout, exitPrice, pnl, fill.trade_id]
  );

  const resolvedAt = new Date().toISOString();
  await pool.query(
    `
      INSERT INTO trade_outcomes (
        signal_id,
        trade_id,
        resolved_at,
        predicted_probability,
        calibrated_probability,
        outcome,
        brier,
        raw_brier,
        calibrated_brier,
        pnl,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb);
    `,
    [
      fill.signal_id || null,
      fill.trade_id || null,
      resolvedAt,
      Number(fill.raw_probability || fill.probability || 0.5),
      Number(fill.calibrated_probability || fill.probability || 0.5),
      outcome ? 1 : 0,
      (Number(fill.calibrated_probability || fill.probability || 0.5) - (outcome ? 1 : 0)) ** 2,
      (Number(fill.raw_probability || fill.probability || 0.5) - (outcome ? 1 : 0)) ** 2,
      (Number(fill.calibrated_probability || fill.probability || 0.5) - (outcome ? 1 : 0)) ** 2,
      pnl,
      JSON.stringify({
        ...fill,
        resolvedAt,
        exit_price: exitPrice,
        pnl,
      }),
    ]
  );

  await publish("trade_resolved", {
    trade_id: fill.trade_id,
    signal_id: fill.signal_id,
    decision_id: fill.decision_id,
    probability: Number(fill.probability || 0.5),
    raw_probability: Number(fill.raw_probability || fill.probability || 0.5),
    calibrated_probability: Number(fill.calibrated_probability || fill.probability || 0.5),
    outcome,
    pnl,
    exit_price: exitPrice,
    size,
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
    resolved_at: resolvedAt,
  });

  await saveMetricsSnapshot("daily", {
    last_resolved_trade_id: fill.trade_id,
    resolved_count: resolvedCount,
  });
}

async function resolvePendingTrades() {
  if (!pool || !dbReady || !latestTick) return;

  const pending = await pool.query(
    `
      SELECT *
      FROM paper_trades
      WHERE resolved = FALSE
        AND created_at <= NOW() - ($1::bigint * interval '1 millisecond')
      ORDER BY created_at ASC
      LIMIT 100;
    `,
    [OUTCOME_DELAY_MS]
  );

  for (const row of pending.rows) {
    await resolveTrade({
      trade_id: row.id,
      signal_id: row.signal_id,
      decision_id: row.decision_id,
      action: row.action,
      regime: row.regime,
      size_multiplier: row.size,
      size: row.size,
      entry_price: row.entry_price,
      adjusted_cost: row.entry_price,
      fill_price: row.entry_price,
      probability: row.probability,
      raw_probability: row.probability,
      calibrated_probability: row.probability,
      cost: row.cost,
      feature_snapshot: row.feature_snapshot || {},
      model_scores: row.model_scores || {},
      weights: row.weights || {},
      baseline: {},
    });
  }
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
        if (fill.trade_id) {
          latestTick = latestTick || null;
        }
      }
    } catch (error) {
      console.error("outcome event handling failed:", error.message);
    }
  });

  setInterval(() => {
    resolvePendingTrades().catch((error) => {
      console.error("resolve pending trades failed:", error.message);
    });
  }, Math.max(15000, Math.min(60000, RESOLUTION_SCAN_MS)));
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
