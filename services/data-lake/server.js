const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4013;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let captured = 0;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_log (
      id UUID PRIMARY KEY,
      event_type TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbReady = true;
}

async function start() {
  await initDb();
  await sub.connect();
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (!pool || !dbReady || !evt.id || !evt.event_type || !evt.ts) return;
      await pool.query(
        `
          INSERT INTO event_log (id, event_type, ts, payload)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (id) DO NOTHING;
        `,
        [evt.id, evt.event_type, evt.ts, JSON.stringify(evt.payload || {})]
      );
      captured += 1;
    } catch (_error) {
      // ignore malformed event payloads
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "data-lake", connected, dbReady, captured });
});

start()
  .catch((error) => {
    console.error("data-lake startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`data-lake service listening on ${PORT}`);
    });
  });
