const path = require("path");

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(asNumber(value, fallback));
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

function asBool(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAccounts(value) {
  const raw = parseList(value);
  return raw.map((accountId) => ({ accountId }));
}

function readConfig(env = process.env) {
  const rotationModeRaw = (env.ROTATION_MODE || "interval").trim();
  const rotationMode = ["interval", "perRequest"].includes(rotationModeRaw)
    ? rotationModeRaw
    : "interval";

  return {
    app: {
      port: asBoundedInteger(env.PORT, 3000, 1, 65535),
      host: env.HOST || "0.0.0.0",
      apiKey: env.API_KEY || ""
    },
    browser: {
      headless: asBool(env.HEADLESS, true),
      navigationTimeoutMs: asBoundedInteger(
        env.NAVIGATION_TIMEOUT_MS,
        45000,
        1000,
        300000
      ),
      defaultTargetUrl: env.TARGET_URL || "https://httpbin.org/ip",
      maxCyclesPerBrowser: asBoundedInteger(
        env.MAX_CYCLES_PER_BROWSER,
        10,
        1,
        1000
      )
    },
    runtime: {
      taskIntervalMs: asBoundedInteger(env.TASK_INTERVAL_MS, 30000, 1000, 86400000),
      rotationMode,
      rotationIntervalMs: asBoundedInteger(
        env.ROTATION_INTERVAL_MS,
        120000,
        1000,
        86400000
      ),
      maxRetries: asBoundedInteger(env.MAX_RETRIES, 3, 1, 20),
      retryBackoffMs: asBoundedInteger(env.RETRY_BACKOFF_MS, 2000, 0, 300000)
    },
    logging: {
      filePath:
        env.LOG_FILE_PATH ||
        path.join(process.cwd(), "logs", "tool-proxy.log")
    },
    persistence: {
      enabled: asBool(env.PERSIST_STATE, true),
      filePath:
        env.STATE_FILE_PATH ||
        path.join(process.cwd(), "data", "state.json")
    },
    bootstrap: {
      proxies: parseList(env.PROXIES),
      accounts: parseAccounts(env.ACCOUNTS)
    }
  };
}

module.exports = { readConfig };
