const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");

const { isBlockedStatus, isProxyFailure } = require("./utils");

// Tích hợp Stealth Plugin vào puppeteer-extra
puppeteer.use(StealthPlugin());

class BrowserSession {
  constructor({ accountId, targetUrl, scriptName, config, proxyManager, processCleaner, logger }) {
    this.accountId = accountId;
    this.targetUrl = targetUrl || config.browser.defaultTargetUrl;
    this.scriptName = scriptName || "defaultTask.js";
    this.config = config;
    this.proxyManager = proxyManager;
    this.processCleaner = processCleaner;
    this.logger = logger;

    this.running = false;
    this.rotateRequested = false;
    this.currentProxy = null;
    this.currentProxyGeo = null;
    this.browser = null;
    this.lastRotationAtMs = 0;
    this.cycleCount = 0; // Đếm số chu kỳ chạy để tái tạo browser tránh rò rỉ bộ nhớ
    this.loopPromise = null;
    this.sleepHandle = null;
    this.sleepResolve = null;

    this.stats = {
      successCount: 0,
      failureCount: 0,
      blockedCount: 0,
      retries: 0,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop() {
    this.running = false;
    await this.closeBrowser();
    this.cancelLoopSleep();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.releaseCurrentProxy();
  }

  requestRotation() {
    this.rotateRequested = true;
  }

  getStatus() {
    return {
      accountId: this.accountId,
      targetUrl: this.targetUrl,
      scriptName: this.scriptName,
      running: this.running,
      proxy: this.currentProxy
        ? {
            id: this.currentProxy.id,
            host: this.currentProxy.host,
            port: this.currentProxy.port,
            username: this.currentProxy.username,
            geo: this.currentProxyGeo
          }
        : null,
      rotateRequested: this.rotateRequested,
      lastRotationAt: this.lastRotationAtMs
        ? new Date(this.lastRotationAtMs).toISOString()
        : null,
      stats: { ...this.stats }
    };
  }

  async loop() {
    while (this.running) {
      this.stats.lastRunAt = new Date().toISOString();
      try {
        await this.executeWithRetries();
      } catch (error) {
        this.stats.lastError = String(error?.message || error);
        this.logger.error("Task failed after retries", {
          accountId: this.accountId,
          error: this.stats.lastError
        });
      }
      if (!this.running) break;
      await this.sleepUntilNextCycle(this.config.runtime.taskIntervalMs);
    }
  }

  sleepUntilNextCycle(ms) {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepHandle = setTimeout(() => {
        this.sleepHandle = null;
        this.sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  cancelLoopSleep() {
    if (this.sleepHandle) {
      clearTimeout(this.sleepHandle);
      this.sleepHandle = null;
    }
    if (this.sleepResolve) {
      const resolve = this.sleepResolve;
      this.sleepResolve = null;
      resolve();
    }
  }

  async delay(ms) {
    await this.sleepUntilNextCycle(ms);
  }

  async executeWithRetries() {
    const maxRetries = this.config.runtime.maxRetries;
    const baseBackoff = this.config.runtime.retryBackoffMs;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      if (!this.running) return;
      try {
        await this.ensureBrowserReady();
        if (!this.running) return;

        const result = await this.runTask();
        this.stats.successCount += 1;
        this.stats.lastSuccessAt = new Date().toISOString();
        this.cycleCount += 1;

        if (this.currentProxy) {
          this.proxyManager.markSuccess(this.currentProxy.id);
        }

        this.logger.info("Task success", {
          accountId: this.accountId,
          scriptName: this.scriptName,
          proxyId: this.currentProxy?.id || null,
          activeProxyHost: this.currentProxy?.host || null,
          observedIp: this.currentProxyGeo?.ip || result?.observedIp || null,
          result: result
        });

        if (this.config.runtime.rotationMode === "perRequest") {
          this.rotateRequested = true;
        }
        return;
      } catch (error) {
        this.stats.failureCount += 1;
        this.stats.lastError = String(error?.message || error);

        if (isBlockedStatus(error.statusCode)) {
          this.stats.blockedCount += 1;
        }

        if (this.currentProxy) {
          this.proxyManager.markFailure(this.currentProxy.id, this.stats.lastError);
        }

        this.logger.warn("Task attempt failed", {
          accountId: this.accountId,
          attempt,
          proxyId: this.currentProxy?.id || null,
          error: this.stats.lastError
        });

        this.rotateRequested = true;
        await this.closeBrowser();

        if (attempt >= maxRetries) {
          throw error;
        }

        if (!this.running) return;
        this.stats.retries += 1;
        
        // Exponential Backoff: delay = baseBackoff * 2^(attempt - 1)
        const delayMs = baseBackoff * Math.pow(2, attempt - 1);
        this.logger.info(`Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`, { accountId: this.accountId });
        await this.delay(delayMs);
        if (!this.running) return;
      }
    }
  }

  shouldRotateNow() {
    if (this.rotateRequested || !this.currentProxy || !this.browser) return true;
    if (this.config.runtime.rotationMode === "perRequest") return true;

    // Kiểm tra xem đã đạt đến giới hạn số chu kỳ chạy của Browser để khởi động lại (Tránh Memory Leak)
    const maxCycles = this.config.browser.maxCyclesPerBrowser || 10;
    if (this.cycleCount >= maxCycles) {
      this.logger.info("Recreating browser to prevent memory leaks", {
        accountId: this.accountId,
        cycleCount: this.cycleCount,
        maxCycles
      });
      return true;
    }

    if (this.config.runtime.rotationMode === "interval") {
      const elapsedMs = Date.now() - this.lastRotationAtMs;
      return elapsedMs >= this.config.runtime.rotationIntervalMs;
    }
    return false;
  }

  async ensureBrowserReady() {
    if (this.shouldRotateNow()) {
      await this.rotateProxy();
    }
  }

  async rotateProxy() {
    const previousProxyId = this.currentProxy?.id || null;

    // Xem xét tái sử dụng lại Proxy cũ nếu chỉ muốn khởi động lại Browser do chống tràn bộ nhớ
    const canReuseProxy = this.currentProxy && 
      !this.rotateRequested && 
      this.config.runtime.rotationMode === "interval" &&
      (Date.now() - this.lastRotationAtMs < this.config.runtime.rotationIntervalMs) &&
      (this.cycleCount >= (this.config.browser.maxCyclesPerBrowser || 10));

    await this.closeBrowser();

    let nextProxy;
    if (canReuseProxy) {
      nextProxy = this.currentProxy;
      this.logger.info("Reusing current proxy for browser memory recycle", {
        accountId: this.accountId,
        proxyId: nextProxy.id
      });
    } else {
      this.releaseCurrentProxy();
      nextProxy = this.proxyManager.acquire(this.accountId);
      if (!nextProxy) {
        throw new Error("No available proxies. Add proxies via API before starting.");
      }
      this.currentProxy = nextProxy;
      this.lastRotationAtMs = Date.now();
    }

    this.rotateRequested = false;

    // 1. Quản lý Session & Profile: lưu riêng biệt theo accountId vào thư mục profiles/
    const userDataDir = path.join(
      process.cwd(),
      "profiles",
      this.accountId.replace(/[^a-zA-Z0-9_-]/g, "_")
    );
    fs.mkdirSync(userDataDir, { recursive: true });

    // 2. Tạo User-Agent ngẫu nhiên cho desktop
    const userAgentInstance = new UserAgent({ deviceCategory: "desktop" });
    const userAgent = userAgentInstance.toString();

    // 3. Cấu hình độ phân giải màn hình ngẫu nhiên
    const resolutions = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 1536, height: 864 },
      { width: 1280, height: 720 },
      { width: 1600, height: 900 }
    ];
    const resolution = resolutions[Math.floor(Math.random() * resolutions.length)];

    const args = [
      `--proxy-server=${this.currentProxy.host}:${this.currentProxy.port}`,
      `--window-size=${resolution.width},${resolution.height}`,
      `--window-position=0,0`,
      `--user-agent=${userAgent}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled"
    ];

    this.browser = await puppeteer.launch({
      headless: this.config.browser.headless,
      userDataDir,
      args
    });

    // Lưu lại tiến trình Chromium vào processCleaner
    const browserProcess = this.browser.process();
    if (browserProcess && browserProcess.pid) {
      this.processCleaner.register(browserProcess.pid);
    }

    // 4. Kiểm tra sức khoẻ Proxy & Lấy thông tin quốc gia/timezone thực tế
    let geo = null;
    const lookupPage = await this.browser.newPage();
    try {
      lookupPage.setDefaultNavigationTimeout(10000);
      await lookupPage.authenticate({
        username: this.currentProxy.username,
        password: this.currentProxy.password
      });

      const res = await lookupPage.goto("http://ip-api.com/json", {
        waitUntil: "domcontentloaded",
        timeout: 10000
      });

      if (res && res.status() === 200) {
        const bodyText = await lookupPage.evaluate(() => document.body.innerText);
        const parsed = JSON.parse(bodyText.trim());
        if (parsed && parsed.status === "success") {
          geo = {
            ip: parsed.query,
            country: parsed.country,
            countryCode: parsed.countryCode,
            timezone: parsed.timezone
          };
        }
      }
    } catch (err) {
      this.logger.warn("Primary GeoIP lookup via ip-api.com failed, attempting fallback", {
        accountId: this.accountId,
        error: err.message
      });
    } finally {
      if (lookupPage && !lookupPage.isClosed()) {
        await lookupPage.close().catch(() => {});
      }
    }

    // Fallback qua httpbin.org/ip nếu ip-api.com lỗi
    if (!geo) {
      const fallbackPage = await this.browser.newPage();
      try {
        fallbackPage.setDefaultNavigationTimeout(10000);
        await fallbackPage.authenticate({
          username: this.currentProxy.username,
          password: this.currentProxy.password
        });
        const res = await fallbackPage.goto("https://httpbin.org/ip", {
          waitUntil: "domcontentloaded",
          timeout: 10000
        });
        if (res && res.status() === 200) {
          const bodyText = await fallbackPage.evaluate(() => document.body.innerText);
          const parsed = JSON.parse(bodyText.trim());
          geo = {
            ip: parsed.origin,
            country: "Unknown",
            countryCode: "US",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
          };
        }
      } catch (err) {
        this.logger.error("Fallback GeoIP lookup failed. Proxy is likely dead.", {
          accountId: this.accountId,
          error: err.message
        });
        await this.closeBrowser();
        throw new Error(`Proxy health check & lookup failed: ${err.message}`);
      } finally {
        if (fallbackPage && !fallbackPage.isClosed()) {
          await fallbackPage.close().catch(() => {});
        }
      }
    }

    this.currentProxyGeo = geo;
    this.cycleCount = 0; // Khởi tạo lại chu kỳ chạy trên browser mới

    this.logger.info("Proxy rotated & ready", {
      accountId: this.accountId,
      fromProxyId: previousProxyId,
      toProxyId: this.currentProxy.id,
      ip: geo.ip,
      timezone: geo.timezone,
      country: geo.country
    });
  }

  async runTask() {
    if (!this.browser || !this.currentProxy) {
      throw new Error("Browser session not ready");
    }

    const page = await this.browser.newPage();
    page.setDefaultNavigationTimeout(this.config.browser.navigationTimeoutMs);

    try {
      await page.authenticate({
        username: this.currentProxy.username,
        password: this.currentProxy.password
      });

      // 5. Cấu hình Timezone khớp với Proxy IP
      if (this.currentProxyGeo && this.currentProxyGeo.timezone) {
        try {
          await page.emulateTimezone(this.currentProxyGeo.timezone);
        } catch (e) {
          this.logger.warn("Failed to set timezone", {
            timezone: this.currentProxyGeo.timezone,
            error: e.message
          });
        }
      }

      // Cấu hình ngôn ngữ (locale) phù hợp vị trí
      const languageHeader = this.currentProxyGeo && this.currentProxyGeo.countryCode === "VN"
        ? "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
        : "en-US,en;q=0.9";
      await page.setExtraHTTPHeaders({
        "Accept-Language": languageHeader
      });

      // 6. Nạp và thực thi Kịch bản (Plugin) động
      const scriptPath = path.isAbsolute(this.scriptName)
        ? this.scriptName
        : path.join(process.cwd(), "scripts", this.scriptName);

      if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script file not found: ${scriptPath}`);
      }

      // Xóa require cache để luôn lấy nội dung kịch bản mới nhất nếu người dùng sửa file
      delete require.cache[require.resolve(scriptPath)];
      const runScript = require(scriptPath);

      if (typeof runScript !== "function") {
        throw new Error(`Script at ${scriptPath} does not export a function.`);
      }

      // Thực thi kịch bản
      const result = await runScript(page, this, this.logger);
      return result || { success: true };
    } catch (error) {
      if (!error.statusCode && isProxyFailure(error)) {
        const proxyError = new Error(`Proxy failure: ${error.message}`);
        proxyError.statusCode = 407;
        throw proxyError;
      }
      throw error;
    } finally {
      try {
        await page.close();
      } catch (error) {
        this.logger.warn("Failed to close page cleanly", {
          accountId: this.accountId,
          error: String(error?.message || error)
        });
      }
    }
  }

  releaseCurrentProxy() {
    if (!this.currentProxy) return;
    this.proxyManager.release(this.accountId, this.currentProxy.id);
    this.currentProxy = null;
    this.currentProxyGeo = null;
  }

  async closeBrowser() {
    if (!this.browser) return;
    const browserRef = this.browser;
    this.browser = null;

    const browserProcess = browserRef.process();
    const pid = browserProcess?.pid;

    try {
      await browserRef.close();
    } catch (error) {
      this.logger.warn("Failed to close browser cleanly", {
        accountId: this.accountId,
        error: String(error?.message || error)
      });
      if (pid) {
        await this.processCleaner.killPid(pid);
      }
    } finally {
      if (pid) {
        this.processCleaner.unregister(pid);
      }
    }
  }
}

module.exports = { BrowserSession };
