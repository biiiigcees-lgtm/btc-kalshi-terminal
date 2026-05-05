const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4004;
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

function parseAccuracy(raw, fallback = 0) {
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
      body: JSON.stringify({ kind: "backtest_run", input }),
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
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      total_signals INTEGER NOT NULL,
      total_trades INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      accuracy DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS backtest_signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      signal_index INTEGER NOT NULL,
      take_trade BOOLEAN NOT NULL,
      correct BOOLEAN,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  dbReady = true;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backtester", dbReady });
});

app.get("/runs", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  const limit = parseLimit(req.query.limit);

  try {
    const read = await pool.query(
      `
        SELECT id, total_signals, total_trades, wins, accuracy, created_at
        FROM backtest_runs
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

app.get("/runs/:id", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  try {
    const read = await pool.query(
      `
        SELECT id, total_signals, total_trades, wins, accuracy, created_at
        FROM backtest_runs
        WHERE id = $1
        LIMIT 1;
      `,
      [req.params.id]
    );

    if (!read.rows[0]) {
      return res.status(404).json({ ok: false, error: "backtest run not found" });
    }

    return res.json({ ok: true, row: read.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/runs/:id/signals", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  const limit = parseLimit(req.query.limit, 200, 1000);

  try {
    const runExists = await pool.query(
      `SELECT id FROM backtest_runs WHERE id = $1 LIMIT 1;`,
      [req.params.id]
    );

    if (!runExists.rows[0]) {
      return res.status(404).json({ ok: false, error: "backtest run not found" });
    }

    const read = await pool.query(
      `
        SELECT id, run_id, signal_index, take_trade, correct, payload, created_at
        FROM backtest_signals
        WHERE run_id = $1
        ORDER BY signal_index ASC
        LIMIT $2;
      `,
      [req.params.id, limit]
    );

    return res.json({ ok: true, count: read.rowCount, rows: read.rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/metrics/summary", async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ ok: false, error: "database not ready" });
  }

  const windowInterval = parseWindow(req.query.window);
  const minAccuracy = parseAccuracy(req.query.minAccuracy, 0);

  try {
    const summaryRead = await pool.query(
      `
        SELECT
          COUNT(*)::INTEGER AS runs,
          COALESCE(SUM(total_signals), 0)::INTEGER AS total_signals,
          COALESCE(SUM(total_trades), 0)::INTEGER AS total_trades,
          COALESCE(SUM(wins), 0)::INTEGER AS wins,
          COALESCE(AVG(accuracy), 0)::DOUBLE PRECISION AS avg_run_accuracy,
          MAX(created_at) AS last_run_at
        FROM backtest_runs
        WHERE created_at >= NOW() - $1::interval
          AND accuracy >= $2;
      `,
      [windowInterval, minAccuracy]
    );

    const row = summaryRead.rows[0] || {};
    const totalTrades = Number(row.total_trades || 0);
    const wins = Number(row.wins || 0);
    const overallTradeAccuracy = totalTrades > 0 ? wins / totalTrades : 0;

    const signalRead = await pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE take_trade = TRUE)::INTEGER AS take_trade_signals,
          COUNT(*)::INTEGER AS all_signals,
          COUNT(*) FILTER (WHERE correct = TRUE)::INTEGER AS correct_signals
        FROM backtest_signals bs
        INNER JOIN backtest_runs br ON br.id = bs.run_id
        WHERE br.created_at >= NOW() - $1::interval
          AND br.accuracy >= $2;
      `,
      [windowInterval, minAccuracy]
    );

    const signalRow = signalRead.rows[0] || {};
    const allSignals = Number(signalRow.all_signals || 0);
    const takeTradeSignals = Number(signalRow.take_trade_signals || 0);
    const signalTakeRate = allSignals > 0 ? takeTradeSignals / allSignals : 0;

    const drawdownRead = await pool.query(
      `
        WITH run_pnl AS (
          SELECT
            created_at,
            (wins * 100 - total_trades * 50)::DOUBLE PRECISION AS pnl
          FROM backtest_runs
          WHERE created_at >= NOW() - $1::interval
            AND accuracy >= $2
          ORDER BY created_at ASC
        ),
        curve AS (
          SELECT
            created_at,
            SUM(pnl) OVER (ORDER BY created_at ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_pnl
          FROM run_pnl
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
      [windowInterval, minAccuracy]
    );

    const maxDrawdown = Number(drawdownRead.rows[0]?.max_drawdown || 0);
    const windowHoursRead = await pool.query(`SELECT EXTRACT(EPOCH FROM $1::interval) / 3600 AS hours;`, [windowInterval]);
    const windowHours = Number(windowHoursRead.rows[0]?.hours || 24);
    const runs = Number(row.runs || 0);
    const runFrequencyPerHour = windowHours > 0 ? runs / windowHours : 0;

    return res.json({
      ok: true,
      window: windowInterval,
      filters: { minAccuracy },
      metrics: {
        runs,
        total_signals: Number(row.total_signals || 0),
        total_trades: totalTrades,
        wins,
        overall_trade_accuracy: overallTradeAccuracy,
        avg_run_accuracy: Number(row.avg_run_accuracy || 0),
        signal_take_rate: signalTakeRate,
        max_drawdown_proxy: maxDrawdown,
        run_frequency_per_hour: runFrequencyPerHour,
        last_run_at: row.last_run_at || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/run", async (req, res) => {
  const { signals = [] } = req.body || {};
  const trades = signals.filter((s) => s && s.takeTrade);
  const wins = trades.filter((t) => t.correct === true).length;
  const total = trades.length;
  const accuracy = total ? wins / total : 0;

  const risk = await evaluateRisk({
    totalSignals: signals.length,
    totalTrades: total,
    wins,
    accuracy,
  });
  if (!risk.allow) {
    return res.status(403).json({ ok: false, error: "risk check denied", risk });
  }

  let runId = null;

  try {
    if (pool && dbReady) {
      const runWrite = await pool.query(
        `
          INSERT INTO backtest_runs (total_signals, total_trades, wins, accuracy)
          VALUES ($1, $2, $3, $4)
          RETURNING id;
        `,
        [signals.length, total, wins, accuracy]
      );
      runId = runWrite.rows[0]?.id || null;

      if (runId && signals.length > 0) {
        const signalInsert = `
          INSERT INTO backtest_signals (run_id, signal_index, take_trade, correct, payload)
          VALUES ($1, $2, $3, $4, $5::jsonb);
        `;

        for (let i = 0; i < signals.length; i += 1) {
          const signal = signals[i] || {};
          await pool.query(signalInsert, [
            runId,
            i,
            Boolean(signal.takeTrade),
            signal.correct === undefined ? null : Boolean(signal.correct),
            JSON.stringify(signal),
          ]);
        }
      }
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({
    run_id: runId,
    total_signals: signals.length,
    total_trades: total,
    wins,
    accuracy,
  });
});

initDb()
  .catch((error) => {
    console.error("backtester db init failed:", error.message);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`backtester service listening on ${PORT}`);
    });
  });
