import type { Page } from 'puppeteer';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { dirname, extname, join } from 'path';
import { mapPool, withRetry } from './util/retry';
import { ffmpegDownload, isStreamManifestUrl } from './ffmpeg-download';
import { downloadStream } from './hls-download';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export type AssetOptions = {
  /** Descargas simultáneas máximas (del curso entero, compartidas entre pestañas). */
  concurrency: number;
  /** Reintentos adicionales por recurso (HTTP 5xx/429, cortes de red, timeouts). */
  retries: number;
  /** Espera base del backoff exponencial en ms. */
  backoffMs: number;
  /** Timeout por intento en ms (los vídeos usan 5x). */
  timeoutMs: number;
  /** Referer a enviar. */
  referer: string;
  log?: (msg: string) => void;
};

export const DEFAULT_ASSET_OPTIONS: AssetOptions = {
  concurrency: 6,
  retries: 3,
  backoffMs: 500,
  timeoutMs: 45_000,
  referer: 'https://www.netacad.com/',
};

class PermanentError extends Error {
  permanent = true;
}

/** La URL resultó ser un manifiesto HLS/DASH (se baja con ffmpeg, no como archivo). */
class StreamManifestError extends PermanentError {}

const HTML_OK_EXT = new Set(['', '.html', '.htm', '.xhtml', '.php', '.aspx']);

function isPermanent(e: unknown): boolean {
  return !!(e && (e as { permanent?: boolean }).permanent);
}

/** Si la ruta tiene mayúsculas, devuelve la misma URL con la ruta en minúsculas. */
export function lowercasePathVariant(absUrl: string): string | null {
  try {
    const u = new URL(absUrl);
    const lower = u.pathname.toLowerCase();
    if (lower === u.pathname) return null;
    u.pathname = lower;
    return u.href;
  } catch {
    return null;
  }
}

