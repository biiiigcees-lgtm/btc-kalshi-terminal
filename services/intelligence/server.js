const express = require("express");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4008;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const EV_THRESHOLD = Number.parseFloat(process.env.EV_THRESHOLD || "0");
const MIN_CONFIDENCE = Number.parseFloat(process.env.MIN_CONFIDENCE || "0.65");
const SIGNAL_DECAY_MIN_MS = Number.parseInt(process.env.SIGNAL_DECAY_MIN_MS || "30000", 10);
const SIGNAL_DECAY_MAX_MS = Number.parseInt(process.env.SIGNAL_DECAY_MAX_MS || "90000", 10);
const WEIGHT_SMOOTHING_ALPHA = Number.parseFloat(process.env.WEIGHT_SMOOTHING_ALPHA || "0.2");
const WEIGHT_PERF_DECAY = Number.parseFloat(process.env.WEIGHT_PERF_DECAY || "0.9");
const MIN_SHARPE_FOR_TRADING = Number.parseFloat(process.env.MIN_SHARPE_FOR_TRADING || "0");

const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let connected = false;
let lastSignal = null;
let lastDecision = null;
let activeRegime = {
  regime: "mean_reversion",
  confidence: 0.7,
  policy: "mean_revert",
  allow_trade: true,
};
let calibrationState = { calibration_ready: false, resolved: 0 };
let validationState = {
  initialized: false,
  approved: true,
  beats_baselines: true,
  overfit_alert: false,
};
const rollingPnl = [];

const defaultWeights = {
  statistical_model: 0.4,
  rl_policy: 0.4,
  regime_adjustment: 0.2,
};

const regimeWeights = new Map();
const regimePerformance = new Map();

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function regimeAdjustment(regime) {
  if (regime === "trend_breakout") return 0.22;
  if (regime === "mean_reversion") return -0.14;
  if (regime === "low_volatility_chop") return -0.18;
  if (regime === "liquidity_vacuum") return -0.22;
  if (regime === "news_spike_volatility_shock") return -0.25;
  return -0.05;
}

function actionFromScore(score, confidence) {
  if (confidence < MIN_CONFIDENCE) return "HOLD";
  if (score > 0.35 && confidence > 0.82) return "SCALE_UP";
  if (score < -0.35 && confidence > 0.82) return "SCALE_DOWN";
  if (score > 0.05) return "LONG";
  if (score < -0.05) return "SHORT";
  return "HOLD";
}

