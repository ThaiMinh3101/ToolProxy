const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

class ProcessCleaner {
  constructor({ logger }) {
    this.logger = logger;
    this.activePids = new Set();
  }

  register(pid) {
    if (pid) {
      this.activePids.add(pid);
    }
  }

  unregister(pid) {
    if (pid) {
      this.activePids.delete(pid);
    }
  }

  async cleanOrphans() {
    const isWindows = process.platform === "win32";
    this.logger.info("Scanning and cleaning up orphaned Chromium processes...");
    try {
      if (isWindows) {
        // Sử dụng PowerShell để tìm và giết các tiến trình chrome.exe có CommandLine chứa tool-proxy hoặc profiles
        const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*tool-proxy*' -or $_.CommandLine -like '*profiles*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;
        await execPromise(cmd);
      } else {
        // Trên Linux/Docker, tìm kiếm chrome/chromium chạy với profile của tool
        const cmd = `pkill -9 -f "chrome.*(tool-proxy|profiles)" || true`;
        await execPromise(cmd);
      }
      this.logger.info("Orphaned process cleanup completed.");
    } catch (error) {
      // Nhận lỗi nếu không tìm thấy tiến trình nào phù hợp (đây là bình thường)
      this.logger.debug("No orphaned processes needed cleaning or cleanup returned status", {
        error: String(error?.message || error)
      });
    }
  }

  async killPid(pid) {
    if (!pid) return;
    try {
      process.kill(pid, "SIGKILL");
      this.logger.debug(`Killed process PID: ${pid}`);
    } catch (error) {
      // Bỏ qua nếu tiến trình đã chết
    }
    this.activePids.delete(pid);
  }

  async cleanAllActive() {
    if (this.activePids.size === 0) return;
    this.logger.info("Killing all registered active browser processes...", {
      count: this.activePids.size
    });
    for (const pid of this.activePids) {
      await this.killPid(pid);
    }
  }
}

module.exports = { ProcessCleaner };
