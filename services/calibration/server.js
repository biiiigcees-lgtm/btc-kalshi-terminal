const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 4009;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EVENT_CHANNEL = process.env.EVENT_CHANNEL || "trading_events";
const ROLLING_WINDOW = Number.parseInt(process.env.CALIBRATION_WINDOW || "2000", 10);
const MIN_CALIBRATION_SAMPLES = Number.parseInt(process.env.MIN_CALIBRATION_SAMPLES || "80", 10);

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
const sub = createClient({ url: REDIS_URL });
const pub = createClient({ url: REDIS_URL });

let dbReady = false;
let connected = false;
let latest = null;
let calibrationModel = {
  ready: false,
  sample_count: 0,
  selected_method: "identity",
  platt: null,
  isotonic: null,
  blend_iso_weight: 0.5,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

function computeSharpe(values) {
  if (values.length < 5) return 0;
  const mean = average(values);
  const variance = average(values.map((v) => (v - mean) ** 2));
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(values.length);
}

function precisionRecall(probabilities, outcomes, threshold = 0.5) {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < probabilities.length; i += 1) {
    const positive = probabilities[i] >= threshold;
    const actual = outcomes[i] === 1;
    if (positive && actual) tp += 1;
    if (positive && !actual) fp += 1;
    if (!positive && actual) fn += 1;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return { precision, recall };
}

function expectedCalibrationError(probabilities, outcomes, bins = 10) {
  if (!probabilities.length) return 0;
  let ece = 0;

  for (let b = 0; b < bins; b += 1) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = [];
    for (let i = 0; i < probabilities.length; i += 1) {
      const p = probabilities[i];
      if ((p >= lo && p < hi) || (b === bins - 1 && p === 1)) {
        idx.push(i);
      }
    }
    if (!idx.length) continue;

    const conf = average(idx.map((i) => probabilities[i]));
    const acc = average(idx.map((i) => outcomes[i]));
    ece += (idx.length / probabilities.length) * Math.abs(conf - acc);
  }

  return ece;
}

function fitPlatt(samples) {
  let a = 0;
  let b = 0;
  const lr = 0.9;
  const l2 = 0.001;

  for (let iter = 0; iter < 300; iter += 1) {
    let gradA = 0;
    let gradB = 0;

    for (const s of samples) {
      const x = clamp(s.raw_probability, 1e-6, 1 - 1e-6);
      const y = s.outcome;
      const pred = sigmoid(a * x + b);
      const err = pred - y;
      gradA += err * x;
      gradB += err;
    }

    gradA = gradA / samples.length + l2 * a;
    gradB /= samples.length;
    a -= lr * gradA;
    b -= lr * gradB;
  }

  return { a, b };
}

function predictPlatt(model, probability) {
  if (!model) return probability;
  return sigmoid(model.a * probability + model.b);
}

function fitIsotonic(samples) {
  const sorted = [...samples].sort((a, b) => a.raw_probability - b.raw_probability);
  const blocks = sorted.map((s) => ({
    minX: s.raw_probability,
    maxX: s.raw_probability,
    sumY: s.outcome,
    count: 1,
  }));

  let i = 0;
  while (i < blocks.length - 1) {
    const meanA = blocks[i].sumY / blocks[i].count;
    const meanB = blocks[i + 1].sumY / blocks[i + 1].count;

    if (meanA <= meanB) {
      i += 1;
      continue;
    }

    blocks[i] = {
      minX: blocks[i].minX,
      maxX: blocks[i + 1].maxX,
      sumY: blocks[i].sumY + blocks[i + 1].sumY,
      count: blocks[i].count + blocks[i + 1].count,
    };
    blocks.splice(i + 1, 1);
    if (i > 0) i -= 1;
  }

  return blocks.map((b) => ({
    minX: b.minX,
    maxX: b.maxX,
    value: b.sumY / b.count,
  }));
}

function predictIsotonic(model, probability) {
  if (!model || !model.length) return probability;
  for (const block of model) {
    if (probability <= block.maxX) {
      return block.value;
    }
  }
  return model[model.length - 1].value;
}

function computeBrier(samples, predictor) {
  if (!samples.length) return 0;
  const values = samples.map((s) => {
    const p = clamp(predictor(s.raw_probability), 0, 1);
    return (p - s.outcome) ** 2;
  });
  return average(values);
}

