const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configures Puppeteer to download the browser inside the project directory
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
