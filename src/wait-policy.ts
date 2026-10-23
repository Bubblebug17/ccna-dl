/**
 * Política de esperas. Netacad muestra efectos de carga de 1-2 s; guardar antes
 * de que terminen estropea la captura. Por eso por defecto se combinan
 * CONDICIONES (spinner/skeleton fuera, DOM estable, imágenes y red inactivas)
 * con un tiempo mínimo de asentamiento (--min-wait, 1500 ms). El modo --fast
 * (opt-in) usa valores más agresivos.
 */
export type WaitPolicy = {
  /** Tiempo mínimo que el contenido debe llevar "listo" antes de guardar. */
  minWaitMs: number;
  /** Silencio del DOM (sin cambios) exigido antes de guardar. */
  stableMs: number;
  /** Máximo que se espera a que el DOM quede estable. */
  maxStableMs: number;
  /** La URL del capítulo debe llevar estable este tiempo antes de leer la página. */
  shellStableMs: number;
  /** Inactividad de red exigida (waitForNetworkIdle). */
  networkIdleMs: number;
  fast: boolean;
};

export const SAFE_POLICY: WaitPolicy = {
  minWaitMs: 1500,
  stableMs: 400,
  maxStableMs: 8000,
  shellStableMs: 1500,
  networkIdleMs: 600,
  fast: false,
};

export const FAST_POLICY: WaitPolicy = {
  minWaitMs: 500,
  stableMs: 250,
  maxStableMs: 5000,
  shellStableMs: 600,
  networkIdleMs: 300,
  fast: true,
};

let current: WaitPolicy = { ...SAFE_POLICY };

export function getWaitPolicy(): WaitPolicy {
  return current;
}

/** Fija la política global (se llama una vez al arrancar; después es de solo lectura). */
export function setWaitPolicy(opts: { fast?: boolean; minWaitMs?: number } = {}): WaitPolicy {
  const base = opts.fast ? FAST_POLICY : SAFE_POLICY;
  current = { ...base };
  if (opts.minWaitMs !== undefined && Number.isFinite(opts.minWaitMs) && opts.minWaitMs >= 0) {
    current.minWaitMs = Math.floor(opts.minWaitMs);
  }
  return current;
}
