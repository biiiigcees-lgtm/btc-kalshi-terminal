const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4005;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });
let dbReady = false;
let busConnected = false;
let cooldownUntil = null;
let lossStreak = 0;
const regimeExposure = {};

const NOTIONAL_BANKROLL = Number.parseFloat(process.env.NOTIONAL_BANKROLL || "10000");
const MAX_TRADE_RISK_PCT = Number.parseFloat(process.env.MAX_TRADE_RISK_PCT || "0.25");
const MAX_DAILY_LOSS_PCT = Number.parseFloat(process.env.MAX_DAILY_LOSS_PCT || "2");
const MAX_DRAWDOWN_PCT = Number.parseFloat(process.env.MAX_DRAWDOWN_PCT || "5");
const MAX_EXPOSURE_PER_REGIME_PCT = Number.parseFloat(process.env.MAX_EXPOSURE_PER_REGIME_PCT || "40");
const COOLDOWN_AFTER_LOSS_TRADES = Number.parseInt(process.env.COOLDOWN_AFTER_LOSS_TRADES || "3", 10);
const MAX_BACKTEST_PROJECTED_LOSS = Number.parseFloat(process.env.MAX_BACKTEST_PROJECTED_LOSS || "800");
const COOLDOWN_MINUTES = Number.parseInt(process.env.COOLDOWN_MINUTES || "30", 10);

const MAX_LOSS_PER_TRADE = (MAX_TRADE_RISK_PCT / 100) * NOTIONAL_BANKROLL;
const MAX_DAILY_LOSS = (MAX_DAILY_LOSS_PCT / 100) * NOTIONAL_BANKROLL;
const MAX_DRAWDOWN = (MAX_DRAWDOWN_PCT / 100) * NOTIONAL_BANKROLL;

async function initDb() {
  if (!pool) {
    dbReady = false;
    return;
  }

  await pool.query("SELECT 1;");
  dbReady = true;
}

function isCooldownActive() {
  if (!cooldownUntil) {
    return false;
  }
  return Date.now() < cooldownUntil.getTime();
}

function triggerCooldown() {
  cooldownUntil = new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000);
  return cooldownUntil;
}

async function getRiskState() {
  if (!pool || !dbReady) {
    return {
      dailyRealizedPnl: 0,
      maxDrawdown: 0,
    };
  }

  const dailyRead = await pool.query(
    `
      SELECT COALESCE(
        SUM(
          CASE
            WHEN outcome = TRUE THEN payout - cost
            WHEN outcome = FALSE THEN -cost
            ELSE 0
          END
        ),
        0
      )::DOUBLE PRECISION AS daily_realized_pnl
      FROM paper_trades
      WHERE created_at >= date_trunc('day', NOW());
    `
  );

  const drawdownRead = await pool.query(
    `
      WITH resolved AS (
        SELECT
          created_at,
          CASE
            WHEN outcome = TRUE THEN payout - cost
            WHEN outcome = FALSE THEN -cost
            ELSE 0
          END AS pnl
        FROM paper_trades
        WHERE outcome IS NOT NULL
        ORDER BY created_at ASC
      ),
      curve AS (
        SELECT
          created_at,
          SUM(pnl) OVER (ORDER BY created_at ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_pnl
        FROM resolved
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
    `
  );

  return {
    dailyRealizedPnl: Number(dailyRead.rows[0]?.daily_realized_pnl || 0),
    maxDrawdown: Number(drawdownRead.rows[0]?.max_drawdown || 0),
  };
}

function evaluatePaperTrade(input, state) {
  const reasons = [];
  const tradeCost = Number(input.cost || 0);

  if (isCooldownActive()) {
    reasons.push("cooldown active");
  }
  if (tradeCost > MAX_LOSS_PER_TRADE) {
    reasons.push("trade cost exceeds max loss per trade");
  }
  if (state.dailyRealizedPnl <= -MAX_DAILY_LOSS) {
    reasons.push("daily loss limit reached");
  }
  if (state.maxDrawdown >= MAX_DRAWDOWN) {
    reasons.push("max drawdown limit reached");
  }

  if (reasons.length > 0 && !isCooldownActive()) {
    triggerCooldown();
  }

  return reasons;
}

function evaluateBacktestRun(input, state) {
  const reasons = [];
  const totalTrades = Number(input.totalTrades || 0);
  const wins = Number(input.wins || 0);
  const projectedLoss = Math.max(0, totalTrades * 50 - wins * 100);

  if (isCooldownActive()) {
    reasons.push("cooldown active");
  }
  if (projectedLoss > MAX_BACKTEST_PROJECTED_LOSS) {
    reasons.push("projected run loss exceeds configured threshold");
  }
  if (state.dailyRealizedPnl <= -MAX_DAILY_LOSS) {
    reasons.push("daily loss limit reached");
  }
  if (state.maxDrawdown >= MAX_DRAWDOWN) {
    reasons.push("max drawdown limit reached");
  }

  if (reasons.length > 0 && !isCooldownActive()) {
    triggerCooldown();
  }

  return reasons;
}