async function fetchOnce(
  absUrl: string,
  dest: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const part = dest + '.part';
  try {
    const res = await fetch(absUrl, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      // 4xx (salvo 408/429) no mejora reintentando
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new PermanentError(msg);
      }
      throw new Error(msg);
    }
    if (!res.body) throw new Error('respuesta sin cuerpo');

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const ext = extname(new URL(absUrl).pathname).toLowerCase();
    if (ct.includes('text/html') && !HTML_OK_EXT.has(ext)) {
      // p. ej. la página de login/SPA devuelta en lugar del PDF/imagen
      throw new PermanentError('devolvió HTML en vez del recurso (¿sesión caducada?)');
    }

    if (/mpegurl|dash\+xml/.test(ct) && /\.(mp4|webm|m4v|mov)$/i.test(dest)) {
      await res.body.cancel().catch(() => undefined);
      throw new StreamManifestError('manifiesto de streaming');
    }

    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    const size = (await stat(part)).size;
    if (size === 0) throw new Error('archivo vacío (0 bytes)');
    const expected = Number(res.headers.get('content-length') || 0);
    const encoded = !!res.headers.get('content-encoding');
    if (expected > 0 && !encoded && size !== expected) {
      throw new Error(`descarga incompleta (${size}/${expected} bytes)`);
    }
    await rm(dest, { force: true });
    await rename(part, dest);
    return size;
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    if ((e as { name?: string })?.name === 'AbortError') {
      throw new Error(`timeout tras ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type AssetResult = { ok: boolean; error?: string; bytes?: number; attempts: number; auth?: boolean };

/** Descarga un recurso con reintentos/backoff, escritura atómica y comprobaciones. */
export async function downloadAsset(
  absUrl: string,
  dest: string,
  headers: Record<string, string>,
  opts: Pick<AssetOptions, 'retries' | 'backoffMs' | 'timeoutMs' | 'log'> & { referer?: string },
  /** Página con la sesión: los vídeos HLS se bajan con sus cookies (y desde el iframe si hace falta). */
  page?: Page
): Promise<AssetResult> {
  // ya existe y no está vacío (reanudación): no se vuelve a bajar
  try {
    const st = await stat(dest);
    if (st.isFile() && st.size > 0) return { ok: true, bytes: st.size, attempts: 0 };
  } catch {
    // no existe
  }

  const ext = extname(new URL(absUrl).pathname).toLowerCase();
  const destExt = extname(dest).toLowerCase();
  const isVideo = /^\.(mp4|webm|mov|m4v)$/.test(ext) || /^\.(mp4|webm|mov|m4v)$/.test(destExt);
  const timeoutMs = isVideo
    ? opts.timeoutMs * 15 // vídeos: ~11 min por intento
    : /^\.(zip|pka|pkz|pksz)$/.test(ext)
      ? opts.timeoutMs * 5
      : opts.timeoutMs;
  let attempts = 0;
  const attempt = async (url: string) =>
    withRetry(
      async () => {
        attempts++;
        return fetchOnce(url, dest, headers, timeoutMs);
      },
      {
        retries: opts.retries,
        baseMs: opts.backoffMs,
        shouldRetry: (e) => !isPermanent(e),
        onRetry: (e, n, wait) =>
          opts.log?.(
            `  · reintento ${n}/${opts.retries} de ${shortUrl(url)} en ${wait}ms (${errMsg(e)})`
          ),
      }
    );

  // HLS/DASH -> mp4 con ffmpeg
  const viaFfmpeg = async (url: string): Promise<AssetResult> => {
    try {
      const bytes = await withRetry(
        async () => {
          attempts++;
          if (page) return downloadStream(page, url, dest, { referer: opts.referer || headers.Referer || '', timeoutMs: timeoutMs, retries: opts.retries, log: opts.log });
          return ffmpegDownload(url, dest, headers);
        },
        {
          retries: Math.min(opts.retries, 1),
          baseMs: opts.backoffMs,
          shouldRetry: (e) => !isPermanent(e),
          onRetry: (e, n, wait) => opts.log?.(`  · reintento ${n} de ${shortUrl(url)} con ffmpeg en ${wait}ms (${errMsg(e)})`),
        }
      );
      return { ok: true, bytes, attempts };
    } catch (e) {
      return { ok: false, error: errMsg(e), attempts, auth: !!(e as { auth?: boolean }).auth };
    }
  };
  if (isStreamManifestUrl(absUrl) && /\.(mp4|webm|m4v|mov)$/i.test(dest)) return viaFfmpeg(absUrl);

  try {
    const bytes = await attempt(absUrl);
    return { ok: true, bytes, attempts };
  } catch (e) {
    if (e instanceof StreamManifestError) return viaFfmpeg(absUrl);
    // El servidor distingue mayúsculas: ciscoSansTT-Thin.woff2 -> ciscosanstt-thin.woff2
    const lower = lowercasePathVariant(absUrl);
    if (lower && /HTTP (404|403)/.test(errMsg(e))) {
      try {
        const bytes = await attempt(lower);
        return { ok: true, bytes, attempts };
      } catch (e2) {
        return { ok: false, error: errMsg(e2), attempts };
      }
    }
    return { ok: false, error: errMsg(e), attempts };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortUrl(u: string): string {
  return u.length > 90 ? u.slice(0, 87) + '…' : u;
}

export type AssetBatchResult = {
  failed: Map<string, string>; // ruta relativa -> motivo
  downloaded: number;
  reused: number;
};

/** Semáforo simple: limita las descargas simultáneas de TODO el curso (todas las pestañas). */
class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

type SharedState = {
  /** Descargas en curso por ruta: un asset compartido entre capítulos paralelos se baja UNA vez. */
  inflight: Map<string, Promise<boolean>>;
  gate: Semaphore;
};
// El estado compartido cuelga del Map `done` del curso (misma firma pública que antes).
const shared = new WeakMap<Map<string, boolean>, SharedState>();
function stateFor(done: Map<string, boolean>, concurrency: number): SharedState {
  let st = shared.get(done);
  if (!st) {
    st = { inflight: new Map(), gate: new Semaphore(Math.max(1, concurrency)) };
    shared.set(done, st);
  }
  return st;
}

// Cookies de sesión por navegador+origen con caducidad corta (evita una consulta CDP por capítulo).
const COOKIE_TTL_MS = 30_000;
const cookieCache = new WeakMap<object, Map<string, { at: number; value: Promise<string> }>>();

function cookieHeaderFor(page: Page, absUrl: string): Promise<string> {
  let origin = absUrl;
  try {
    origin = new URL(absUrl).origin;
  } catch {
    // se usa la URL completa
  }
  let owner: object = page;
  try {
    owner = page.browser();
  } catch {
    // página sin navegador: caché propia
  }
  let m = cookieCache.get(owner);
  if (!m) cookieCache.set(owner, (m = new Map()));
  const hit = m.get(origin);
  if (hit && Date.now() - hit.at < COOKIE_TTL_MS) return hit.value;
  const value = page
    .cookies(absUrl)
    .then((cs) => cs.map((c) => `${c.name}=${c.value}`).join('; '))
    .catch(() => '');
  m.set(origin, { at: Date.now(), value });
  return value;
}

/**
 * Descarga los recursos de un capítulo con concurrencia acotada.
 * `done` recuerda (entre capítulos del mismo curso) qué rutas ya se resolvieron;
 * `reasons` guarda el motivo de los fallos para el resumen.
 * Seguro con capítulos en paralelo: si otra pestaña ya está bajando el mismo
 * asset, se espera a ese resultado en vez de pedirlo de nuevo, y el total de
 * descargas simultáneas del curso está acotado por `opts.concurrency`.
 */
export async function downloadAssets(
  page: Page,
  assets: Record<string, string>,
  siteDir: string,
  done: Map<string, boolean>,
  opts: AssetOptions,
  reasons: Map<string, string> = new Map()
): Promise<AssetBatchResult> {
  const failed = new Map<string, string>();
  let downloaded = 0;
  let reused = 0;
  const st = stateFor(done, opts.concurrency);

  const todo: Array<[string, string]> = [];
  const resolvers = new Map<string, (ok: boolean) => void>();
  const foreign: Array<Promise<void>> = [];
  const seen = new Set<string>();
  for (const [absUrl, rel] of Object.entries(assets)) {
    if (seen.has(rel)) continue; // dos URLs que comparten ruta
    seen.add(rel);
    if (done.has(rel)) {
      reused++;
      if (!done.get(rel)) failed.set(rel, reasons.get(rel) ?? 'falló antes');
      continue;
    }
    const pending = st.inflight.get(rel);
    if (pending) {
      // otra pestaña ya lo está descargando: esperar su resultado
      foreign.push(
        pending.then((ok) => {
          reused++;
          if (!ok) failed.set(rel, reasons.get(rel) ?? 'falló antes');
        })
      );
      continue;
    }
    todo.push([absUrl, rel]);
    st.inflight.set(
      rel,
      new Promise<boolean>((resolve) => resolvers.set(rel, resolve))
    );
  }

  const mine = (async () => {
    const results = await mapPool(todo, opts.concurrency, async ([absUrl, rel]) => {
      try {
        const res = await st.gate.run(async () => {
          const cookie = await cookieHeaderFor(page, absUrl);
          return downloadAsset(
            absUrl,
            join(siteDir, rel),
            {
              'User-Agent': UA,
              Referer: opts.referer,
              ...(cookie ? { Cookie: cookie } : {}),
            },
            opts,
            page
          );
        });
        // publicar el resultado en cuanto se tiene (otros capítulos esperan por él)
        if (!res.ok) reasons.set(rel, `${res.error} (${shortUrl(absUrl)})`);
        done.set(rel, res.ok);
        st.inflight.delete(rel);
        resolvers.get(rel)?.(res.ok);
        return { absUrl, rel, res };
      } catch (e) {
        reasons.set(rel, `${errMsg(e)} (${shortUrl(absUrl)})`);
        done.set(rel, false);
        st.inflight.delete(rel);
        resolvers.get(rel)?.(false);
        throw e;
      }
    });

    for (let i = 0; i < results.length; i++) {
      const [, rel] = todo[i];
      const r = results[i];
      if (r.ok) {
        const res = r.value.res;
        if (res.ok) {
          if (res.attempts === 0) reused++; // ya estaba en disco
          else downloaded++;
        } else failed.set(rel, reasons.get(rel) ?? res.error ?? 'error');
      } else {
        failed.set(rel, reasons.get(rel) ?? errMsg(r.error));
      }
    }
  })();

  await Promise.all([mine, ...foreign]);
  return { failed, downloaded, reused };
}
