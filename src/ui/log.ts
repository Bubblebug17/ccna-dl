import { c, paintLine } from './colors';

/**
 * Niveles de verbosidad (--verbose / -v):
 *   1 = mínimo: barra, avisos, errores y resumen final.
 *   2 = normal (por defecto): además, el resultado de cada capítulo y los pasos principales.
 *   3 = detallado: además, login paso a paso, reciclado de pestañas, omitidos, memoria, reintentos.
 */
export type Verbosity = 1 | 2 | 3;
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

function out(line: string, err = false): void {
  if (sink) sink(line);
  else if (err) console.error(line);
  else console.log(line);
}

export const log = {
  /** Mensaje que se muestra desde el nivel indicado (por defecto 2). */
  at(lvl: Verbosity, msg: string): void {
    if (level >= lvl) out(paintLine(msg));
  },
  /** Nivel 1: siempre visible. */
  essential: (msg: string) => log.at(1, msg),
  /** Nivel 2: pasos normales. */
  info: (msg: string) => log.at(2, msg),
  /** Nivel 2, resaltado como paso. */
  step: (msg: string) => {
    if (level >= 2) out(c.cyan('›') + ' ' + msg);
  },
  /** Nivel 3: detalle. */
  detail: (msg: string) => {
    if (level >= 3) out(c.dim(msg));
  },
  ok: (msg: string) => {
    if (level >= 2) out(c.green('✔ ' + msg));
  },
  /** Avisos y errores se ven siempre. */
  warn: (msg: string) => out(c.yellow(msg.startsWith('⚠') ? msg : '⚠ ' + msg), true),
  error: (msg: string, e?: unknown) =>
    out(c.red(c.bold('✖ ' + msg)) + (e !== undefined ? ' ' + c.red(e instanceof Error ? e.stack || e.message : String(e)) : ''), true),
};
