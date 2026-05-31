function dashboard() {
  return {
    // State xác thực
    apiKey: localStorage.getItem("tool_proxy_api_key") || "",
    apiKeyInput: localStorage.getItem("tool_proxy_api_key") || "",
    showAuthModal: false,
    sseConnected: false,

    // Form inputs
    singleProxyInput: "",
    bulkProxyInput: "",
    accountForm: {
      accountId: "",
      targetUrl: "",
      scriptName: "defaultTask.js",
      autostart: true
    },

    // Dữ liệu hiển thị
    stats: {
      uptimeSec: 0,
      rotationMode: "-",
      taskIntervalMs: 0
    },
    proxies: [],
    sessions: [],
    logs: [],

    // Cấu hình hiển thị Logs
    logLimit: 150,
    autoRefreshLogs: true,
    scopeCurrentOnly: true,
    selectedLogLevel: "ALL", // ALL, INFO, WARN, ERROR

    // Toast feedback
    toast: {
      show: false,
      message: "",
      type: "success" // success, error
    },

    // SSE Instance
    eventSource: null,
    reconnectTimer: null,

    init() {
      // Tự động mở modal auth nếu chưa cài đặt API Key
      // (Nhưng chỉ khi API yêu cầu, ở đây ta để người dùng tự do cấu hình)
      this.refreshDashboard();
      this.initSSE();

      // Cập nhật Uptime và chỉ số định kỳ nếu mất kết nối SSE
      setInterval(() => {
        if (!this.sseConnected) {
          this.refreshDashboard().catch(() => {});
        } else {
          // Nếu có SSE, chỉ tăng uptime thủ công để mượt giao diện
          this.stats.uptimeSec += 1;
        }
      }, 1000);
    },

    showToast(message, type = "success") {
      this.toast.message = message;
      this.toast.type = type;
      this.toast.show = true;
      setTimeout(() => {
        this.toast.show = false;
      }, 3000);
    },

    saveApiKey() {
      this.apiKey = this.apiKeyInput.trim();
      localStorage.setItem("tool_proxy_api_key", this.apiKey);
      this.showAuthModal = false;
      this.showToast("API Key đã được lưu thành công.");
      this.refreshDashboard();
      this.initSSE();
    },

    initSSE() {
      if (this.eventSource) {
        this.eventSource.close();
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }

      const url = `/api/events?apiKey=${encodeURIComponent(this.apiKey)}`;
      this.eventSource = new EventSource(url);

      this.eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "connected") {
            this.sseConnected = true;
          } else if (payload.type === "status") {
            this.sseConnected = true;
            this.stats.uptimeSec = payload.data.health.uptimeSec;
            this.stats.rotationMode = payload.data.health.rotationMode;
            this.stats.taskIntervalMs = payload.data.health.taskIntervalMs || this.stats.taskIntervalMs;
            this.sessions = payload.data.sessions;
          } else if (payload.type === "log") {
            this.handleIncomingLog(payload.data);
          }
        } catch (e) {
          console.error("Lỗi parse SSE event data:", e);
        }
      };

      this.eventSource.onerror = () => {
        this.sseConnected = false;
        this.eventSource.close();
        // Thử kết nối lại sau 5 giây
        this.reconnectTimer = setTimeout(() => {
          this.initSSE();
        }, 5000);
      };
    },

    handleIncomingLog(logEntry) {
      // Lọc theo chế độ "Phiên hiện tại"
      if (this.scopeCurrentOnly && logEntry.ts) {
        // Chỉ lưu log từ thời điểm trang tải hoặc start
      }

      this.logs.push(logEntry);
      
      // Giới hạn số lượng log lưu trữ ở frontend
      if (this.logs.length > this.logLimit) {
        this.logs = this.logs.slice(-this.logLimit);
      }

      if (this.autoRefreshLogs) {
        this.$nextTick(() => {
          const el = document.getElementById("logOutput");
          if (el) {
            el.scrollTop = el.scrollHeight;
          }
        });
      }
    },

    async api(path, options = {}) {
      const headers = {
        "Content-Type": "application/json",
        ...options.headers
      };

      if (this.apiKey) {
        headers["x-api-key"] = this.apiKey;
      }

      const response = await fetch(path, { ...options, headers });
      const body = await response.json().catch(() => ({}));

      if (!response.ok || body.ok === false) {
        const errorMsg = body.error || `HTTP ${response.status}: Lỗi máy chủ`;
        if (response.status === 401) {
          this.showAuthModal = true;
        }
        throw new Error(errorMsg);
      }

      return body;
    },

    async refreshDashboard() {
      try {
        const [health, runtime, proxies, sessions] = await Promise.all([
          this.api("/health"),
          this.api("/runtime"),
          this.api("/proxies"),
          this.api("/sessions")
        ]);

        this.stats.uptimeSec = health.uptimeSec;
        this.stats.rotationMode = runtime.data?.rotationMode || health.rotationMode;
        this.stats.taskIntervalMs = runtime.data?.taskIntervalMs;
        this.proxies = proxies.data || [];
        this.sessions = sessions.data || [];

        this.refreshLogs();
      } catch (error) {
        console.error("Lỗi đồng bộ dữ liệu dashboard:", error);
      }
    },

    async refreshLogs() {
      try {
        const scope = this.scopeCurrentOnly ? "current" : "all";
        const res = await this.api(`/logs/recent?limit=${this.logLimit}&scope=${scope}`);
        this.logs = res.data || [];

        if (this.autoRefreshLogs) {
          this.$nextTick(() => {
            const el = document.getElementById("logOutput");
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
      } catch (error) {
        console.error("Lỗi lấy danh sách logs mới nhất:", error);
      }
    },

    async addSingleProxy() {
      const proxyStr = this.singleProxyInput.trim();
      if (!proxyStr) return;

      try {
        await this.api("/proxies", {
          method: "POST",
          body: JSON.stringify({ proxy: proxyStr })
        });
        this.singleProxyInput = "";
        this.showToast("Đã thêm proxy thành công.");
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async addBulkProxies() {
      const raw = this.bulkProxyInput.trim();
      if (!raw) return;

      const proxiesList = raw
        .split(/\n|,/g)
        .map((item) => item.trim())
        .filter(Boolean);

      if (proxiesList.length === 0) return;

      try {
        const res = await this.api("/proxies", {
          method: "POST",
          body: JSON.stringify({ proxies: proxiesList })
        });

        const addedCount = res.data.filter((item) => item.added).length;
        this.bulkProxyInput = "";
        this.showToast(`Import thành công ${addedCount}/${proxiesList.length} proxy.`);
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async removeProxy(proxyId) {
      try {
        await this.api("/proxies", {
          method: "DELETE",
          body: JSON.stringify({ proxyIdOrRaw: proxyId })
        });
        this.showToast("Đã xóa proxy.");
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async addAccount() {
      const { accountId, targetUrl, scriptName, autostart } = this.accountForm;
      if (!accountId.trim()) return;

      try {
        await this.api("/accounts", {
          method: "POST",
          body: JSON.stringify({
            accountId: accountId.trim(),
            targetUrl: targetUrl.trim() || undefined,
            scriptName: scriptName,
            autostart
          })
        });

        this.accountForm.accountId = "";
        this.accountForm.targetUrl = "";
        this.showToast(`Tài khoản "${accountId}" đã được thêm.`);
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async startAccount(accountId) {
      try {
        await this.api(`/accounts/${encodeURIComponent(accountId)}/start`, { method: "POST" });
        this.showToast(`Đã khởi chạy session ${accountId}.`);
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async stopAccount(accountId) {
      try {
        await this.api(`/accounts/${encodeURIComponent(accountId)}/stop`, { method: "POST" });
        this.showToast(`Đã dừng session ${accountId}.`);
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async rotateAccount(accountId) {
      try {
        await this.api(`/accounts/${encodeURIComponent(accountId)}/rotate`, { method: "POST" });
        this.showToast(`Đã yêu cầu xoay proxy cho ${accountId}.`);
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async removeAccount(accountId) {
      if (!confirm(`Bạn có chắc chắn muốn xóa tài khoản "${accountId}" không?`)) return;

      try {
        await this.api(`/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
        this.showToast(`Đã xóa tài khoản ${accountId}.`);
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async rotateAll() {
      try {
        await this.api("/rotate", { method: "POST" });
        this.showToast("Đã gửi yêu cầu xoay proxy cho tất cả tài khoản.");
        this.refreshDashboard();
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    async clearLogs() {
      try {
        await this.api("/logs", { method: "DELETE" });
        this.logs = [];
        this.showToast("Logs hệ thống đã được dọn sạch.");
      } catch (error) {
        this.showToast(error.message, "error");
      }
    },

    // Helpers định dạng dữ liệu
    fmtSec(sec) {
      if (!Number.isFinite(sec)) return "-";
      if (sec < 60) return `${Math.floor(sec)}s`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
      return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    },

    fmtDate(iso) {
      if (!iso) return "-";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "-";
      return date.toLocaleString();
    },

    fmtTime(iso) {
      if (!iso) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      return date.toTimeString().split(" ")[0];
    },

    isProxyCoolingDown(proxy) {
      if (!proxy.disabledUntil) return false;
      const disabledUntilMs = Date.parse(proxy.disabledUntil);
      return Number.isFinite(disabledUntilMs) && disabledUntilMs > Date.now();
    },

    getLogLevelColor(level) {
      const lvl = String(level).toLowerCase();
      if (lvl === "error") return "text-rose-500";
      if (lvl === "warn") return "text-amber-500";
      if (lvl === "debug") return "text-purple-400";
      return "text-indigo-400";
    },

    getLogMeta(log) {
      const extra = { ...log };
      delete extra.ts;
      delete extra.level;
      delete extra.message;
      if (Object.keys(extra).length === 0) return "";
      return JSON.stringify(extra);
    },

    // Computed property lọc logs
    get filteredLogs() {
      if (this.selectedLogLevel === "ALL") {
        return this.logs;
      }
      return this.logs.filter((log) => String(log.level).toUpperCase() === this.selectedLogLevel);
    }
  };
}
