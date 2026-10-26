/**
 * Configuración de puppeteer. En Termux (Android) no hay Chrome descargable para Android/arm64:
 * se omite la descarga y se usa el Chromium del sistema (pkg install chromium).
 * También se omite con PUPPETEER_SKIP_DOWNLOAD=1 (o PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1).
 */
const env = process.env;
const termux =
  env.CCNA_DL_TERMUX === '1' ||
  (env.CCNA_DL_TERMUX !== '0' && (process.platform === 'android' || !!env.TERMUX_VERSION || /com\.termux/.test(env.PREFIX || '')));
const truthy = (v) => !!v && v !== '0' && v !== 'false';

module.exports = {
  skipDownload: termux || truthy(env.PUPPETEER_SKIP_DOWNLOAD) || truthy(env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD),
};
