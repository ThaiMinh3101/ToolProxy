require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");

// Đặt thư mục cache cục bộ cho Puppeteer để khi chạy bằng .exe vẫn tải/dùng đúng trình duyệt
process.env.PUPPETEER_CACHE_DIR = path.join(process.cwd(), ".cache", "puppeteer");

const express = require("express");
const { readConfig } = require("./config");
const { Logger } = require("./logger");
const { ProxyManager } = require("./proxyManager");
const { AccountManager } = require("./accountManager");
const { StateStore } = require("./stateStore");
const { ProcessCleaner } = require("./processCleaner");

const config = readConfig();
const appStartedAtIso = new Date().toISOString();
const logger = new Logger(config.logging.filePath);
const proxyManager = new ProxyManager({ logger });
const processCleaner = new ProcessCleaner({ logger });
const accountManager = new AccountManager({ config, proxyManager, processCleaner, logger });
const stateStore = new StateStore({
  enabled: config.persistence.enabled,
  filePath: config.persistence.filePath,
  logger
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Quản lý kết nối SSE
const sseClients = new Set();

// Gửi Log qua SSE khi có log mới
logger.onLog((entry) => {
  const payload = JSON.stringify({ type: "log", data: entry });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      // Bỏ qua lỗi ghi client hỏng
    }
  }
});

// Middleware xác thực API Key
function requireAuth(req, res, next) {
  const configuredKey = config.app.apiKey;
  if (!configuredKey) {
    return next(); // Không cấu hình API Key thì bỏ qua bảo mật
  }

  const key = req.headers["x-api-key"] || req.query.apiKey;
  if (key === configuredKey) {
    return next();
  }

  res.status(401).json({ ok: false, error: "Unauthorized: Invalid API Key" });
}

// Cho phép truy cập static files công khai, nhưng yêu cầu auth đối với các endpoints khác
app.use((req, res, next) => {
  const publicPaths = ["/", "/index.html", "/script.js", "/styles.css", "/health"];
  if (publicPaths.includes(req.path)) {
    return next();
  }
  return requireAuth(req, res, next);
});

function sendError(res, error, status = 400) {
  res.status(status).json({
    ok: false,
    error: String(error?.message || error)
  });
}

function getNetworkUrls(host, port) {
  const urls = [];
  const normalizedHost = String(host || "").trim();
  const wildcard = normalizedHost === "0.0.0.0" || normalizedHost === "::";
  if (!normalizedHost || wildcard) {
    urls.push(`http://127.0.0.1:${port}/`);
    urls.push(`http://localhost:${port}/`);
    const interfaces = os.networkInterfaces();
    for (const key of Object.keys(interfaces)) {
      for (const net of interfaces[key] || []) {
        if (net.family === "IPv4" && !net.internal) {
          urls.push(`http://${net.address}:${port}/`);
        }
      }
    }
  } else {
    urls.push(`http://${normalizedHost}:${port}/`);
  }
  return Array.from(new Set(urls));
}

function buildPersistedState() {
  return {
    proxies: proxyManager.listRaw(),
    accounts: accountManager.listPersistableAccounts()
  };
}

function persistState(reason) {
  try {
    const saved = stateStore.save(buildPersistedState(), reason);
    if (saved) {
      logger.debug("State persisted", { reason, filePath: config.persistence.filePath });
    }
  } catch (error) {
    logger.error("Failed to persist state", {
      reason,
      error: String(error?.message || error)
    });
  }
}

function restoreStateFromDisk() {
  const state = stateStore.load();
  if (!state) return;

  let restoredProxies = 0;
  let restoredAccounts = 0;
  let resumedAccounts = 0;

  const proxyResults = proxyManager.addMany(state.proxies || []);
  for (const item of proxyResults) {
    if (item.added) restoredProxies += 1;
  }

  for (const account of state.accounts || []) {
    try {
      accountManager.addAccount({
        accountId: account.accountId,
        targetUrl: account.targetUrl,
        scriptName: account.scriptName
      });
      restoredAccounts += 1;
      if (account.running) {
        accountManager.startAccount(account.accountId);
        resumedAccounts += 1;
      }
    } catch (error) {
      logger.warn("Failed to restore account from state", {
        accountId: account?.accountId || null,
        error: String(error?.message || error)
      });
    }
  }

  logger.info("Persisted state restored", {
    savedAt: state.savedAt,
    restoredProxies,
    restoredAccounts,
    resumedAccounts,
    stateFile: config.persistence.filePath
  });
}

