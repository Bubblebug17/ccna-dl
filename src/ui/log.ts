import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { c } from './colors';
import { stripAnsi, termWidth, wrap } from './text';

/**
 * Niveles de verbosidad (--verbose / -v):
 *   1 = mínimo: barras, avisos, errores y resumen final.
 *   2 = normal (por defecto): además, los pasos principales.
 *   3 = detallado: además, login paso a paso, reciclado de pestañas, omitidos, memoria, reintentos
 *       y el detalle de cada aviso (URLs, códigos).
 *
 * Cada línea lleva una de 4 categorías, con etiqueta legible también sin colores:
 *   [INFO]  información · [OK] terminado bien · [WARN] aviso · [ERROR] error
 */
export type Verbosity = 1 | 2 | 3;
export type Kind = 'info' | 'ok' | 'warn' | 'error';
let level: Verbosity = 2;

export function setVerbosity(v: number): Verbosity {
  level = (Math.min(3, Math.max(1, Math.round(Number(v) || 2))) as Verbosity);
  return level;
}
export const verbosity = (): Verbosity => level;

type Sink = (line: string) => void;
let sink: Sink | null = null;
/** Mientras hay barras en pantalla, los mensajes se escriben por encima de ellas. */
export function setSink(s: Sink | null): void {
  sink = s;
}

// ---- archivo de log (ccna-dl.log en la carpeta del curso): TODO, sin colores, con hora ----
let logFile: string | null = null;
const pending: string[] = [];
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function toFile(kind: Kind | 'detail', msg: string): void {
  const line = `${stamp()} ${TAG[kind === 'detail' ? 'info' : kind].padEnd(7)} ${stripAnsi(msg)}\n`;
  if (!logFile) {
    if (pending.length < 2000) pending.push(line);
    return;
  }
  try {
    appendFileSync(logFile, line);
  } catch {
    logFile = null;
  }
}
/** Empieza a escribir el log en `path` (incluye lo anterior de esta ejecución). null = deja de escribir. */
export function setLogFile(path: string | null): void {
  logFile = path;
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `\n===== ccna-dl · ${stamp()} =====\n` + pending.join(''));
    pending.length = 0;
  } catch {
    logFile = null;
  }
}
export const logFilePath = (): string | null => logFile;

const TAG: Record<Kind, string> = { info: '[INFO]', ok: '[OK]', warn: '[WARN]', error: '[ERROR]' };
const paint: Record<Kind, (s: string) => string> = {
  info: (s) => c.cyan(s),
  ok: (s) => c.green(s),
  warn: (s) => c.yellow(s),
  error: (s) => c.red(c.bold(s)),
};

/** Quita los símbolos antiguos del principio (⚠ ✔ ✖ › ·) y espacios. */
const clean = (m: string) => m.replace(/^\s*(?:[⚠✔✖›·↳*-]\s+|[⚠✔✖›]\s*)+/u, '').trimEnd();

/** Línea formateada: etiqueta + texto, ajustada al ancho de la terminal (sin desbordar). */
export function formatLine(kind: Kind, msg: string, dim = false, width = termWidth()): string {
  const tag = TAG[kind].padEnd(7);
  const body = wrap(clean(stripAnsi(msg)), width - 8, 8);
  const text = body.join('\n');
  const colored = kind === 'warn' ? c.yellow(text) : kind === 'error' ? c.red(text) : dim ? c.dim(text) : text;
  return paint[kind](tag) + ' ' + colored;
}

function out(kind: Kind, msg: string, dim = false): void {
  const line = formatLine(kind, msg, dim);
  if (sink) sink(line);
  else if (kind === 'error' || kind === 'warn') console.error(line);
  else console.log(line);
}

/** Categoría por el texto (para mensajes antiguos o de terceros). */
export function guessKind(msg: string): Kind {
  const m = msg.trimStart();
  if (/^✖|fallid|^Error\b|error:/i.test(m)) return 'error';
  if (/^⚠|^aviso/i.test(m)) return 'warn';
  if (/^✔/.test(m)) return 'ok';
  return 'info';
}

export const log = {
  /** Mensaje (categoría deducida del texto) que se muestra desde el nivel indicado. */
  at(lvl: Verbosity, msg: string, kind: Kind = guessKind(msg)): void {
    if (!msg.trim()) {
      if (level >= lvl) (sink ?? console.log)('');
      return;
    }
    toFile(kind, clean(msg));
    if (kind === 'warn' || kind === 'error' || level >= lvl) out(kind, msg, lvl >= 3 && kind === 'info');
  },
  /** Nivel 1: siempre visible. */
  essential: (msg: string) => log.at(1, msg, 'info'),
  /** Nivel 2: pasos normales. */
  info: (msg: string, lvl: Verbosity = 2) => log.at(lvl, msg, 'info'),
  step: (msg: string) => log.at(2, msg, 'info'),
  /** Nivel 3: detalle (atenuado). */
  detail: (msg: string) => log.at(3, msg, 'info'),
  ok: (msg: string, lvl: Verbosity = 2) => log.at(lvl, msg, 'ok'),
  /** Avisos y errores se ven siempre. */
  warn: (msg: string) => log.at(1, msg, 'warn'),
  error: (msg: string, e?: unknown) => {
    const detail = e !== undefined ? (e instanceof Error ? e.message : String(e)) : '';
    if (e instanceof Error && e.stack) toFile('detail', e.stack);
    log.at(1, detail ? `${msg} ${detail}` : msg, 'error');
  },
  /** Solo al archivo de log (detalles: URLs, códigos, pilas). Con -v 3 también en pantalla. */
  file: (msg: string) => {
    toFile('detail', msg);
    if (level >= 3) out('info', msg, true);
  },
};
