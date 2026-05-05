#!/usr/bin/env node

const validationUrl = process.env.MLOPS_VALIDATION_URL || "http://localhost:4012/validation";
const maxViolations = Number.parseInt(process.env.MAX_LEAKAGE_VIOLATIONS || "0", 10);

function fail(message) {
  console.error(`[ci-leakage-guard] ${message}`);
  process.exit(1);
}

async function main() {
  let response;
  try {
    response = await fetch(validationUrl);
  } catch (error) {
    fail(`unable to reach validation endpoint: ${error.message}`);
  }

  if (!response.ok) {
    fail(`validation endpoint returned ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    fail(`validation endpoint did not return JSON: ${error.message}`);
  }

  const checks = payload?.validation?.leakage_checks;
  if (!checks || checks.checked !== true) {
    fail("leakage checks are missing or not marked checked");
  }

  const violations = Number(checks.violations);
  if (!Number.isFinite(violations)) {
    fail("leakage violations is not a numeric value");
  }

  if (violations > maxViolations) {
    fail(
      `leakage violations ${violations} exceed allowed ${maxViolations} (inspected=${checks.inspected}, missing=${checks.missing_fields}, invalid=${checks.invalid_timestamps})`
    );
  }

  console.log(
    `[ci-leakage-guard] pass violations=${violations} inspected=${checks.inspected} max_skew_ms=${checks.max_positive_skew_ms}`
  );
}

main().catch((error) => {
  fail(error.message);
});
