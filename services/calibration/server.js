const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4009;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const ROLLING_WINDOW = Number.parseInt(process.env.CALIBRATION_WINDOW || "2000", 10);

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let latest = null;

async function initDb() {
  if (!pool) return;
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_log (
      signal_id UUID PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      probability DOUBLE PRECISION NOT NULL,
      confidence DOUBLE PRECISION NOT NULL,
      expected_value DOUBLE PRECISION NOT NULL,
      action TEXT NOT NULL,
      regime TEXT,
      payload JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_id UUID NOT NULL,
      trade_id UUID,
      resolved_at TIMESTAMPTZ NOT NULL,
      predicted_probability DOUBLE PRECISION NOT NULL,
      outcome INTEGER NOT NULL,
      brier DOUBLE PRECISION NOT NULL,
      payload JSONB NOT NULL
    );
  `);

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

async function refreshStats() {
  if (!pool || !dbReady) return;

  const read = await pool.query(
    `
      SELECT
        COUNT(*)::INTEGER AS resolved,
        COALESCE(AVG(brier), 0)::DOUBLE PRECISION AS brier_score,
        COALESCE(AVG(predicted_probability), 0)::DOUBLE PRECISION AS avg_probability,
        COALESCE(AVG(outcome), 0)::DOUBLE PRECISION AS observed_frequency
      FROM (
        SELECT brier, predicted_probability, outcome
        FROM trade_outcomes
        ORDER BY resolved_at DESC
        LIMIT $1
      ) w;
    `,
    [ROLLING_WINDOW]
  );

  latest = {
    resolved: Number(read.rows[0]?.resolved || 0),
    brier_score: Number(read.rows[0]?.brier_score || 0),
    avg_probability: Number(read.rows[0]?.avg_probability || 0),
    observed_frequency: Number(read.rows[0]?.observed_frequency || 0),
    window: ROLLING_WINDOW,
  };

  await publish("calibration_updated", latest);
}

async function start() {
  await initDb();
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type === "signal_generated" && pool && dbReady) {
        const p = evt.payload || {};
        await pool.query(
          `
            INSERT INTO signal_log (signal_id, ts, probability, confidence, expected_value, action, regime, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (signal_id) DO NOTHING;
          `,
          [
            p.signal_id,
            p.ts || new Date().toISOString(),
            Number(p.probability || 0.5),
            Number(p.confidence || 0),
            Number(p.expected_value || 0),
            p.action || "HOLD",
            p.regime || null,
            JSON.stringify(p),
          ]
        );
      }

      if (evt.event_type === "trade_resolved" && pool && dbReady) {
        const p = evt.payload || {};
        const prob = Number(p.probability || 0.5);
        const outcome = p.outcome ? 1 : 0;
        const brier = (prob - outcome) ** 2;

        await pool.query(
          `
            INSERT INTO trade_outcomes (signal_id, trade_id, resolved_at, predicted_probability, outcome, brier, payload)
            VALUES ($1, $2, NOW(), $3, $4, $5, $6::jsonb);
          `,
          [p.signal_id, p.trade_id, prob, outcome, brier, JSON.stringify(p)]
        );

        await refreshStats();
      }
    } catch (_error) {
      // ignore malformed event payloads
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "calibration", dbReady, connected });
});

app.get("/summary", (_req, res) => {
  res.json({ ok: true, calibration: latest });
});

start()
  .catch((error) => {
    console.error("calibration startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`calibration service listening on ${PORT}`);
    });
  });