// Phát trạng thái định kỳ hoặc khi có thay đổi cho SSE clients
function broadcastStatusUpdate() {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify({
    type: "status",
    data: {
      health: {
        ok: true,
        uptimeSec: process.uptime(),
        rotationMode: config.runtime.rotationMode,
        proxies: proxyManager.list().length,
        sessions: accountManager.getStatuses().length
      },
      sessions: accountManager.getStatuses()
    }
  });

  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      // bỏ qua
    }
  }
}

// Gửi broadcast trạng thái định kỳ 3 giây một lần
setInterval(broadcastStatusUpdate, 3000);

// Endpoint SSE
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Đăng ký client
  sseClients.add(res);

  // Gửi sự kiện ban đầu xác nhận kết nối thành công
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: process.uptime(),
    rotationMode: config.runtime.rotationMode,
    proxies: proxyManager.list().length,
    sessions: accountManager.getStatuses().length
  });
});

app.get("/runtime", (req, res) => {
  res.json({
    ok: true,
    data: {
      startedAt: appStartedAtIso,
      rotationMode: config.runtime.rotationMode,
      rotationIntervalMs: config.runtime.rotationIntervalMs,
      taskIntervalMs: config.runtime.taskIntervalMs,
      maxRetries: config.runtime.maxRetries,
      urls: getNetworkUrls(config.app.host, config.app.port),
      persistenceEnabled: config.persistence.enabled,
      stateFilePath: config.persistence.filePath
    }
  });
});

app.get("/proxies", (req, res) => {
  res.json({ ok: true, data: proxyManager.list() });
});

