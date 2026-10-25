import { log, setSink } from './log';
import { fitAnsi, termWidth } from './text';

/**
 * Zona dinámica al final de la terminal: se redibuja cada `fps` y los mensajes (log) se imprimen
 * POR ENCIMA, sin romperla. Cada línea se recorta al ancho de la terminal para que no se parta.
 * Solo se usa si la salida es una terminal.
 */
export class LiveArea {
  private drawn = 0;
  private timer: NodeJS.Timeout;
  private stopped = false;
  private orig = { log: console.log, warn: console.warn, error: console.error };
  private out = process.stdout;

  constructor(private render: () => string[], fps = 8) {
    this.out.write('\x1b[?25l'); // oculta el cursor
    setSink((line) => this.print(line));
    const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ');
    console.log = (...a: unknown[]) => log.at(2, fmt(a));
    console.warn = (...a: unknown[]) => log.at(1, fmt(a), 'warn');
    console.error = (...a: unknown[]) => log.at(1, fmt(a), 'error');
    this.timer = setInterval(() => this.draw(), Math.round(1000 / fps));
    this.timer.unref();
    this.draw();
  }

  private clearSeq(): string {
    if (!this.drawn) return '';
    return '\r' + (this.drawn > 1 ? `\x1b[${this.drawn - 1}A` : '') + '\x1b[J';
  }

  private frame(): string {
    const w = termWidth() - 1;
    const lines = this.render().map((l) => fitAnsi(l, w));
    this.drawn = lines.length;
    return lines.join('\n');
  }

  draw(): void {
    if (this.stopped) return;
    this.out.write(this.clearSeq() + this.frame());
  }

  /** Imprime líneas fijas encima de la zona dinámica (mensajes o bloques "congelados"). */
  print(text: string): void {
    if (this.stopped) {
      this.out.write(text + '\n');
      return;
    }
    const clear = this.clearSeq();
    this.drawn = 0;
    this.out.write(clear + text + '\n' + this.frame());
  }

  /** Último dibujo, deja la zona en pantalla y restaura cursor, consola y log. */
  stop(): void {
    if (this.stopped) return;
    this.draw();
    this.stopped = true;
    clearInterval(this.timer);
    this.out.write('\n\x1b[?25h');
    this.drawn = 0;
    setSink(null);
    Object.assign(console, this.orig);
  }
}
