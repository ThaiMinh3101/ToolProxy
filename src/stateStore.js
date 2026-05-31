const fs = require("fs");
const path = require("path");

class StateStore {
  constructor({ enabled, filePath, logger }) {
    this.enabled = Boolean(enabled);
    this.filePath = filePath;
    this.logger = logger;
  }

  load() {
    if (!this.enabled) return null;
    if (!fs.existsSync(this.filePath)) return null;

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw);
      return {
        proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        savedAt: parsed.savedAt || null
      };
    } catch (error) {
      this.logger.warn("Failed to load persisted state", {
        filePath: this.filePath,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  save(state, reason = "update") {
    if (!this.enabled) return false;
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      reason,
      proxies: Array.isArray(state?.proxies) ? state.proxies : [],
      accounts: Array.isArray(state?.accounts) ? state.accounts : []
    };

    const dir = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, this.filePath);
    return true;
  }
}

module.exports = { StateStore };
