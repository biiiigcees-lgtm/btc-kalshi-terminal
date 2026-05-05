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
const DRAWDOWN_VELOCITY_LIMIT = Number.parseFloat(process.env.DRAWDOWN_VELOCITY_LIMIT || "5");
const MIN_CONFIDENCE = Number.parseFloat(process.env.MIN_CONFIDENCE || "0.65");

const MAX_LOSS_PER_TRADE = (MAX_TRADE_RISK_PCT / 100) * NOTIONAL_BANKROLL;
const MAX_DAILY_LOSS = (MAX_DAILY_LOSS_PCT / 100) * NOTIONAL_BANKROLL;
const MAX_DRAWDOWN = (MAX_DRAWDOWN_PCT / 100) * NOTIONAL_BANKROLL;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

  let drawdownVelocity = 0;
  let pnlVolatility = 0;

  try {
    const recentRead = await pool.query(
      `
        SELECT
          resolved_at,
          COALESCE(pnl, (payload->>'pnl')::DOUBLE PRECISION, 0) AS pnl
        FROM trade_outcomes
        ORDER BY resolved_at DESC
        LIMIT 40;
      `
    );

    const recentRows = [...recentRead.rows].reverse();
    if (recentRows.length >= 2) {
      let cumulative = 0;
      let peak = 0;
      const drawdowns = [];
      const pnls = [];

      for (const row of recentRows) {
        const pnl = Number(row.pnl || 0);
        pnls.push(pnl);
        cumulative += pnl;
        peak = Math.max(peak, cumulative);
        drawdowns.push(peak - cumulative);
      }

      const firstTs = new Date(recentRows[0].resolved_at).getTime();
      const lastTs = new Date(recentRows[recentRows.length - 1].resolved_at).getTime();
      const minutes = Math.max(1, (lastTs - firstTs) / 60000);
      drawdownVelocity = (drawdowns[drawdowns.length - 1] - drawdowns[0]) / minutes;

      const mean = pnls.reduce((acc, v) => acc + v, 0) / pnls.length;
      const variance = pnls.reduce((acc, v) => acc + (v - mean) ** 2, 0) / pnls.length;
      pnlVolatility = Math.sqrt(variance);
    }
  } catch (_error) {
    // trade_outcomes may not exist yet on early startup
  }

  return {
    dailyRealizedPnl: Number(dailyRead.rows[0]?.daily_realized_pnl || 0),
    maxDrawdown: Number(drawdownRead.rows[0]?.max_drawdown || 0),
    drawdownVelocity,
    pnlVolatility,
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
  const volatility = Number(input.feature_snapshot?.volatility || 0);
  const liquidity = Number(input.feature_snapshot?.liquidity_thickness || 0.5);
  const regime = String(input.regime || "unknown");
  const exposureForRegime = Number(regimeExposure[regime] || 0);
  const exposurePct = (exposureForRegime / NOTIONAL_BANKROLL) * 100;

  const volatilityMultiplier = clamp(1 - volatility * 180, 0.25, 1);
  const liquidityMultiplier = clamp(0.4 + liquidity * 0.8, 0.35, 1);
  const streakMultiplier = clamp(1 - lossStreak * 0.15, 0.35, 1);
  const drawdownVelocityMultiplier = state.drawdownVelocity > DRAWDOWN_VELOCITY_LIMIT ? 0.45 : 1;
  const sizeMultiplier = clamp(
    volatilityMultiplier * liquidityMultiplier * streakMultiplier * drawdownVelocityMultiplier,
    0.2,
    1
  );
  const adjustedCost = cost * sizeMultiplier;

  if (isCooldownActive()) {
    reasons.push("cooldown active");
  }
  if (adjustedCost > MAX_LOSS_PER_TRADE) {
    reasons.push("volatility-adjusted risk exceeds max trade risk");
  }
  if (!Boolean(input.calibration_ready)) {
    reasons.push("calibration gate failed");
  }
  if (!Boolean(input.regime_match)) {
    reasons.push("regime match required");
  }
  if (!Boolean(input.validation_approved)) {
    reasons.push("validation gate failed");
  }
  if (!Boolean(input.baseline_gate_pass)) {
    reasons.push("baseline comparison gate failed");
  }
  if (confidence < MIN_CONFIDENCE) {
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
  if (state.drawdownVelocity > DRAWDOWN_VELOCITY_LIMIT && state.dailyRealizedPnl < 0) {
    reasons.push("drawdown velocity kill-switch active");
  }
  if (volatility > 0.003 && lossStreak >= 2) {
    reasons.push("volatility spike with loss streak");
  }
  if (exposurePct >= MAX_EXPOSURE_PER_REGIME_PCT) {
    reasons.push("max exposure per regime reached");
  }

  if (reasons.length > 0 && !isCooldownActive()) {
    triggerCooldown();
  }

  return {
    reasons,
    sizeMultiplier,
    adjustedCost,
    riskDiagnostics: {
      volatilityMultiplier,
      liquidityMultiplier,
      streakMultiplier,
      drawdownVelocityMultiplier,
      drawdownVelocity: state.drawdownVelocity,
      pnlVolatility: state.pnlVolatility,
    },
  };
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
        const regime = String(evt.payload?.regime || "unknown");
        const exposureRelease = Number(evt.payload?.adjusted_cost || evt.payload?.cost || 0);

        if (regimeExposure[regime]) {
          regimeExposure[regime] = Math.max(0, Number(regimeExposure[regime] || 0) - exposureRelease);
        }

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
      const evaluation = evaluateDecision(decision, state);
      const allow = evaluation.reasons.length === 0;

      const decisionWithSizing = {
        ...decision,
        size_multiplier: evaluation.sizeMultiplier,
        adjusted_cost: evaluation.adjustedCost,
      };

      if (allow) {
        const regime = String(decision.regime || "unknown");
        regimeExposure[regime] = Number(regimeExposure[regime] || 0) + Number(evaluation.adjustedCost || 0);
      }

      await publish("risk_update", {
        allow,
        reasons: evaluation.reasons,
        decision: decisionWithSizing,
        risk_diagnostics: evaluation.riskDiagnostics,
        state: {
          dailyRealizedPnl: state.dailyRealizedPnl,
          maxDrawdown: state.maxDrawdown,
          drawdownVelocity: state.drawdownVelocity,
          pnlVolatility: state.pnlVolatility,
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
        drawdownVelocityLimit: DRAWDOWN_VELOCITY_LIMIT,
        minConfidence: MIN_CONFIDENCE,
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
        drawdownVelocity: state.drawdownVelocity,
        pnlVolatility: state.pnlVolatility,
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
