const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  const logPath = path.join(process.cwd(), 'crash.txt');
  fs.writeFileSync(logPath, err.stack || err.toString());
});

// Start the Express backend
require('./src/index.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    title: 'Tool Proxy Automation',
    autoHideMenuBar: true, // Hide the default menu bar
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Optional: Remove default menu
  Menu.setApplicationMenu(null);

  // Poll until the local Express server is ready
  const checkServer = setInterval(() => {
    axios.get('http://127.0.0.1:3000/health')
      .then(() => {
        clearInterval(checkServer);
        mainWindow.loadURL('http://127.0.0.1:3000');
      })
      .catch(() => {
        // Retry logic: keep waiting for the server to spin up
      });
  }, 500);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Gracefully shutdown the app and any running Puppeteer instances
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Since the Express server might also try to catch SIGINT/SIGTERM, Electron's app.quit() is generally enough
// because process.on('SIGINT', shutdown) is registered in src/index.js.