function trainCalibrationModel(samples) {
  if (!samples.length) {
    const priors = [
      { raw_probability: 0.1, outcome: 0 },
      { raw_probability: 0.2, outcome: 0 },
      { raw_probability: 0.3, outcome: 0 },
      { raw_probability: 0.7, outcome: 1 },
      { raw_probability: 0.8, outcome: 1 },
      { raw_probability: 0.9, outcome: 1 },
    ];

    return {
      ready: true,
      sample_count: 0,
      selected_method: "bootstrap_prior",
      platt: fitPlatt(priors),
      isotonic: fitIsotonic(priors),
      blend_iso_weight: 0.5,
    };
  }

  if (samples.length < MIN_CALIBRATION_SAMPLES) {
    const bootstrap = [
      ...samples,
      { raw_probability: 0.1, outcome: 0 },
      { raw_probability: 0.2, outcome: 0 },
      { raw_probability: 0.3, outcome: 0 },
      { raw_probability: 0.7, outcome: 1 },
      { raw_probability: 0.8, outcome: 1 },
      { raw_probability: 0.9, outcome: 1 },
    ];

    const platt = fitPlatt(bootstrap);
    const isotonic = fitIsotonic(bootstrap);

    return {
      ready: true,
      sample_count: samples.length,
      selected_method: "bootstrap_blend",
      platt,
      isotonic,
      blend_iso_weight: 0.5,
    };
  }

  const split = Math.max(20, Math.floor(samples.length * 0.8));
  const train = samples.slice(0, split);
  const validate = samples.slice(split);

  const platt = fitPlatt(train);
  const isotonic = fitIsotonic(train);

  const valSet = validate.length ? validate : train;
  const plattBrier = computeBrier(valSet, (p) => predictPlatt(platt, p));
  const isotonicBrier = computeBrier(valSet, (p) => predictIsotonic(isotonic, p));
  const selectedMethod = isotonicBrier <= plattBrier ? "isotonic" : "platt";

  return {
    ready: true,
    sample_count: samples.length,
    selected_method: selectedMethod,
    platt,
    isotonic,
    blend_iso_weight: clamp(samples.length / 2000, 0.35, 0.7),
  };
}

function calibrateProbability(rawProbability) {
  const raw = clamp(Number(rawProbability || 0.5), 0, 1);

  if (!calibrationModel.ready) {
    return {
      raw_probability: raw,
      calibrated_probability: raw,
      platt_probability: raw,
      isotonic_probability: raw,
      calibration_method: calibrationModel.selected_method,
      calibration_ready: false,
    };
  }

  const plattProbability = clamp(predictPlatt(calibrationModel.platt, raw), 0, 1);
  const isotonicProbability = clamp(predictIsotonic(calibrationModel.isotonic, raw), 0, 1);
  const isoWeight = calibrationModel.blend_iso_weight;
  const calibrated = clamp(isoWeight * isotonicProbability + (1 - isoWeight) * plattProbability, 0, 1);

  return {
    raw_probability: raw,
    calibrated_probability: calibrated,
    platt_probability: plattProbability,
    isotonic_probability: isotonicProbability,
    calibration_method: calibrationModel.selected_method,
    calibration_ready: true,
  };
}

async function loadSamples() {
  if (!pool || !dbReady) return [];
  const read = await pool.query(
    `
      SELECT
        COALESCE((payload->>'raw_probability')::DOUBLE PRECISION, predicted_probability) AS raw_probability,
        outcome,
        COALESCE(calibrated_probability, predicted_probability) AS calibrated_probability,
        COALESCE(pnl, (payload->>'pnl')::DOUBLE PRECISION, 0) AS pnl
      FROM trade_outcomes
      ORDER BY resolved_at DESC
      LIMIT $1;
    `,
    [ROLLING_WINDOW]
  );

  return read.rows.map((r) => ({
    raw_probability: clamp(Number(r.raw_probability || 0.5), 0, 1),
    calibrated_probability: clamp(Number(r.calibrated_probability || r.raw_probability || 0.5), 0, 1),
    outcome: Number(r.outcome || 0),
    pnl: Number(r.pnl || 0),
  }));
}