app.post("/proxies", (req, res) => {
  try {
    const { proxy, proxies } = req.body || {};
    if (!proxy && !Array.isArray(proxies)) {
      throw new Error("Provide `proxy` string or `proxies` array.");
    }

    const values = proxy ? [proxy] : proxies;
    const result = proxyManager.addMany(values);
    persistState("proxies_add");
    broadcastStatusUpdate();
    res.json({ ok: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/proxies", (req, res) => {
  try {
    const key = req.body?.proxyIdOrRaw;
    if (!key) throw new Error("proxyIdOrRaw is required");

    const result = proxyManager.remove(key);
    if (!result.removed) {
      return res.status(404).json({ ok: false, error: "Proxy not found" });
    }

    for (const session of accountManager.getStatuses()) {
      if (session.proxy?.id === result.proxyId) {
        accountManager.rotateAccount(session.accountId);
      }
    }

    persistState("proxies_remove");
    broadcastStatusUpdate();
    res.json({ ok: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/sessions", (req, res) => {
  res.json({ ok: true, data: accountManager.getStatuses() });
});

app.post("/accounts", (req, res) => {
  try {
    const { accountId, targetUrl, scriptName, autostart = true } = req.body || {};
    let data = accountManager.addAccount({ accountId, targetUrl, scriptName });
    if (autostart) {
      data = accountManager.startAccount(accountId);
    }
    persistState("accounts_add");
    broadcastStatusUpdate();
    res.status(201).json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/accounts/:accountId", async (req, res) => {
  try {
    const removed = await accountManager.removeAccount(req.params.accountId);
    if (!removed) {
      return res.status(404).json({ ok: false, error: "Account not found" });
    }
    persistState("accounts_remove");
    broadcastStatusUpdate();
    res.json({ ok: true, data: { removed: true } });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/accounts/:accountId/start", (req, res) => {
  try {
    const data = accountManager.startAccount(req.params.accountId);
    persistState("accounts_start");
    broadcastStatusUpdate();
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post("/accounts/:accountId/stop", async (req, res) => {
  try {
    const data = await accountManager.stopAccount(req.params.accountId);
    persistState("accounts_stop");
    broadcastStatusUpdate();
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post("/accounts/:accountId/rotate", (req, res) => {
  try {
    const data = accountManager.rotateAccount(req.params.accountId);
    broadcastStatusUpdate();
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post("/rotate", (req, res) => {
  try {
    const accountId = req.body?.accountId;
    if (accountId) {
      const data = accountManager.rotateAccount(accountId);
      broadcastStatusUpdate();
      return res.json({ ok: true, data });
    }
    const data = accountManager.rotateAll();
    broadcastStatusUpdate();
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.get("/logs/recent", (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 150);
    const limit = Math.min(Math.max(requestedLimit || 150, 1), 2000);
    const scope = String(req.query.scope || "current").trim().toLowerCase();
    if (!fs.existsSync(config.logging.filePath)) {
      return res.json({ ok: true, data: [] });
    }

    const fileContent = fs.readFileSync(config.logging.filePath, "utf8");
    const lines = fileContent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit);

    const data = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return { ts: null, level: "raw", message: line };
        }
      })
      .filter((entry) => {
        if (scope === "all") return true;
        if (!entry.ts) return false;
        return entry.ts >= appStartedAtIso;
      });

    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error, 500);
  }
});

app.delete("/logs", (req, res) => {
  try {
    fs.mkdirSync(path.dirname(config.logging.filePath), { recursive: true });
    fs.writeFileSync(config.logging.filePath, "");
    logger.info("Logs cleared manually");
    broadcastStatusUpdate();
    res.json({ ok: true, data: { cleared: true } });
  } catch (error) {
    sendError(res, error, 500);
  }
});

app.use((error, req, res, next) => {
  logger.error("Unhandled API error", { error: String(error?.message || error) });
  sendError(res, error, 500);
});

function bootstrapFromEnv() {
  if (config.bootstrap.proxies.length > 0) {
    const added = proxyManager.addMany(config.bootstrap.proxies);
    logger.info("Loaded bootstrap proxies", { total: added.length });
  }

  for (const account of config.bootstrap.accounts) {
    try {
      accountManager.addAccount({
        accountId: account.accountId,
        targetUrl: account.targetUrl,
        scriptName: account.scriptName
      });
      accountManager.startAccount(account.accountId);
    } catch (error) {
      logger.error("Failed to bootstrap account", {
        accountId: account.accountId,
        error: String(error?.message || error)
      });
    }
  }
}

let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info("Shutting down...");
  persistState("shutdown");
  await accountManager.stopAll();
  await processCleaner.cleanAllActive(); // Giải phóng sạch tiến trình Chromium còn chạy
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const server = app.listen(config.app.port, config.app.host, async () => {
  // Dọn dẹp tiến trình mồ côi từ lần chạy trước
  await processCleaner.cleanOrphans();

  restoreStateFromDisk();
  bootstrapFromEnv();
  persistState("startup");

  const urls = getNetworkUrls(config.app.host, config.app.port);
  logger.info("Tool Proxy API started", {
    host: config.app.host,
    port: config.app.port,
    rotationMode: config.runtime.rotationMode,
    logFile: config.logging.filePath,
    urls
  });

  process.stdout.write("\n");
  process.stdout.write("Tool Proxy Dashboard URLs:\n");
  for (const url of urls) {
    process.stdout.write(`- ${url}\n`);
  }
  process.stdout.write("\n");
});

server.on("error", (error) => {
  logger.error("Tool Proxy API failed to start", {
    host: config.app.host,
    port: config.app.port,
    error: String(error?.message || error)
  });

  if (error?.code === "EADDRINUSE") {
    process.stderr.write(
      `\nPort ${config.app.port} is already in use. Stop the old server or set PORT to another value.\n\n`
    );
  }

  process.exit(1);
});
