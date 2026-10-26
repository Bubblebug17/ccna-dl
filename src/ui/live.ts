import { log, setSink } from './log';
import { fitAnsi, physRows, strWidth, termWidth } from './text';

type Out = Pick<NodeJS.WriteStream, 'write' | 'on' | 'off'> & { columns?: number; isTTY?: boolean };

/** ¿La salida es una terminal capaz de mover el cursor (secuencias VT)? */
export function canMoveCursor(out: { isTTY?: boolean } = process.stdout): boolean {
  if (!out.isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  return true; // Node activa el modo VT de la consola de Windows (10+) al abrir stdout como TTY
}

let cursorHidden = false;
const showCursor = () => {
  if (cursorHidden) process.stdout.write('\x1b[?25h');
  cursorHidden = false;
};
process.once('exit', showCursor);

/**
 * Zona dinámica al final de la terminal: se redibuja en el mismo sitio (sin duplicar) y los mensajes
 * se imprimen UNA vez POR ENCIMA. Cada línea se recorta a columnas-1 (ancho visible real: emoji = 2),
 * así nunca se parte; aun así se cuentan las filas FÍSICAS dibujadas por si la terminal cambia de tamaño.
 * Cada refresco es una sola escritura: subir N filas, borrar hasta el final, escribir todo.
 */
export class LiveArea {
  /** Ancho visible de cada línea del último dibujo (para recalcular filas físicas si cambia el ancho). */
  private widths: number[] = [];
  private cols: number;
  private timer: NodeJS.Timeout;
  private stopped = false;
  private orig = { log: console.log, warn: console.warn, error: console.error };
  private onResize = () => this.draw();
  /** Ctrl+C sin otro manejador (el de la CLI termina con calma): deja la pantalla limpia, cursor visible, y sale. */
  private onSigint = () => {
    if (process.listenerCount('SIGINT') > 1) return; // otro manejador decide; 'exit' restaura el cursor
    this.stop();
    process.exit(130);
  };
  /** Secuencias emitidas: para pruebas (filas subidas vs. filas dibujadas). */
  stats = { moves: [] as number[], rows: [] as number[] };

  constructor(
    private render: () => string[],
    fps = 8,
    private out: Out = process.stdout,
    private width: () => number = () => (out === process.stdout ? termWidth() : out.columns || 80),
  ) {
    this.cols = this.width();
    this.out.write('\x1b[?25l'); // oculta el cursor
    if (out === process.stdout) cursorHidden = true;
    process.on('SIGINT', this.onSigint);
    this.out.on('resize', this.onResize);
    setSink((line) => this.print(line));
    const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ');
    console.log = (...a: unknown[]) => log.at(2, fmt(a));
    console.warn = (...a: unknown[]) => log.at(1, fmt(a), 'warn');
    console.error = (...a: unknown[]) => log.at(1, fmt(a), 'error');
    this.timer = setInterval(() => this.draw(), Math.round(1000 / fps));
    this.timer.unref();
    this.draw();
  }

  /** Filas físicas que ocupa ahora lo dibujado (con el ancho actual: tras un resize la terminal pudo re-partirlas). */
  private rows(cols: number): number {
    return this.widths.reduce((a, w) => a + physRows(w, cols), 0);
  }

  /** Vuelve al inicio de la zona y la borra. El cursor queda en la última fila dibujada (sin \n final). */
  private clearSeq(): string {
    if (!this.widths.length) return '';
    const cols = this.width();
    const up = this.rows(cols) - 1;
    this.stats.moves.push(up + 1);
    this.widths = [];
    return '\r' + (up > 0 ? `\x1b[${up}A` : '') + '\x1b[J';
  }

  private frame(): string {
    this.cols = this.width();
    const lines = this.render().flatMap((l) => l.split('\n')).map((l) => fitAnsi(l, this.cols - 1));
    this.widths = lines.map(strWidth);
    this.stats.rows.push(this.rows(this.cols));
    return lines.join('\n');
  }

  draw(): void {
    if (this.stopped) return;
    this.out.write(this.clearSeq() + this.frame());
  }

  /** Imprime líneas fijas encima de la zona dinámica (mensajes o capítulos terminados), una sola vez. */
  print(text: string): void {
    if (this.stopped) {
      this.out.write(text + '\n');
      return;
    }
    this.out.write(this.clearSeq() + text + '\n' + this.frame());
  }

  /** Último dibujo, deja la zona en pantalla y restaura cursor, consola y log. */
  stop(): void {
    if (this.stopped) return;
    this.draw();
    this.stopped = true;
    clearInterval(this.timer);
    this.out.off('resize', this.onResize);
    process.removeListener('SIGINT', this.onSigint);
    this.out.write('\n\x1b[?25h');
    if (this.out === process.stdout) cursorHidden = false;
    this.widths = [];
    setSink(null);
    Object.assign(console, this.orig);
  }
}
