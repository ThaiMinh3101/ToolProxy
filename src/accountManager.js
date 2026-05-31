const { BrowserSession } = require("./browserSession");

class AccountManager {
  constructor({ config, proxyManager, processCleaner, logger }) {
    this.config = config;
    this.proxyManager = proxyManager;
    this.processCleaner = processCleaner;
    this.logger = logger;
    this.sessions = new Map();
  }

  addAccount({ accountId, targetUrl, scriptName }) {
    if (!accountId) {
      throw new Error("accountId is required");
    }
    if (this.sessions.has(accountId)) {
      throw new Error(`Account "${accountId}" already exists`);
    }

    const session = new BrowserSession({
      accountId,
      targetUrl,
      scriptName,
      config: this.config,
      proxyManager: this.proxyManager,
      processCleaner: this.processCleaner,
      logger: this.logger
    });

    this.sessions.set(accountId, session);
    this.logger.info("Account added", {
      accountId,
      targetUrl: session.targetUrl,
      scriptName: session.scriptName
    });
    return session.getStatus();
  }

  async removeAccount(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) {
      return false;
    }

    await session.stop();
    this.sessions.delete(accountId);
    this.logger.info("Account removed", { accountId });
    return true;
  }

  startAccount(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) {
      throw new Error(`Unknown account "${accountId}"`);
    }
    session.start();
    this.logger.info("Account started", { accountId });
    return session.getStatus();
  }

  async stopAccount(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) {
      throw new Error(`Unknown account "${accountId}"`);
    }
    await session.stop();
    this.logger.info("Account stopped", { accountId });
    return session.getStatus();
  }

  rotateAccount(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) {
      throw new Error(`Unknown account "${accountId}"`);
    }
    session.requestRotation();
    this.logger.info("Manual rotation requested", { accountId });
    return session.getStatus();
  }

  rotateAll() {
    for (const session of this.sessions.values()) {
      session.requestRotation();
    }
    this.logger.info("Manual rotation requested for all accounts");
    return this.getStatuses();
  }

  getStatuses() {
    return Array.from(this.sessions.values()).map((session) => session.getStatus());
  }

  listPersistableAccounts() {
    return this.getStatuses().map((status) => ({
      accountId: status.accountId,
      targetUrl: status.targetUrl,
      scriptName: status.scriptName,
      running: status.running
    }));
  }

  hasAccount(accountId) {
    return this.sessions.has(accountId);
  }

  async stopAll() {
    const tasks = [];
    for (const session of this.sessions.values()) {
      tasks.push(session.stop());
    }
    await Promise.all(tasks);
  }
}

module.exports = { AccountManager };
