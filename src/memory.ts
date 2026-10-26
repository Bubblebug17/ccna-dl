import { freemem, totalmem } from 'os';
import type { Page } from 'puppeteer';
import { memAvailableMb } from './platform';

/** Cada cuántos capítulos se recicla (cierra y reabre) la pestaña de cada worker. */
export const DEFAULT_RECYCLE_EVERY = 8;
/** Heap de JS (MB) a partir del cual se recicla la pestaña antes de tiempo. */
export const DEFAULT_RECYCLE_HEAP_MB = 600;
/** RAM libre (MB) por debajo de la cual se recicla la pestaña antes de tiempo. */
export const LOW_FREE_MB = 700;
/** Estimación prudente de RAM por pestaña (renderer + cachés) con el reciclado activo. */
export const TAB_BUDGET_MB = 1200;
/** RAM que se deja libre para el sistema, Node y el proceso principal del navegador. */
export const RESERVE_MB = 1500;
/** Pestañas por defecto (antes 3). */
export const DEFAULT_TABS = 2;

const MB = 1024 * 1024;

export type MemInfo = { freeMb: number; totalMb: number };

export function memInfo(): MemInfo {
  return { freeMb: memAvailableMb() ?? Math.round(freemem() / MB), totalMb: Math.round(totalmem() / MB) };
}

export type TabPlan = {
  tabs: number;
  /** El valor no lo fijó el usuario: se eligió según la RAM libre. */
  auto: boolean;
  /** Mensaje de advertencia (RAM insuficiente para ese nº de pestañas), si procede. */
  warn?: string;
  freeMb: number;
  totalMb: number;
};

/**
 * Decide cuántas pestañas usar.
 * - Sin --concurrency: min(2, las que caben en la RAM libre), mínimo 1.
 * - Con --concurrency N: se respeta N (1-6) pero se advierte si no cabe en la RAM libre.
 */
export function planTabs(requested: number | undefined, mem: MemInfo = memInfo()): TabPlan {
  const fit = Math.max(1, Math.floor((mem.freeMb - RESERVE_MB) / TAB_BUDGET_MB));
  if (requested === undefined) {
    return { tabs: Math.min(DEFAULT_TABS, fit), auto: true, ...mem };
  }
  const tabs = Math.min(6, Math.max(1, Math.floor(requested) || 1));
  const needMb = RESERVE_MB + tabs * TAB_BUDGET_MB;
  let warn: string | undefined;
  if (mem.freeMb < needMb && tabs > 1) {
    warn =
      `Memoria: hay ~${(mem.freeMb / 1024).toFixed(1)} GB libres de ${(mem.totalMb / 1024).toFixed(1)} GB y ${tabs} pestañas pueden necesitar ` +
      `~${(needMb / 1024).toFixed(1)} GB. Con poca RAM el PC se vuelve lento (y Chrome puede cerrarse). ` +
      `Prueba --concurrency ${fit}, o cierra programas, o baja --recycle-every.`;
  }
  return { tabs, auto: false, warn, ...mem };
}

/** Heap de JS usado por la pestaña (MB); undefined si no se puede leer. */
export async function heapUsedMb(page: Page): Promise<number | undefined> {
  try {
    const m = await page.metrics();
    return typeof m.JSHeapUsedSize === 'number' ? Math.round(m.JSHeapUsedSize / MB) : undefined;
  } catch {
    return undefined;
  }
}

/** Motivo para reciclar la pestaña ya (además del contador de capítulos), o null. */
export async function recycleReason(
  page: Page,
  heapLimitMb = DEFAULT_RECYCLE_HEAP_MB,
  free: () => number = () => memInfo().freeMb
): Promise<string | null> {
  if (heapLimitMb > 0) {
    const h = await heapUsedMb(page);
    if (h !== undefined && h > heapLimitMb) return `heap de JS ${h} MB > ${heapLimitMb} MB`;
  }
  const f = free();
  if (f < LOW_FREE_MB) return `poca RAM libre (${f} MB)`;
  return null;
}
