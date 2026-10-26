import type { Page } from 'puppeteer';

/**
 * Contexto de autenticación de los manifiestos de vídeo (HLS/DASH) tal y como los pidió el reproductor:
 * Referer/Origin reales de la petición y URL del iframe que la hizo. Se rellena al capturar los
 * reproductores (capture-videos) y se usa al descargar (hls-download) para pedir el m3u8 y los
 * segmentos "como el navegador". Nunca se escribe en logs (las cabeceras pueden llevar tokens).
 */
export type StreamSniff = { referer?: string; origin?: string; frameUrl?: string; at: number };

const MAX = 300;
const registry = new Map<string, StreamSniff>();

const keyOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname; // sin query: un token nuevo no cambia la identidad del vídeo
  } catch {
    return url;
  }
};

export function rememberStream(url: string, sniff: Omit<StreamSniff, 'at'>): void {
  const k = keyOf(url);
  registry.delete(k);
  registry.set(k, { ...sniff, at: Date.now() });
  while (registry.size > MAX) registry.delete(registry.keys().next().value as string);
}

export function streamSniff(url: string): StreamSniff | undefined {
  return registry.get(keyOf(url));
}

/** Referencia ESTABLE de un vídeo de Netacad: /videos/<id>/versions/<v>/locales/<loc>/… (sin tokens ni host). */
export type VideoRef = { file: string; videoId?: string; version?: string; locale?: string; index?: number };

export function videoRefFromUrl(url: string, file: string): VideoRef {
  const ref: VideoRef = { file };
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\/videos\/([^/]+)\/versions\/([^/]+)\/locales\/([^/]+)\//i);
    if (m) Object.assign(ref, { videoId: m[1], version: m[2], locale: m[3] });
    else {
      const base = p.split('/').pop() || '';
      const id = base.replace(/\.[a-z0-9]+$/i, '');
      if (id) ref.videoId = id;
    }
  } catch {
    // URL rara: solo el archivo
  }
  return ref;
}

/** Cabeceras de la sesión ACTUAL para una URL: cookies frescas de esa URL (ruta incluida), UA real, Referer/Origin del reproductor. */
export async function sessionHeadersFor(page: Page, url: string, fallbackReferer: string): Promise<Record<string, string>> {
  const sniff = streamSniff(url);
  const h: Record<string, string> = {};
  try {
    h['User-Agent'] = await page.browser().userAgent();
  } catch {
    // sin navegador
  }
  const referer = sniff?.referer || sniff?.frameUrl || fallbackReferer;
  if (referer) h.Referer = referer;
  if (sniff?.origin) h.Origin = sniff.origin;
  try {
    const cs = await page.cookies(url);
    if (cs.length) h.Cookie = cs.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    // sin cookies
  }
  return h;
}
