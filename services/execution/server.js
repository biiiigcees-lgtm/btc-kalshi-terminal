const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4010;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const EXECUTION_MODE = process.env.EXECUTION_MODE || "paper";

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let recentFills = [];

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

  const probability = Number(decision.probability || 0.5);
  const cost = Number(decision.cost || 50);
  const expectedValue = Number(decision.expected_value || 0);

  const write = await pool.query(
    `
      INSERT INTO paper_trades (probability, cost, outcome, payout, expected_value)
      VALUES ($1, $2, NULL, 0, $3)
      RETURNING id, created_at;
    `,
    [probability, cost, expectedValue]
  );

  const tradeId = write.rows[0]?.id;
  const fill = {
    trade_id: tradeId,
    signal_id: decision.signal_id,
    decision_id: decision.decision_id,
    symbol: decision.symbol,
    expiry: decision.expiry,
    action: decision.action,
    probability,
    cost,
    expected_value: expectedValue,
    fill_price: cost,
    mode: EXECUTION_MODE,
    ts: write.rows[0]?.created_at || new Date().toISOString(),
  };

  recentFills.unshift(fill);
  recentFills = recentFills.slice(0, 100);

  await publish("execution_fill", fill);
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
    } catch (_error) {
      // ignore malformed events
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
