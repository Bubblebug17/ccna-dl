import { c, colorsOn } from './ui/colors';
import { Kind, log as ulog, Verbosity, verbosity } from './ui/log';
import { LiveArea } from './ui/live';
import { fmtMb, memText, monitor } from './ui/resource-monitor';
import { canMoveCursor } from './ui/live';
import { fit, padW, termHeight, termWidth, visLen } from './ui/text';
import { cleanTitle, moduleTitleFrom } from './ui/titles';

/**
 * Pantalla de carga por CAPÍTULO (módulo: 1, 2, 3…) y SUBCAPÍTULO (1.0, 1.1, 1.2…).
 *
 *  ✔ 1  Introducción a…        ██████████ 100%  5/5   ← capítulo terminado: se "congela" encima
 *      ✔ 1.0 Bienvenida         ██████████ 100%  56s
 *  ⠋ 2  Conceptos de OSPF       ████░░░░░░  43%  2/6   ← zona dinámica: capítulos en curso, en orden
 *      ✔ 2.0 …                  ██████████ 100%  11s
 *      ⠙ 2.2 …                  ███░░░░░░░  40s  animaciones
 *      · 2.3 … y 3 más pendientes
 *  ████░░░░ 6/111 subcapítulos · 5% · 1m36s · ETA 28m08s
 *  ▣ RAM 3.5 GB (node 120 MB · chrome 3.4 GB/10p) · libre 2.9 GB · pico 3.7 GB
 *
 * El porcentaje del capítulo es la media del avance de sus subcapítulos (cada uno según su fase).
 * La página propia del módulo ("2", la portada del capítulo) se muestra como un subcapítulo más.
 * Sin terminal (CI, archivo) o con --no-progress: solo líneas de log con el mismo formato.
 */

export type ChapterMark = 'ok' | 'warn' | 'fail' | 'skip';

export type ChapterBar = {
  start: () => void;
  stage: (stage: string) => void;
  /** Subcapítulo terminado (de la forma que sea). `title`: su título, si se conoce. */
  done: (mark: ChapterMark, info?: { title?: string; ms?: number }) => void;
};

export type Progress = {
  /** true si hay barras en pantalla (terminal). */
  live: boolean;
  /** Escribe una línea sin romper las barras. `level`: verbosidad mínima (por defecto 2). */
  log: (msg: string, level?: Verbosity, kind?: Kind) => void;
  /** Barra del subcapítulo `id` ("1.2", "2"…). */
  chapter: (id: string) => ChapterBar;
  /** Título conocido de antemano (p. ej. de lo ya guardado en disco). */
  setTitle: (id: string, title: string) => void;
  stop: () => void;
};

// Braille solo donde la fuente lo soporta seguro (Windows Terminal, VS Code, Linux/macOS); en la consola clásica de Windows, ASCII.
const fancy = colorsOn && (process.platform !== 'win32' || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode');
const SPIN = fancy ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\'];
const FULL = fancy ? '█' : '#';
const EMPTY = fancy ? '░' : '-';
// Iconos de 1 columna (⚠ se pinta como emoji de 2 en Windows Terminal y desalinea): con fuente buena ✔ ✖ ! ·, si no ASCII.
const ICON = fancy ? { ok: '✔', warn: '!', fail: '✖', skip: '✔', pending: '·' } : { ok: '+', warn: '!', fail: 'x', skip: '+', pending: '.' };
/** Fases de un subcapítulo, en orden (para su avance). */
const STAGES = ['abriendo', 'esperando', 'vídeos', 'animaciones', 'recursos', 'escribiendo'];
const stageFrac = (s: string) => {
  const i = STAGES.findIndex((p) => s.replace(/^2ª captura: /, '').startsWith(p));
  return i < 0 ? 0.05 : (i + 0.5) / (STAGES.length + 0.5);
};
export const fmtSecs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** Capítulo (módulo) de un subcapítulo: "2.3" -> "2", "2" -> "2". */
export const moduleOf = (id: string) => id.split('.')[0];
/** Orden numérico de ids "1", "1.0", "1.10", "2.2.1". */
export function cmpIds(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return (Number.isNaN(x) ? 1e9 : x) - (Number.isNaN(y) ? 1e9 : y);
  }
  return 0;
}

type Sub = { id: string; title?: string; raw?: string; state: 'pending' | 'run' | 'done'; stage: string; t0: number; ms: number; mark?: ChapterMark };
type Mod = { id: string; subs: Sub[]; frozen: boolean };

