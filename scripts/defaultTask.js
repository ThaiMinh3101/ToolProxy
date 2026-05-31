const { extractIpFromText, isBlockedStatus } = require("../src/utils");

/**
 * Kịch bản mặc định: truy cập targetUrl và trích xuất IP hiển thị trên trang.
 * @param {import('puppeteer').Page} page
 * @param {object} session
 * @param {object} logger
 */
module.exports = async function run(page, session, logger) {
  const response = await page.goto(session.targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: session.config.browser.navigationTimeoutMs
  });

  const statusCode = response ? response.status() : 0;
  if (isBlockedStatus(statusCode)) {
    const blockedError = new Error(`Blocked request with status ${statusCode}`);
    blockedError.statusCode = statusCode;
    throw blockedError;
  }

  const bodyText = await page.evaluate(() =>
    (document.body ? document.body.innerText : "").trim().slice(0, 500)
  );
  const observedIp = extractIpFromText(bodyText);

  return {
    statusCode,
    observedIp,
    bodySnippet: bodyText
  };
};
