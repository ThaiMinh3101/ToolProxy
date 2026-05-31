/**
 * Kịch bản mẫu: Truy cập YouTube, cuộn trang xem nội dung.
 * @param {import('puppeteer').Page} page
 * @param {object} session
 * @param {object} logger
 */
module.exports = async function run(page, session, logger) {
  logger.info("Starting viewYoutube task", { accountId: session.accountId });

  await page.goto("https://www.youtube.com", {
    waitUntil: "domcontentloaded",
    timeout: session.config.browser.navigationTimeoutMs
  });

  const title = await page.title();
  logger.info("YouTube loaded", { title });

  // Cuộn trang giả lập tương tác của người dùng thật
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.documentElement.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= 500 || totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });

  logger.info("YouTube: Đã cuộn trang mô phỏng tương tác người dùng thành công");
  return { success: true, status: "scrolled", title };
};
