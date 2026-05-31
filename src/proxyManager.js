const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

function parseProxyString(proxyString) {
  let raw = String(proxyString).trim();
  let protocol = "http"; // Mặc định là http

  // Trích xuất giao thức nếu có (ví dụ: socks5://)
  const protocolMatch = raw.match(/^([a-zA-Z0-9]+):\/\//);
  if (protocolMatch) {
    protocol = protocolMatch[1].toLowerCase();
    raw = raw.slice(protocolMatch[0].length);
  }

  let host, portRaw, username, password;

  if (raw.includes("@")) {
    // Định dạng: username:password@host:port
    const parts = raw.split("@");
    const credentials = parts[0].split(":");
    const hostPort = parts[1].split(":");

    username = credentials[0];
    password = credentials[1];
    host = hostPort[0];
    portRaw = hostPort[1];
  } else {
    // Định dạng: host:port:username:password
    const parts = raw.split(":");
    if (parts.length === 4) {
      [host, portRaw, username, password] = parts;
    } else if (parts.length === 2) {
      // Proxy không có xác thực (unauthenticated): host:port
      [host, portRaw] = parts;
      username = "";
      password = "";
    } else {
      throw new Error(
        `Invalid proxy format "${proxyString}". Expected IP:Port:Username:Password hoặc protocol://IP:Port:Username:Password`
      );
    }
  }

  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy host/port "${proxyString}"`);
  }

  const id = `${protocol}://${host}:${port}${username ? `:${username}` : ""}`;
  return {
    id,
    raw: proxyString,
    protocol,
    host,
    port,
    username,
    password,
    successCount: 0,
    failureCount: 0,
    inUseBy: null,
    lastUsedAt: null,
    lastFailedAt: null,
    disabledUntil: null,
    failuresByTarget: {} // Lưu lỗi theo từng targetUrl cụ thể
  };
}

function getAxiosAgent(proxy) {
  const protocol = proxy.protocol || "http";
  const authStr = proxy.username && proxy.password
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  const proxyUrl = `${protocol}://${authStr}${proxy.host}:${proxy.port}`;

  if (protocol.startsWith("socks")) {
    const agent = new SocksProxyAgent(proxyUrl);
    return { httpAgent: agent, httpsAgent: agent };
  } else if (protocol === "https") {
    const agent = new HttpsProxyAgent(proxyUrl);
    return { httpAgent: agent, httpsAgent: agent };
  } else {
    const agent = new HttpProxyAgent(proxyUrl);
    return { httpAgent: agent, httpsAgent: agent };
  }
}

async function checkProxyHealth(proxy, timeoutMs = 5000) {
  try {
    const agents = getAxiosAgent(proxy);
    // Gửi request siêu nhẹ đến httpbin để xác nhận proxy kết nối internet thành công
    const response = await axios.get("https://httpbin.org/ip", {
      ...agents,
      timeout: timeoutMs,
      validateStatus: () => true
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

function isProxyDisabledForTarget(proxy, targetUrl, nowMs) {
  // 1. Kiểm tra trạng thái cooldown chung
  if (proxy.disabledUntil) {
    const disabledUntilMs = Date.parse(proxy.disabledUntil);
    if (Number.isFinite(disabledUntilMs) && disabledUntilMs > nowMs) {
      return true;
    }
  }

  // 2. Kiểm tra trạng thái cooldown cụ thể cho targetUrl
  if (targetUrl && proxy.failuresByTarget && proxy.failuresByTarget[targetUrl]) {
    const targetStatus = proxy.failuresByTarget[targetUrl];
    if (targetStatus.disabledUntil) {
      const targetDisabledUntilMs = Date.parse(targetStatus.disabledUntil);
      if (Number.isFinite(targetDisabledUntilMs) && targetDisabledUntilMs > nowMs) {
        return true;
      }
    }
  }

  return false;
}

class ProxyManager {
  constructor({ logger }) {
    this.logger = logger;
    this.proxies = [];
    this.cursor = 0;
  }

  list() {
    return this.proxies.map((proxy) => ({
      id: proxy.id,
      raw: proxy.raw,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      successCount: proxy.successCount,
      failureCount: proxy.failureCount,
      inUseBy: proxy.inUseBy,
      lastUsedAt: proxy.lastUsedAt,
      lastFailedAt: proxy.lastFailedAt,
      disabledUntil: proxy.disabledUntil,
      failuresByTarget: proxy.failuresByTarget
    }));
  }

  listRaw() {
    return this.proxies.map((proxy) => proxy.raw);
  }

  add(proxyString) {
    const proxy = parseProxyString(proxyString);
    if (this.proxies.some((item) => item.id === proxy.id)) {
      return { added: false, reason: "duplicate", proxyId: proxy.id };
    }
    this.proxies.push(proxy);
    this.logger.info("Proxy added", { proxyId: proxy.id, protocol: proxy.protocol, host: proxy.host });
    return { added: true, proxyId: proxy.id };
  }

  addMany(proxyStrings) {
    const results = [];
    for (const proxyString of proxyStrings) {
      try {
        results.push(this.add(proxyString));
      } catch (error) {
        results.push({
          added: false,
          reason: error.message,
          proxy: proxyString
        });
      }
    }
    return results;
  }

  remove(proxyIdOrRaw) {
    const index = this.proxies.findIndex(
      (proxy) => proxy.id === proxyIdOrRaw || proxy.raw === proxyIdOrRaw
    );
    if (index === -1) {
      return { removed: false, reason: "not_found" };
    }

    const [removedProxy] = this.proxies.splice(index, 1);
    this.logger.info("Proxy removed", {
      proxyId: removedProxy.id,
      host: removedProxy.host
    });
    return { removed: true, proxyId: removedProxy.id };
  }

  async acquire(accountId, targetUrl = null) {
    if (this.proxies.length === 0) return null;
    const now = Date.now();

    // Lọc các proxy không bị cooldown chung hoặc cooldown riêng cho targetUrl đó
    const candidates = this.proxies.filter((proxy) => {
      if (isProxyDisabledForTarget(proxy, targetUrl, now)) return false;
      return !proxy.inUseBy || proxy.inUseBy === accountId;
    });

    if (candidates.length === 0) return null;

    let attempts = 0;
    while (attempts < candidates.length) {
      const index = (this.cursor + attempts) % candidates.length;
      const proxy = candidates[index];

      // Thực hiện kiểm tra chất lượng kết nối thực tế trước khi gán
      const isAlive = await checkProxyHealth(proxy);
      if (isAlive) {
        this.cursor = (index + 1) % candidates.length;
        proxy.inUseBy = accountId;
        proxy.lastUsedAt = new Date().toISOString();
        return proxy;
      } else {
        // Đánh dấu lỗi và tiếp tục tìm proxy khác
        this.markFailure(proxy.id, "Pre-flight health check failed", targetUrl);
        attempts += 1;
      }
    }

    return null;
  }

  release(accountId, proxyId) {
    const proxy = this.proxies.find((item) => item.id === proxyId);
    if (!proxy) return;
    if (proxy.inUseBy === accountId) {
      proxy.inUseBy = null;
    }
  }

  markSuccess(proxyId, targetUrl = null) {
    const proxy = this.proxies.find((item) => item.id === proxyId);
    if (!proxy) return;
    proxy.successCount += 1;
    proxy.failureCount = 0;
    proxy.disabledUntil = null;

    // Xóa cooldown cụ thể của targetUrl nếu thành công
    if (targetUrl && proxy.failuresByTarget && proxy.failuresByTarget[targetUrl]) {
      delete proxy.failuresByTarget[targetUrl];
    }
  }

  markFailure(proxyId, errorMessage, targetUrl = null) {
    const proxy = this.proxies.find((item) => item.id === proxyId);
    if (!proxy) return;

    proxy.failureCount += 1;
    proxy.lastFailedAt = new Date().toISOString();

    // Cooldown chung (exponential)
    const cooldownMs = Math.min(proxy.failureCount * 15000, 120000);
    proxy.disabledUntil = new Date(Date.now() + cooldownMs).toISOString();

    // Cooldown riêng theo targetUrl (exponential)
    if (targetUrl) {
      if (!proxy.failuresByTarget) {
        proxy.failuresByTarget = {};
      }
      if (!proxy.failuresByTarget[targetUrl]) {
        proxy.failuresByTarget[targetUrl] = { count: 0, disabledUntil: null };
      }

      const targetStatus = proxy.failuresByTarget[targetUrl];
      targetStatus.count += 1;
      const targetCooldownMs = Math.min(targetStatus.count * 30000, 600000); // Tối đa 10 phút
      targetStatus.disabledUntil = new Date(Date.now() + targetCooldownMs).toISOString();
    }

    this.logger.warn("Proxy marked failed", {
      proxyId,
      targetUrl,
      error: errorMessage,
      cooldownMs,
      failureCount: proxy.failureCount
    });
  }
}

module.exports = { ProxyManager, parseProxyString };
