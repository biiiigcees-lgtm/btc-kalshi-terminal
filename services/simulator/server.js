const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4002;
const DATABASE_URL = process.env.DATABASE_URL;
const RISK_URL = process.env.RISK_URL;

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
let dbReady = false;

function parseLimit(raw, fallback = 50, max = 500) {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseWindow(raw, fallback = "24 hours") {
  if (!raw || typeof raw !== "string") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  const direct = normalized.match(/^(\d+)\s*(hour|hours|day|days|minute|minutes)$/);
  if (direct) {
    return `${direct[1]} ${direct[2]}`;
  }

  const short = normalized.match(/^(\d+)(h|d|m)$/);
  if (!short) {
    return fallback;
  }

  const value = short[1];
  const unit = short[2] === "h" ? "hours" : short[2] === "d" ? "days" : "minutes";
  return `${value} ${unit}`;
}

function parseProbability(raw, fallback = 0) {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

async function evaluateRisk(input) {
  if (!RISK_URL) {
    return { allow: true, mode: "disabled" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`${RISK_URL}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "paper_trade", input }),
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok) {
      return { allow: false, reasons: [data.error || "risk evaluation failed"] };
    }

    return data;
  } catch (error) {
    return { allow: false, reasons: ["risk service unavailable", error.message] };
  } finally {
    clearTimeout(timeout);
  }
}

async function initDb() {
  if (!pool) {
    dbReady = false;
    return;
  }

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  } catch (error) {
    // Benign race can happen when multiple services initialize simultaneously.
    if (error.code !== "23505") {
      throw error;
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      probability DOUBLE PRECISION NOT NULL,
      cost DOUBLE PRECISION NOT NULL,
      outcome BOOLEAN,
      payout DOUBLE PRECISION NOT NULL,
      expected_value DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  dbReady = true;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "simulator", dbReady });
});

app.get("/paper-trades", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  const limit = parseLimit(req.query.limit);

  try {
    const read = await pool.query(
      `
        SELECT id, probability, cost, outcome, payout, expected_value, created_at
        FROM paper_trades
        ORDER BY created_at DESC
        LIMIT $1;
      `,
      [limit]
    );

    return res.json({ ok: true, count: read.rowCount, rows: read.rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/paper-trades/:id", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  try {
    const read = await pool.query(
      `
        SELECT id, probability, cost, outcome, payout, expected_value, created_at
        FROM paper_trades
        WHERE id = $1
        LIMIT 1;
      `,
      [req.params.id]
    );

    if (!read.rows[0]) {
      return res.status(404).json({ ok: false, error: "paper trade not found" });
    }

    return res.json({ ok: true, row: read.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/metrics/summary", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  const windowInterval = parseWindow(req.query.window);
  const minProbability = parseProbability(req.query.minProbability, 0);

  try {
    const summaryRead = await pool.query(
      `
        SELECT
          COUNT(*)::INTEGER AS trades,
          COUNT(*) FILTER (WHERE outcome IS NOT NULL)::INTEGER AS resolved_trades,
          COUNT(*) FILTER (WHERE outcome = TRUE)::INTEGER AS wins,
          COALESCE(AVG(expected_value), 0)::DOUBLE PRECISION AS avg_expected_value,
          COALESCE(AVG(probability), 0)::DOUBLE PRECISION AS avg_probability,
          COALESCE(
            SUM(
              CASE
                WHEN outcome = TRUE THEN payout - cost
                WHEN outcome = FALSE THEN -cost
                ELSE 0
              END
            ),
            0
          )::DOUBLE PRECISION AS net_realized_pnl,
          MAX(created_at) AS last_trade_at
        FROM paper_trades
        WHERE created_at >= NOW() - $1::interval
          AND probability >= $2;
      `,
      [windowInterval, minProbability]
    );

    const row = summaryRead.rows[0] || {};
    const resolvedTrades = Number(row.resolved_trades || 0);
    const wins = Number(row.wins || 0);
    const winRate = resolvedTrades > 0 ? wins / resolvedTrades : 0;

    const drawdownRead = await pool.query(
      `
        WITH filtered AS (
          SELECT
            created_at,
            CASE
              WHEN outcome = TRUE THEN payout - cost
              WHEN outcome = FALSE THEN -cost
              ELSE 0
            END AS pnl
          FROM paper_trades
          WHERE created_at >= NOW() - $1::interval
            AND probability >= $2
            AND outcome IS NOT NULL
          ORDER BY created_at ASC
        ),
        curve AS (
          SELECT
            created_at,
            SUM(pnl) OVER (ORDER BY created_at ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_pnl
          FROM filtered
        ),
        peaks AS (
          SELECT
            created_at,
            cum_pnl,
            MAX(cum_pnl) OVER (ORDER BY created_at ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak_pnl
          FROM curve
        )
        SELECT COALESCE(MAX(peak_pnl - cum_pnl), 0)::DOUBLE PRECISION AS max_drawdown
        FROM peaks;
      `,
      [windowInterval, minProbability]
    );

    const maxDrawdown = Number(drawdownRead.rows[0]?.max_drawdown || 0);
    const windowHoursRead = await pool.query(`SELECT EXTRACT(EPOCH FROM $1::interval) / 3600 AS hours;`, [windowInterval]);
    const windowHours = Number(windowHoursRead.rows[0]?.hours || 24);
    const trades = Number(row.trades || 0);
    const tradeFrequencyPerHour = windowHours > 0 ? trades / windowHours : 0;

    return res.json({
      ok: true,
      window: windowInterval,
      filters: { minProbability },
      metrics: {
        trades,
        resolved_trades: resolvedTrades,
        wins,
        win_rate: winRate,
        avg_expected_value: Number(row.avg_expected_value || 0),
        avg_probability: Number(row.avg_probability || 0),
        net_realized_pnl: Number(row.net_realized_pnl || 0),
        max_drawdown_proxy: maxDrawdown,
        trade_frequency_per_hour: tradeFrequencyPerHour,
        last_trade_at: row.last_trade_at || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/paper-trade", async (req, res) => {
  const { probability = 0.5, cost = 50, outcome = null } = req.body || {};
  const risk = await evaluateRisk({ probability: Number(probability), cost: Number(cost), outcome });
  if (!risk.allow) {
    return res.status(403).json({ ok: false, error: "risk check denied", risk });
  }

  const payout = outcome === true ? 100 : 0;
  const expected_value = Number(probability) * 100 - Number(cost);

  let tradeId = null;

  try {
    if (pool && dbReady) {
      const write = await pool.query(
        `
          INSERT INTO paper_trades (probability, cost, outcome, payout, expected_value)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id;
        `,
        [Number(probability), Number(cost), outcome, payout, expected_value]
      );
      tradeId = write.rows[0]?.id || null;
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({
    mode: "paper",
    trade_id: tradeId,
    payout,
    expected_value,
    input: { probability, cost, outcome },
  });
});

initDb()
  .catch((error) => {
    console.error("simulator db init failed:", error.message);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`simulator service listening on ${PORT}`);
    });
  });
