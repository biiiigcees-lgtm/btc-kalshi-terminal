const express = require("express");
const path = require("path");

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

const SIMULATOR_URL = process.env.SIMULATOR_URL || "http://localhost:4002";
const BACKTESTER_URL = process.env.BACKTESTER_URL || "http://localhost:4004";
const RISK_URL = process.env.RISK_URL || "http://localhost:4005";
const MICROSTRUCTURE_URL = process.env.MICROSTRUCTURE_URL || "http://localhost:4006";
const REGIME_URL = process.env.REGIME_URL || "http://localhost:4007";
const INTELLIGENCE_URL = process.env.INTELLIGENCE_URL || "http://localhost:4008";
const CALIBRATION_URL = process.env.CALIBRATION_URL || "http://localhost:4009";
const EXECUTION_URL = process.env.EXECUTION_URL || "http://localhost:4010";
const OUTCOME_URL = process.env.OUTCOME_URL || "http://localhost:4011";
const MLOPS_URL = process.env.MLOPS_URL || "http://localhost:4012";
const DATA_LAKE_URL = process.env.DATA_LAKE_URL || "http://localhost:4013";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.GATEWAY_TIMEOUT_MS || "3500", 10);

function parseWindow(raw, fallback = "24h") {
  if (!raw || typeof raw !== "string") {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (/^\d+(h|d|m)$/.test(normalized)) {
    return normalized;
  }

  return fallback;
}

function parseClampedProbability(raw, fallback = 0) {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();
    return {
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - startedAt,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - startedAt,
      error: error.name === "AbortError" ? "request timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "app-gateway" });
});

app.get("/api/metrics/summary", async (req, res) => {
  const windowValue = parseWindow(req.query.window, "24h");
  const minProbability = parseClampedProbability(req.query.minProbability, 0);
  const minAccuracy = parseClampedProbability(req.query.minAccuracy, 0);

  const simulatorQuery = new URLSearchParams({
    window: windowValue,
    minProbability: String(minProbability),
  });

  const backtesterQuery = new URLSearchParams({
    window: windowValue,
    minAccuracy: String(minAccuracy),
  });

  const [simulator, backtester] = await Promise.all([
    fetchJsonWithTimeout(`${SIMULATOR_URL}/metrics/summary?${simulatorQuery.toString()}`),
    fetchJsonWithTimeout(`${BACKTESTER_URL}/metrics/summary?${backtesterQuery.toString()}`),
  ]);

  const ok = simulator.ok || backtester.ok;

  return res.status(ok ? 200 : 502).json({
    ok,
    generated_at: new Date().toISOString(),
    window: windowValue,
    filters: {
      minProbability,
      minAccuracy,
    },
    simulator,
    backtester,
  });
});

app.get("/api/cluster/health", async (_req, res) => {
  const checks = {
    simulator: fetchJsonWithTimeout(`${SIMULATOR_URL}/health`),
    backtester: fetchJsonWithTimeout(`${BACKTESTER_URL}/health`),
    risk: fetchJsonWithTimeout(`${RISK_URL}/health`),
    microstructure: fetchJsonWithTimeout(`${MICROSTRUCTURE_URL}/health`),
    regime: fetchJsonWithTimeout(`${REGIME_URL}/health`),
    intelligence: fetchJsonWithTimeout(`${INTELLIGENCE_URL}/health`),
    calibration: fetchJsonWithTimeout(`${CALIBRATION_URL}/health`),
    execution: fetchJsonWithTimeout(`${EXECUTION_URL}/health`),
    outcome: fetchJsonWithTimeout(`${OUTCOME_URL}/health`),
    mlops: fetchJsonWithTimeout(`${MLOPS_URL}/health`),
    data_lake: fetchJsonWithTimeout(`${DATA_LAKE_URL}/health`),
  };

  const keys = Object.keys(checks);
  const values = await Promise.all(Object.values(checks));
  const services = keys.reduce((acc, key, i) => ({ ...acc, [key]: values[i] }), {});
  const ok = values.every((v) => v.ok);

  return res.status(ok ? 200 : 502).json({ ok, generated_at: new Date().toISOString(), services });
});

app.get("/api/intelligence/latest", async (_req, res) => {
  const [signal, calibration, model] = await Promise.all([
    fetchJsonWithTimeout(`${INTELLIGENCE_URL}/latest`),
    fetchJsonWithTimeout(`${CALIBRATION_URL}/summary`),
    fetchJsonWithTimeout(`${MLOPS_URL}/latest`),
  ]);

  const ok = signal.ok || calibration.ok || model.ok;
  return res.status(ok ? 200 : 502).json({
    ok,
    generated_at: new Date().toISOString(),
    signal,
    calibration,
    model,
  });
});

app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`app gateway listening on ${PORT}`);
});