export function createProgress(ids: string[], opts: { enabled?: boolean } = {}): Progress {
  const live = (opts.enabled ?? true) && canMoveCursor(process.stdout) && ids.length > 0;
  const t0 = Date.now();
  const subs = new Map<string, Sub>();
  const mods = new Map<string, Mod>();
  for (const id of [...ids].sort(cmpIds)) {
    const s: Sub = { id, state: 'pending', stage: '', t0: 0, ms: 0 };
    subs.set(id, s);
    const m = moduleOf(id);
    if (!mods.has(m)) mods.set(m, { id: m, subs: [], frozen: false });
    mods.get(m)!.subs.push(s);
  }
  const modList = [...mods.values()].sort((a, b) => cmpIds(a.id, b.id));
  const total = ids.length;
  let doneN = 0;
  let workedN = 0; // terminados en esta ejecución (no omitidos), para la ETA
  let frame = 0;

  const modTitle = (m: Mod) => {
    for (const s of m.subs) {
      const t = moduleTitleFrom(s.raw);
      if (t) return t;
    }
    return m.subs.find((s) => s.id === m.id)?.title ?? '';
  };
  const subFrac = (s: Sub) => (s.state === 'done' ? 1 : s.state === 'run' ? stageFrac(s.stage) : 0);
  const modFrac = (m: Mod) => m.subs.reduce((a, s) => a + subFrac(s), 0) / m.subs.length;
  const modDone = (m: Mod) => m.subs.every((s) => s.state === 'done');
  const modStarted = (m: Mod) => m.subs.some((s) => s.state !== 'pending');

  const barStr = (frac: number, size: number, color: (s: string) => string) => {
    const n = Math.round(Math.max(0, Math.min(1, frac)) * size);
    return color(FULL.repeat(n)) + c.dim(EMPTY.repeat(size - n));
  };
  const barSize = () => Math.max(8, Math.min(24, Math.floor((termWidth() - 50) / 2)));

  /** Línea con texto a la izquierda (se recorta el título) y barra + datos a la derecha. */
  const row = (indent: number, icon: string, id: string, title: string, frac: number, right: string, color: (s: string) => string) => {
    const w = termWidth() - 1;
    const pad = Math.max(0, 17 - visLen(right));
    const tail = ` ${barStr(frac, barSize(), color)} ${' '.repeat(pad)}${right}`;
    const head = `${' '.repeat(indent)}${icon} ${c.bold(id.padEnd(indent ? 5 : 3))}`;
    const room = w - visLen(head) - visLen(tail) - 1;
    const t = room > 3 ? padW(fit(title, room), room) : '';
    return `${head} ${t}${tail}`;
  };
  const iconOf = (s: Sub) =>
    s.state === 'run'
      ? c.cyan(SPIN[frame % SPIN.length])
      : s.state === 'pending'
        ? c.dim(ICON.pending)
        : s.mark === 'fail'
          ? c.red(ICON.fail)
          : s.mark === 'warn'
            ? c.yellow(ICON.warn)
            : c.green(ICON.ok);
  const subLine = (s: Sub) => {
    if (s.state === 'pending') return row(4, iconOf(s), s.id, s.title ?? '', 0, c.dim('   pendiente'), c.blue);
    if (s.state === 'run') return row(4, iconOf(s), s.id, s.title ?? '', subFrac(s), `${fmtSecs(Date.now() - s.t0).padStart(5)} ${c.dim(fit(s.stage, 11).padEnd(11))}`, c.blue);
    const right = s.mark === 'skip' ? c.dim('100%  ya guardado') : `100% ${fmtSecs(s.ms).padStart(6)}`;
    return row(4, iconOf(s), s.id, s.title ?? '', 1, right, s.mark === 'fail' ? c.red : s.mark === 'warn' ? c.yellow : c.green);
  };
  const modLine = (m: Mod) => {
    const done = m.subs.filter((s) => s.state === 'done').length;
    const complete = done === m.subs.length;
    const fails = m.subs.some((s) => s.mark === 'fail');
    const icon = complete ? (fails ? c.red(ICON.fail) : c.green(ICON.ok)) : c.cyan(SPIN[frame % SPIN.length]);
    const pct = `${String(Math.round(modFrac(m) * 100)).padStart(3)}%`;
    return row(0, icon, m.id, modTitle(m) || `Capítulo ${m.id}`, modFrac(m), `${pct} ${`${done}/${m.subs.length}`.padStart(6)}`, complete ? c.green : c.cyan);
  };
  const totalLine = () => {
    const el = Date.now() - t0;
    const left = total - doneN;
    const eta = workedN > 0 && left > 0 ? ` · ETA ${fmtSecs((el / workedN) * left)}` : '';
    return ` ${barStr(doneN / Math.max(1, total), barSize() + 10, c.green)} ${c.bold(`${doneN}/${total}`)} subcapítulos · ${Math.round((doneN / Math.max(1, total)) * 100)}% · ${fmtSecs(el)}${c.dim(eta)}`;
  };
  const memLine = () => {
    const s = monitor.sample();
    const used = s.nodeMb + (s.chromeMb ?? 0);
    const txt = memText(s) + ` · pico ${fmtMb(Math.max(monitor.peak(), used))}`;
    const col = s.freeMb < 700 ? c.red : s.freeMb < 1500 ? c.yellow : c.dim;
    return ` ${c.magenta(fancy ? '▣' : '*')} ${col(txt)}`;
  };

  /** Bloque de un capítulo con sus subcapítulos, colapsando si no cabe. */
  const modBlock = (m: Mod, mode: 0 | 1 | 2 | 3): string[] => {
    const lines = [modLine(m)];
    if (mode === 3) return lines;
    const pend = m.subs.filter((s) => s.state === 'pending');
    const done = m.subs.filter((s) => s.state === 'done');
    if (mode >= 2 && done.length) lines.push(c.dim(`    ${ICON.ok} ${done.length} terminado(s)`));
    for (const s of m.subs) {
      if (s.state === 'run') lines.push(subLine(s));
      else if (s.state === 'done' && mode < 2) lines.push(subLine(s));
      else if (s.state === 'pending' && mode === 0) lines.push(subLine(s));
    }
    if (mode >= 1 && pend.length) {
      lines.push(c.dim(`    ${ICON.pending} ${pend[0].id}${pend.length > 1 ? ` … y ${pend.length - 1} más pendientes` : ' pendiente'}`));
    }
    // orden: el resumen "terminados" arriba, luego en curso, luego pendientes
    return lines;
  };

  const render = (): string[] => {
    frame++;
    const active = modList.filter((m) => !m.frozen && modStarted(m));
    const foot = [totalLine(), memLine()];
    const maxH = termHeight() - 2;
    for (const mode of [0, 1, 2, 3] as const) {
      const body = active.flatMap((m) => modBlock(m, mode));
      if (body.length + foot.length <= maxH || mode === 3) return [...body.slice(-(maxH - foot.length)), ...foot];
    }
    return foot;
  };

  const area = live ? new LiveArea(render) : null;

  /** Capítulos completos, en orden: se imprimen como líneas fijas (y ya no se redibujan). */
  const freeze = () => {
    for (const m of modList) {
      if (m.frozen) continue;
      if (!modDone(m)) break;
      m.frozen = true;
      const warns = m.subs.filter((s) => s.mark === 'warn').length;
      const fails = m.subs.filter((s) => s.mark === 'fail').length;
      const allSkip = m.subs.every((s) => s.mark === 'skip');
      if (area) {
        if (allSkip) area.print(modLine(m).replace(/\s+\d+\/\d+$/, '') + c.dim('  ya guardado'));
        else area.print([modLine(m), ...m.subs.map(subLine)].join('\n'));
      } else if (!allSkip || verbosity() >= 3) {
        const name = `Capítulo ${m.id}${modTitle(m) ? ' ' + modTitle(m) : ''}`;
        const extra = [warns ? `${warns} con avisos` : '', fails ? `${fails} ${fails === 1 ? 'fallido' : 'fallidos'}` : ''].filter(Boolean).join(', ');
        ulog.at(fails ? 1 : 2, `${name}: ${m.subs.length} subcapítulo(s) terminados${extra ? ` (${extra})` : ''}`, fails ? 'warn' : 'ok');
      }
    }
  };

  return {
    live,
    log: (m, level = 2, kind) => ulog.at(level, m, kind),
    setTitle: (id, title) => {
      const s = subs.get(id);
      if (s && title) {
        s.raw = title;
        s.title = cleanTitle(id, title);
      }
    },
    chapter: (id) => {
      const s = subs.get(id) ?? { id, state: 'pending', stage: '', t0: 0, ms: 0 };
      return {
        start: () => {
          s.state = 'run';
          s.stage = 'abriendo';
          s.t0 = Date.now();
        },
        stage: (st) => {
          s.stage = st;
        },
        done: (mark, info) => {
          if (s.state === 'done') return;
          s.state = 'done';
          s.mark = mark;
          if (info?.title) {
            s.raw = info.title;
            s.title = cleanTitle(id, info.title);
          }
          s.ms = info?.ms ?? (s.t0 ? Date.now() - s.t0 : 0);
          doneN++;
          if (mark !== 'skip') workedN++;
          freeze();
        },
      };
    },
    stop: () => {
      freeze();
      area?.stop();
    },
  };
}