function computeSharpe(values) {
  if (values.length < 5) return 0;
  const mean = values.reduce((acc, n) => acc + n, 0) / values.length;
  const variance = values.reduce((acc, n) => acc + (n - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(values.length);
}

function normalizeWeights(weights) {
  const safe = {
    statistical_model: Math.max(0.05, Number(weights.statistical_model || 0)),
    rl_policy: Math.max(0.05, Number(weights.rl_policy || 0)),
    regime_adjustment: Math.max(0.05, Number(weights.regime_adjustment || 0)),
  };
  const total = safe.statistical_model + safe.rl_policy + safe.regime_adjustment;
  return {
    statistical_model: safe.statistical_model / total,
    rl_policy: safe.rl_policy / total,
    regime_adjustment: safe.regime_adjustment / total,
  };
}

function getRegimeWeights(regime) {
  if (!regimeWeights.has(regime)) {
    regimeWeights.set(regime, { ...defaultWeights });
  }
  return regimeWeights.get(regime);
}

function getRegimePerformance(regime) {
  if (!regimePerformance.has(regime)) {
    regimePerformance.set(regime, {
      statistical_model: 0,
      rl_policy: 0,
      regime_adjustment: 0,
    });
  }
  return regimePerformance.get(regime);
}

function smoothWeights(current, target) {
  const alpha = clamp(WEIGHT_SMOOTHING_ALPHA, 0.01, 0.9);
  return normalizeWeights({
    statistical_model:
      (1 - alpha) * Number(current.statistical_model || 0) + alpha * Number(target.statistical_model || 0),
    rl_policy: (1 - alpha) * Number(current.rl_policy || 0) + alpha * Number(target.rl_policy || 0),
    regime_adjustment:
      (1 - alpha) * Number(current.regime_adjustment || 0) + alpha * Number(target.regime_adjustment || 0),
  });
}

function computeDecayMs(volatility) {
  const normalizedVol = clamp(Number(volatility || 0) / 0.0035, 0, 1);
  return Math.round(SIGNAL_DECAY_MAX_MS - normalizedVol * (SIGNAL_DECAY_MAX_MS - SIGNAL_DECAY_MIN_MS));
}

function applySignalDecay(score, ageMs, decayMs) {
  if (ageMs <= 0) {
    return { decayedScore: score, decayFactor: 1 };
  }
  const decayFactor = Math.exp(-ageMs / Math.max(1, decayMs));
  return {
    decayedScore: Number(score || 0) * decayFactor,
    decayFactor,
  };
}

function regimeAlignment(action, regime, momentum) {
  if (action === "HOLD") {
    return { match: true, reason: "hold action is always regime-safe" };
  }

  if (regime === "low_volatility_chop" || regime === "liquidity_vacuum") {
    return { match: false, reason: "regime policy blocks directional trades" };
  }

  if (regime === "news_spike_volatility_shock") {
    return { match: false, reason: "news spike regime forces hold" };
  }

  const longAction = action === "LONG" || action === "SCALE_UP";
  const shortAction = action === "SHORT" || action === "SCALE_DOWN";

  if (regime === "trend_breakout") {
    if (longAction && momentum >= 0) return { match: true, reason: "trend-following long alignment" };
    if (shortAction && momentum <= 0) return { match: true, reason: "trend-following short alignment" };
    return { match: false, reason: "trend regime mismatch" };
  }

  if (regime === "mean_reversion") {
    if (longAction && momentum <= 0) return { match: true, reason: "mean-reversion long alignment" };
    if (shortAction && momentum >= 0) return { match: true, reason: "mean-reversion short alignment" };
    return { match: false, reason: "mean-reversion mismatch" };
  }

  return { match: true, reason: "default alignment pass" };
}

function computeTargetWeights(perf) {
  const stable = {
    statistical_model: Math.max(0.01, Number(perf.statistical_model || 0) + 0.11),
    rl_policy: Math.max(0.01, Number(perf.rl_policy || 0) + 0.11),
    regime_adjustment: Math.max(0.01, Number(perf.regime_adjustment || 0) + 0.11),
  };

  return normalizeWeights(stable);
}

function updateAdaptiveWeights(resolvedPayload) {
  const regime = String(resolvedPayload.regime || "mean_reversion");
  const reward = clamp(Number(resolvedPayload.pnl || 0) / 50, -1, 1);
  const modelScores = resolvedPayload.model_scores || {};

  const perf = getRegimePerformance(regime);
  const decay = clamp(WEIGHT_PERF_DECAY, 0.6, 0.99);
  perf.statistical_model = decay * perf.statistical_model + (1 - decay) * reward * Number(modelScores.statistical_model || 0);
  perf.rl_policy = decay * perf.rl_policy + (1 - decay) * reward * Number(modelScores.rl_policy || 0);
  perf.regime_adjustment =
    decay * perf.regime_adjustment + (1 - decay) * reward * Number(modelScores.regime_adjustment || 0);

  const current = getRegimeWeights(regime);
  const target = computeTargetWeights(perf);
  regimeWeights.set(regime, smoothWeights(current, target));
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

async function generateSignal(feature) {
  const momentum = Number(feature.momentum || 0);
  const imbalance = Number(feature.imbalance || 0);
  const volatility = Number(feature.volatility || 0);
  const liquidity = Number(feature.liquidity_thickness || 0.5);
  const spreadBps = Number(feature.spread_bps || 4);
  const price = Number(feature.price || 0);
  const maFast = Number(feature.ma_fast || price || 0);
  const maSlow = Number(feature.ma_slow || price || 0);
  const movingAverageDelta = price > 0 ? (maFast - maSlow) / price : 0;

  const statisticalModel = Math.tanh(momentum * 220 + imbalance * 1.4 - volatility * 16);
  const rlPolicy = Math.tanh(imbalance * 1.8 + momentum * 180 + (liquidity - 0.5) * 1.2);
  const regimeAdj = regimeAdjustment(activeRegime.regime) * Number(activeRegime.confidence || 0.7);

  const weights = getRegimeWeights(activeRegime.regime);
  const normalizedWeights = normalizeWeights(weights);

  const rawSignal =
    normalizedWeights.statistical_model * statisticalModel +
    normalizedWeights.rl_policy * rlPolicy +
    normalizedWeights.regime_adjustment * regimeAdj;

  const rawProbability = sigmoid(rawSignal * 4);
  const rawConfidence = Math.abs(rawProbability - 0.5) * 2;

  const kalshiYesCost = 50 + Math.max(-20, Math.min(20, momentum * 10000));
  const actionHint = actionFromScore(rawSignal, rawConfidence);

  const signalId = crypto.randomUUID();
  const payload = {
    signal_id: signalId,
    symbol: "BTC-USD",
    expiry: "15m",
    ts: feature.ts || new Date().toISOString(),
    generated_at_ms: Date.now(),
    regime: {
      name: activeRegime.regime,
      policy: activeRegime.policy,
      confidence: Number(activeRegime.confidence || 0.7),
      allow_trade: Boolean(activeRegime.allow_trade),
    },
    model_scores: {
      statistical_model: statisticalModel,
      rl_policy: rlPolicy,
      regime_adjustment: regimeAdj,
    },
    weights: normalizedWeights,
    baseline: {
      random_model: 0.5,
      momentum_model: sigmoid(momentum * 200),
      moving_average_model: sigmoid(movingAverageDelta * 4500),
    },
    feature_snapshot: {
      price,
      momentum,
      imbalance,
      volatility,
      liquidity_thickness: liquidity,
      spread_bps: spreadBps,
      flow_direction: feature.flow_direction || "NEUTRAL",
      ma_fast: maFast,
      ma_slow: maSlow,
    },
    raw_signal: rawSignal,
    raw_probability: rawProbability,
    raw_confidence: rawConfidence,
    action_hint: actionHint,
    kalshi_yes_cost: kalshiYesCost,
    expected_value_raw: rawProbability * 100 - kalshiYesCost,
    no_trade: true,
    no_trade_reason: "awaiting calibration",
  };

  lastSignal = payload;
  await publish("signal_generated", payload);
}

async function evaluateCalibratedSignal(calibrated) {
  const rawSignal = Number(calibrated.raw_signal || 0);
  const volatility = Number(calibrated.feature_snapshot?.volatility || 0);
  const momentum = Number(calibrated.feature_snapshot?.momentum || 0);
  const cost = Number(calibrated.kalshi_yes_cost || 50);
  const calibratedProbability = Number(calibrated.calibrated_probability || calibrated.raw_probability || 0.5);
  const confidence = Math.abs(calibratedProbability - 0.5) * 2;
  const signalAgeMs = Math.max(0, Date.now() - Number(calibrated.generated_at_ms || Date.now()));
  const decayMs = computeDecayMs(volatility);
  const { decayedScore, decayFactor } = applySignalDecay(rawSignal, signalAgeMs, decayMs);
  const expectedValue = calibratedProbability * 100 - cost;
  const action = actionFromScore(decayedScore, confidence);
  const regimeName = String(calibrated.regime?.name || activeRegime.regime);
  const regimeCheck = regimeAlignment(action, regimeName, momentum);
  const sharpe = computeSharpe(rollingPnl.slice(-120));
  const calibrationReady = Boolean(calibrated.calibration_ready);
  const validationApproved = Boolean(validationState.approved);
  const baselineGate = !validationState.initialized || Boolean(validationState.beats_baselines);

  const reasons = [];
  if (!calibrationReady) reasons.push("calibration not ready");
  if (confidence <= MIN_CONFIDENCE) reasons.push("confidence threshold not met");
  if (expectedValue <= EV_THRESHOLD) reasons.push("expected value threshold not met");
  if (!regimeCheck.match) reasons.push(regimeCheck.reason);
  if (!Boolean(calibrated.regime?.allow_trade)) reasons.push("regime policy blocks trading");
  if (signalAgeMs > decayMs * 2) reasons.push("signal expired by decay model");
  if (!validationApproved) reasons.push("model validation gate rejected");
  if (!baselineGate) reasons.push("model not beating baseline ensemble");
  if (sharpe < MIN_SHARPE_FOR_TRADING) reasons.push("rolling sharpe below trading threshold");
  if (action === "HOLD") reasons.push("action resolved to HOLD");

  const decisionAllowed = reasons.length === 0;
  const decisionPayload = {
    decision_id: crypto.randomUUID(),
    signal_id: calibrated.signal_id,
    symbol: calibrated.symbol || "BTC-USD",
    expiry: calibrated.expiry || "15m",
    action,
    probability: calibratedProbability,
    raw_probability: Number(calibrated.raw_probability || 0.5),
    confidence,
    expected_value: expectedValue,
    cost,
    regime: regimeName,
    regime_policy: calibrated.regime?.policy || activeRegime.policy,
    regime_match: regimeCheck.match,
    calibration_ready: calibrationReady,
    validation_approved: validationApproved,
    baseline_gate_pass: baselineGate,
    sharpe,
    signal_age_ms: signalAgeMs,
    decay_ms: decayMs,
    decay_factor: decayFactor,
    expires_at: new Date(Number(calibrated.generated_at_ms || Date.now()) + decayMs).toISOString(),
    feature_snapshot: calibrated.feature_snapshot || {},
    baseline: calibrated.baseline || {},
    model_scores: calibrated.model_scores || {},
    weights: calibrated.weights || getRegimeWeights(regimeName),
    ts: calibrated.ts || new Date().toISOString(),
  };

  lastDecision = {
    ...decisionPayload,
    allow_trade: decisionAllowed,
    reasons,
  };

  if (decisionAllowed) {
    await publish("trade_decision", {
      ...decisionPayload,
      allow_trade: true,
    });
    return;
  }

  await publish("trade_decision_rejected", {
    ...decisionPayload,
    allow_trade: false,
    reasons,
  });
}

async function start() {
  await Promise.all([sub.connect(), pub.connect()]);
  connected = true;

  await sub.subscribe(EVENT_CHANNEL, async (raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.event_type === "regime_shift") {
        const p = evt.payload || {};
        activeRegime = {
          regime: p.regime || activeRegime.regime,
          confidence: Number(p.confidence || activeRegime.confidence || 0.7),
          policy: p.policy || activeRegime.policy || "mean_revert",
          allow_trade: p.allow_trade === undefined ? true : Boolean(p.allow_trade),
        };
        return;
      }

      if (evt.event_type === "calibration_updated") {
        const p = evt.payload || {};
        calibrationState = {
          calibration_ready: Boolean(p.calibration_ready),
          resolved: Number(p.resolved || 0),
          brier_calibrated: Number(p.brier_calibrated || 0),
          sharpe: Number(p.sharpe_ratio || 0),
        };
        return;
      }

      if (evt.event_type === "validation_report") {
        const p = evt.payload || {};
        validationState = {
          initialized: Boolean(p.initialized),
          approved: Boolean(p.approved),
          beats_baselines: Boolean(p.beats_baselines),
          overfit_alert: Boolean(p.overfit_alert),
          divergence: Number(p.live_backtest_divergence || 0),
        };
        return;
      }

      if (evt.event_type === "trade_resolved") {
        rollingPnl.push(Number(evt.payload?.pnl || 0));
        if (rollingPnl.length > 400) {
          rollingPnl.shift();
        }
        updateAdaptiveWeights(evt.payload || {});
        return;
      }

      if (evt.event_type === "microstructure_update") {
        await generateSignal(evt.payload || {});
        return;
      }

      if (evt.event_type === "signal_calibrated") {
        await evaluateCalibratedSignal(evt.payload || {});
      }
    } catch (_error) {
      // ignore malformed event
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "intelligence",
    connected,
    regime: activeRegime,
    calibration_ready: calibrationState.calibration_ready,
    validation_approved: validationState.approved,
    rolling_sharpe: computeSharpe(rollingPnl.slice(-120)),
  });
});

app.get("/latest", (_req, res) => {
  res.json({
    ok: true,
    signal: lastSignal,
    decision: lastDecision,
    regime: activeRegime,
    calibration: calibrationState,
    validation: validationState,
    weights: Object.fromEntries(regimeWeights.entries()),
  });
});

start()
  .catch((error) => {
    console.error("intelligence startup failed:", error.message);
    process.exit(1);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`intelligence service listening on ${PORT}`);
    });
  });
