import { delay } from './promise';

export type RetryOptions = {
  /** Reintentos adicionales tras el primer intento. */
  retries?: number;
  /** Espera base en ms; se duplica en cada reintento (con algo de jitter). */
  baseMs?: number;
  maxMs?: number;
  /** Devuelve false para NO reintentar (p. ej. un 404). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
};

export function backoffMs(attempt: number, baseMs = 500, maxMs = 8000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/** Ejecuta `fn` con reintentos y espera exponencial. Lanza el último error. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= retries) break;
      if (opts.shouldRetry && !opts.shouldRetry(e, attempt)) break;
      const wait = backoffMs(attempt, opts.baseMs, opts.maxMs);
      opts.onRetry?.(e, attempt + 1, wait);
      await delay(wait);
    }
  }
  throw lastError;
}

/**
 * Pool con concurrencia acotada: procesa `items` con como máximo `limit`
 * tareas simultáneas. Conserva el orden de los resultados y nunca lanza
 * (cada resultado es {ok:true,value} o {ok:false,error}).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> =
    new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = { ok: true, value: await worker(items[i], i) };
        } catch (error) {
          results[i] = { ok: false, error };
        }
      }
    })
  );
  return results;
}

/**
 * Espera a que `cond` sea verdadera (sondeo cada `intervalMs`), hasta `maxMs`.
 * Devuelve true si se cumplió, false si se agotó el tiempo. Sustituye a los
 * `delay()` fijos: con la condición cumplida no espera de más, y si nunca se
 * cumple espera lo mismo que el `delay()` original.
 */
export async function waitUntil(
  cond: () => Promise<boolean> | boolean,
  maxMs: number,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (true) {
    try {
      if (await cond()) return true;
    } catch {
      // la condición puede fallar mientras la página navega
    }
    if (Date.now() >= deadline) return false;
    await delay(Math.min(intervalMs, Math.max(10, deadline - Date.now())));
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
