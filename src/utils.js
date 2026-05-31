function isBlockedStatus(statusCode) {
  return statusCode === 403 || statusCode === 429;
}

function isProxyFailure(error) {
  const message = String(error?.message || "");
  return (
    message.includes("ERR_PROXY_CONNECTION_FAILED") ||
    message.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
    message.includes("net::ERR_NO_SUPPORTED_PROXIES") ||
    message.includes("Proxy Authentication Required") ||
    message.includes("SOCKS") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT")
  );
}

function extractIpFromText(text) {
  const matched = String(text).match(
    /\b((25[0-5]|2[0-4]\d|1?\d?\d)(\.(?!$)|$)){4}\b/
  );
  return matched ? matched[0] : null;
}

module.exports = {
  isBlockedStatus,
  isProxyFailure,
  extractIpFromText
};
