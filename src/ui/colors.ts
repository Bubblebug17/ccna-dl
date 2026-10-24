import pc = require('picocolors');

/**
 * Colores de la terminal (picocolors). Se desactivan solos con NO_COLOR, con --no-color,
 * o cuando la salida no es una terminal (redirección a archivo, CI). FORCE_COLOR=1 los fuerza.
 */
const env = process.env;
const forced = !!env.FORCE_COLOR && !['0', 'false'].includes(env.FORCE_COLOR);
export const colorsOn =
  !env.NO_COLOR &&
  !process.argv.includes('--no-color') &&
  (forced || (!!process.stdout.isTTY && env.TERM !== 'dumb'));
export const c = pc.createColors(colorsOn);

/** Colorea una línea de log según su símbolo (✔ ⚠ ✖ ·). */
export function paintLine(msg: string): string {
  if (!colorsOn) return msg;
  if (/✖|fallid|Error|error:/.test(msg)) return msg.replace(/✖[^(]*/, (m) => pc.red(pc.bold(m)));
  if (/✔/.test(msg)) return msg.replace(/✔[^(]*/, (m) => pc.green(m));
  if (/⚠/.test(msg)) return pc.yellow(msg);
  if (/^\s+·/.test(msg)) return pc.dim(msg);
  return msg.replace(/^(\[\d+\/\d+\] \S+)/, (m) => pc.cyan(m));
}
