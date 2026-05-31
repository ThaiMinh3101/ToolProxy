/**
 * Kịch bản mẫu: Truy cập Facebook, kiểm tra trạng thái đăng nhập.
 * @param {import('puppeteer').Page} page
 * @param {object} session
 * @param {object} logger
 */
module.exports = async function run(page, session, logger) {
  logger.info("Starting loginFacebook task", { accountId: session.accountId });
  
  await page.goto("https://www.facebook.com", {
    waitUntil: "domcontentloaded",
    timeout: session.config.browser.navigationTimeoutMs
  });

  const title = await page.title();
  logger.info("Facebook loaded", { title });

  // Kiểm tra xem đã đăng nhập chưa
  const isLoggedIn = await page.evaluate(() => {
    return !!document.querySelector('[role="navigation"]') || !!document.querySelector('#userNav');
  });

  if (isLoggedIn) {
    logger.info("Facebook: Đã đăng nhập trước đó (Session restored!)", { accountId: session.accountId });
    return { success: true, status: "logged_in", title };
  }

  logger.info("Facebook: Chưa đăng nhập. Sẵn sàng nhập tài khoản.", { accountId: session.accountId });
  // Ở đây bạn có thể cấu hình nhập liệu tài khoản:
  // await page.type('#email', 'tài_khoản_của_bạn');
  // await page.type('#pass', 'mật_khẩu_của_bạn');
  // await page.click('[name="login"]');

  return { success: true, status: "login_page_loaded", title };
};