async function initDb() {
  if (!pool) return;
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_log (
      signal_id UUID PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      probability DOUBLE PRECISION NOT NULL,
      calibrated_probability DOUBLE PRECISION,
      calibration_method TEXT,
      confidence DOUBLE PRECISION NOT NULL,
      expected_value DOUBLE PRECISION NOT NULL,
      baseline_random DOUBLE PRECISION,
      baseline_momentum DOUBLE PRECISION,
      baseline_moving_average DOUBLE PRECISION,
      action TEXT NOT NULL,
      regime TEXT,
      payload JSONB NOT NULL
    );
  `);

  await pool.query(
    "ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS calibrated_probability DOUBLE PRECISION;"
  );
  await pool.query("ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS calibration_method TEXT;");
  await pool.query("ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS baseline_random DOUBLE PRECISION;");
  await pool.query("ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS baseline_momentum DOUBLE PRECISION;");
  await pool.query("ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS baseline_moving_average DOUBLE PRECISION;");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_id UUID NOT NULL,
      trade_id UUID,
      resolved_at TIMESTAMPTZ NOT NULL,
      predicted_probability DOUBLE PRECISION NOT NULL,
      calibrated_probability DOUBLE PRECISION,
      outcome INTEGER NOT NULL,
      brier DOUBLE PRECISION NOT NULL,
      raw_brier DOUBLE PRECISION,
      calibrated_brier DOUBLE PRECISION,
      pnl DOUBLE PRECISION,
      payload JSONB NOT NULL
    );
  `);

  await pool.query("ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS calibrated_probability DOUBLE PRECISION;");
  await pool.query("ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS raw_brier DOUBLE PRECISION;");
  await pool.query("ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS calibrated_brier DOUBLE PRECISION;");
  await pool.query("ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS pnl DOUBLE PRECISION;");

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
  const samples = await loadSamples();
  calibrationModel = trainCalibrationModel(samples);

  const outcomes = samples.map((s) => s.outcome);
  const rawProbabilities = samples.map((s) => s.raw_probability);
  const calibratedProbabilities = rawProbabilities.map((p) => calibrateProbability(p).calibrated_probability);
  const pnlValues = samples.map((s) => s.pnl);

  const rawBrier = average(rawProbabilities.map((p, i) => (p - outcomes[i]) ** 2));
  const calibratedBrier = average(calibratedProbabilities.map((p, i) => (p - outcomes[i]) ** 2));
  const pr = precisionRecall(calibratedProbabilities, outcomes, 0.5);

  latest = {
    resolved: samples.length,
    calibration_ready: calibrationModel.ready,
    selected_method: calibrationModel.selected_method,
    brier_raw: rawBrier || 0,
    brier_calibrated: calibratedBrier || 0,
    expected_calibration_error: expectedCalibrationError(calibratedProbabilities, outcomes, 10),
    avg_probability: average(calibratedProbabilities),
    observed_frequency: average(outcomes),
    precision: pr.precision,
    recall: pr.recall,
    ev_per_trade: average(pnlValues),
    sharpe_ratio: computeSharpe(pnlValues),
    window: ROLLING_WINDOW,
    sample_count: calibrationModel.sample_count,
    methods: {
      platt: calibrationModel.platt,
      isotonic_blocks: calibrationModel.isotonic ? calibrationModel.isotonic.length : 0,
      iso_blend_weight: calibrationModel.blend_iso_weight,
    },
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
        const calibrated = calibrateProbability(Number(p.raw_probability || p.probability || 0.5));

        await pool.query(
          `
            INSERT INTO signal_log (
              signal_id,
              ts,
              probability,
              calibrated_probability,
              calibration_method,
              confidence,
              expected_value,
              baseline_random,
              baseline_momentum,
              baseline_moving_average,
              action,
              regime,
              payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
            ON CONFLICT (signal_id)
            DO UPDATE SET
              calibrated_probability = EXCLUDED.calibrated_probability,
              calibration_method = EXCLUDED.calibration_method,
              payload = EXCLUDED.payload;
          `,
          [
            p.signal_id,
            p.ts || new Date().toISOString(),
            calibrated.raw_probability,
            calibrated.calibrated_probability,
            calibrated.calibration_method,
            Number(p.raw_confidence || p.confidence || 0),
            Number(p.expected_value_raw || p.expected_value || 0),
            Number(p.baseline?.random_model || 0.5),
            Number(p.baseline?.momentum_model || 0.5),
            Number(p.baseline?.moving_average_model || 0.5),
            p.action_hint || p.action || "HOLD",
            p.regime?.name || p.regime || null,
            JSON.stringify(p),
          ]
        );

        await publish("signal_calibrated", {
          ...p,
          ...calibrated,
          calibration_ready: calibrated.calibration_ready,
        });
      }

      if (evt.event_type === "trade_resolved" && pool && dbReady) {
        const p = evt.payload || {};
        const rawProb = clamp(Number(p.raw_probability || p.probability || 0.5), 0, 1);
        const calibratedProb = clamp(Number(p.calibrated_probability || rawProb), 0, 1);
        const outcome = p.outcome ? 1 : 0;
        const brierRaw = (rawProb - outcome) ** 2;
        const brierCalibrated = (calibratedProb - outcome) ** 2;
        const pnl = Number(p.pnl || 0);

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
            VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10::jsonb);
          `,
          [
            p.signal_id,
            p.trade_id,
            calibratedProb,
            calibratedProb,
            outcome,
            brierCalibrated,
            brierRaw,
            brierCalibrated,
            pnl,
            JSON.stringify({ ...p, raw_probability: rawProb, calibrated_probability: calibratedProb }),
          ]
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
    refreshStats().catch(() => {
      // no historical samples yet
    });

    app.listen(PORT, () => {
      console.log(`calibration service listening on ${PORT}`);
    });
  });
