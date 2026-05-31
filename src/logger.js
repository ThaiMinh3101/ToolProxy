const fs = require("fs");
const path = require("path");

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.listeners = new Set();
  }

  onLog(callback) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  write(level, message, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...meta
    };
    const line = JSON.stringify(entry);
    process.stdout.write(`${line}\n`);
    fs.appendFileSync(this.filePath, `${line}\n`);

    // Gửi log đến các bên đăng ký (SSE)
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        // Bỏ qua lỗi ghi log sse
      }
    }
  }

  debug(message, meta) {
    this.write("debug", message, meta);
  }

  info(message, meta) {
    this.write("info", message, meta);
  }

  warn(message, meta) {
    this.write("warn", message, meta);
  }

  error(message, meta) {
    this.write("error", message, meta);
  }
}

module.exports = { Logger };
