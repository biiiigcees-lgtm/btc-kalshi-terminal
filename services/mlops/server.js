const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4012;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let latestModel = null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_name TEXT NOT NULL,
      model_version TEXT NOT NULL,
      brier_score DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

async function recomputeModel() {
  if (!pool || !dbReady) return;

  const read = await pool.query(`
    SELECT
      COALESCE(AVG(brier), 0)::DOUBLE PRECISION AS brier_score,
      COALESCE(AVG(outcome), 0)::DOUBLE PRECISION AS hit_rate,
      COUNT(*)::INTEGER AS resolved
    FROM trade_outcomes;
  `);

  const brier = Number(read.rows[0]?.brier_score || 0);
  const hitRate = Number(read.rows[0]?.hit_rate || 0);
  const resolved = Number(read.rows[0]?.resolved || 0);

  const version = `kalshi-btc15m-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const payload = {
    resolved,
    brier_score: brier,
    accuracy: hitRate,
    deployment_target: "inference",
  };

  await pool.query(
    `
      INSERT INTO model_registry (model_name, model_version, brier_score, accuracy, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb);
    `,
    ["kalshi-btc-15m-hybrid", version, brier, hitRate, JSON.stringify(payload)]
  );

  latestModel = {
    model_name: "kalshi-btc-15m-hybrid",
    model_version: version,
    brier_score: brier,
    accuracy: hitRate,
    resolved,
    trained_at: new Date().toISOString(),
  };

  await publish("model_updated", latestModel);
}

async function start() {
  await initDb();
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type !== "trade_resolved") return;
      await recomputeModel();
    } catch (_error) {
      // ignore malformed event payloads
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mlops", connected, dbReady });
});

app.get("/latest", (_req, res) => {
  res.json({ ok: true, model: latestModel });
});

start()
  .catch((error) => {
    console.error("mlops startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`mlops service listening on ${PORT}`);
    });
  });
