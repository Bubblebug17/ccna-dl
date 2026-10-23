import type { Page } from 'puppeteer';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { dirname, extname, join } from 'path';
import { mapPool, withRetry } from './util/retry';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export type AssetOptions = {
  /** Descargas simultáneas máximas (por capítulo). */
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

export type AssetResult = { ok: boolean; error?: string; bytes?: number; attempts: number };

/** Descarga un recurso con reintentos/backoff, escritura atómica y comprobaciones. */
export async function downloadAsset(
  absUrl: string,
  dest: string,
  headers: Record<string, string>,
  opts: Pick<AssetOptions, 'retries' | 'backoffMs' | 'timeoutMs' | 'log'>
): Promise<AssetResult> {
  // ya existe y no está vacío (reanudación): no se vuelve a bajar
  try {
    const st = await stat(dest);
    if (st.isFile() && st.size > 0) return { ok: true, bytes: st.size, attempts: 0 };
  } catch {
    // no existe
  }

  const ext = extname(new URL(absUrl).pathname).toLowerCase();
  const timeoutMs = /\.(mp4|webm|mov|m4v|zip|pka|pkz|pksz)$/.test(ext)
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

  try {
    const bytes = await attempt(absUrl);
    return { ok: true, bytes, attempts };
  } catch (e) {
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

/**
 * Descarga los recursos de un capítulo con concurrencia acotada.
 * `done` recuerda (entre capítulos del mismo curso) qué rutas ya se resolvieron;
 * `reasons` guarda el motivo de los fallos para el resumen.
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

  const todo: Array<[string, string]> = [];
  for (const [absUrl, rel] of Object.entries(assets)) {
    if (done.has(rel)) {
      reused++;
      if (!done.get(rel)) failed.set(rel, reasons.get(rel) ?? 'falló antes');
      continue;
    }
    todo.push([absUrl, rel]);
    done.set(rel, false); // reserva: evita duplicar si dos URLs comparten ruta
  }

  // cookies de sesión por origen (una sola consulta CDP por origen)
  const cookieByOrigin = new Map<string, string>();
  const cookieFor = async (absUrl: string): Promise<string> => {
    let origin = absUrl;
    try {
      origin = new URL(absUrl).origin;
    } catch {
      // se usa la URL completa
    }
    if (!cookieByOrigin.has(origin)) {
      const cookies = await page.cookies(absUrl).catch(() => []);
      cookieByOrigin.set(origin, cookies.map((c) => `${c.name}=${c.value}`).join('; '));
    }
    return cookieByOrigin.get(origin) ?? '';
  };

  const results = await mapPool(todo, opts.concurrency, async ([absUrl, rel]) => {
    const cookie = await cookieFor(absUrl);
    const res = await downloadAsset(
      absUrl,
      join(siteDir, rel),
      {
        'User-Agent': UA,
        Referer: opts.referer,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      opts
    );
    return { absUrl, rel, res };
  });

  for (let i = 0; i < results.length; i++) {
    const [absUrl, rel] = todo[i];
    const r = results[i];
    const res = r.ok ? r.value.res : { ok: false, error: errMsg(r.error), attempts: 0 };
    done.set(rel, res.ok);
    if (res.ok) {
      if (res.attempts === 0) reused++; // ya estaba en disco
      else downloaded++;
    } else {
      const reason = `${res.error} (${shortUrl(absUrl)})`;
      reasons.set(rel, reason);
      failed.set(rel, reason);
    }
  }
  return { failed, downloaded, reused };
}
