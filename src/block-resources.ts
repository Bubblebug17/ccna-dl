import type { Page } from 'puppeteer';

/**
 * Recursos que no aportan al HTML offline: analítica, publicidad y seguimiento.
 * Se bloquean a nivel de red del navegador con CDP `Network.setBlockedURLs`
 * (no con page.setRequestInterception, que desactiva la caché del navegador).
 * NO se bloquean CSS, fuentes, imágenes ni scripts del propio sitio, ni el
 * banner de cookies (OneTrust): el layout y la detección de carga dependen de ellos.
 */
export const TRACKER_PATTERNS = [
  '*google-analytics.com*',
  '*googletagmanager.com*',
  '*doubleclick.net*',
  '*googlesyndication.com*',
  '*googleadservices.com*',
  '*connect.facebook.net*',
  '*facebook.com/tr*',
  '*hotjar.com*',
  '*clarity.ms*',
  '*bat.bing.com*',
  '*snap.licdn.com*',
  '*px.ads.linkedin.com*',
  '*analytics.twitter.com*',
  '*static.ads-twitter.com*',
  '*fullstory.com*',
  '*mixpanel.com*',
  '*omtrdc.net*',
  '*demdex.net*',
];

/** Solo con --fast: vídeo/audio (se bajan aparte con fetch) y el gestor de etiquetas de Adobe. */
export const AGGRESSIVE_PATTERNS = ['*.mp4*', '*.webm*', '*.mp3*', '*.m4a*', '*adobedtm.com*'];

export type BlockStats = { blocked: number };

/**
 * Activa el bloqueo en `page`. Devuelve un contador vivo de peticiones bloqueadas
 * (net::ERR_BLOCKED_BY_CLIENT) o null si no se pudo activar (nunca lanza).
 */
export async function blockUnneededResources(
  page: Page,
  patterns: string[]
): Promise<BlockStats | null> {
  if (patterns.length === 0) return null;
  const stats: BlockStats = { blocked: 0 };
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: patterns });
    const globs = patterns.map(
      (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
    );
    page.on('requestfailed', (req) => {
      // en iframes puppeteer a veces no informa del motivo: se compara también con los patrones
      const why = req.failure()?.errorText ?? '';
      if (why.includes('BLOCKED_BY_CLIENT') || (!why && globs.some((re) => re.test(req.url())))) stats.blocked++;
    });
    return stats;
  } catch {
    return null;
  }
}