function evaluateDecision(input, state) {
  const reasons = [];
  const confidence = Number(input.confidence || 0);
  const cost = Number(input.cost || 0);
  const regime = String(input.regime || "unknown");
  const exposureForRegime = Number(regimeExposure[regime] || 0);
  const exposurePct = (exposureForRegime / NOTIONAL_BANKROLL) * 100;

  if (isCooldownActive()) {
    reasons.push("cooldown active");
  }
  if (cost > MAX_LOSS_PER_TRADE) {
    reasons.push("trade cost exceeds max loss per trade");
  }
  if (confidence < 0.65) {
    reasons.push("confidence below hard threshold");
  }
  if (lossStreak >= COOLDOWN_AFTER_LOSS_TRADES) {
    reasons.push("cooldown after consecutive losses");
  }
  if (state.dailyRealizedPnl <= -MAX_DAILY_LOSS) {
    reasons.push("daily loss limit reached");
  }
  if (state.maxDrawdown >= MAX_DRAWDOWN) {
    reasons.push("max drawdown limit reached");
  }
  if (exposurePct >= MAX_EXPOSURE_PER_REGIME_PCT) {
    reasons.push("max exposure per regime reached");
  }

  if (reasons.length > 0 && !isCooldownActive()) {
    triggerCooldown();
  }

  return reasons;
}

async function publish(eventType, payload) {
  if (!busConnected) {
    return;
  }

  const event = {
    id: crypto.randomUUID(),
    event_type: eventType,
    ts: new Date().toISOString(),
    payload,
  };
  await pub.publish(EVENT_CHANNEL, JSON.stringify(event));
}

async function startEventLoop() {
  await Promise.all([sub.connect(), pub.connect()]);
  busConnected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type === "trade_resolved") {
        const pnl = Number(evt.payload?.pnl || 0);
        if (pnl < 0) {
          lossStreak += 1;
        } else {
          lossStreak = 0;
        }

        if (lossStreak >= COOLDOWN_AFTER_LOSS_TRADES && !isCooldownActive()) {
          triggerCooldown();
        }
        return;
      }

      if (evt.event_type !== "trade_decision") {
        return;
      }

      const state = await getRiskState();
      const decision = evt.payload || {};
      const reasons = evaluateDecision(decision, state);
      const allow = reasons.length === 0;

      if (allow) {
        const regime = String(decision.regime || "unknown");
        regimeExposure[regime] = Number(regimeExposure[regime] || 0) + Number(decision.cost || 0);
      }

      await publish("risk_update", {
        allow,
        reasons,
        decision,
        state: {
          dailyRealizedPnl: state.dailyRealizedPnl,
          maxDrawdown: state.maxDrawdown,
          lossStreak,
          regimeExposure,
          cooldownActive: isCooldownActive(),
          cooldownUntil,
        },
      });
    } catch (_error) {
      // ignore malformed event payloads
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "risk",
    dbReady,
    busConnected,
    cooldownActive: isCooldownActive(),
    cooldownUntil,
  });
});

app.post("/evaluate", async (req, res) => {
  const { kind, input = {} } = req.body || {};

  if (!kind || (kind !== "paper_trade" && kind !== "backtest_run")) {
    return res.status(400).json({ ok: false, error: "invalid kind" });
  }

  try {
    const state = await getRiskState();
    const reasons =
      kind === "paper_trade"
        ? evaluatePaperTrade(input, state)
        : evaluateBacktestRun(input, state);

    return res.json({
      ok: true,
      allow: reasons.length === 0,
      kind,
      reasons,
      limits: {
        maxLossPerTrade: MAX_LOSS_PER_TRADE,
        maxDailyLoss: MAX_DAILY_LOSS,
        maxDrawdown: MAX_DRAWDOWN,
        maxTradeRiskPct: MAX_TRADE_RISK_PCT,
        maxDailyLossPct: MAX_DAILY_LOSS_PCT,
        maxDrawdownPct: MAX_DRAWDOWN_PCT,
        maxExposurePerRegimePct: MAX_EXPOSURE_PER_REGIME_PCT,
        cooldownAfterLossTrades: COOLDOWN_AFTER_LOSS_TRADES,
        notionalBankroll: NOTIONAL_BANKROLL,
        maxBacktestProjectedLoss: MAX_BACKTEST_PROJECTED_LOSS,
        cooldownMinutes: COOLDOWN_MINUTES,
      },
      state: {
        dailyRealizedPnl: state.dailyRealizedPnl,
        maxDrawdown: state.maxDrawdown,
        lossStreak,
        regimeExposure,
        cooldownActive: isCooldownActive(),
        cooldownUntil,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

initDb()
  .then(() => startEventLoop())
  .catch((error) => {
    console.error("risk db init failed:", error.message);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`risk service listening on ${PORT}`);
    });
  });
