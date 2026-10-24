import * as cliProgress from 'cli-progress';
import { c, colorsOn, paintLine } from './ui/colors';
import { Verbosity, log as ulog, setSink, verbosity } from './ui/log';
import { fmtMb, memText, monitor } from './ui/resource-monitor';

/** Barra de una pestaña: el capítulo que está descargando y su fase. */
export type LaneBar = {
  start: (chapter: string, label?: string) => void;
  stage: (stage: string) => void;
  idle: () => void;
};

export type Progress = {
  /** Escribe una línea sin romper las barras. `level`: verbosidad mínima (por defecto 2). */
  log: (msg: string, level?: Verbosity) => void;
  /** Avanza la barra total (un capítulo terminado, de la forma que sea). */
  tick: (info?: string) => void;
  /** Barra de la pestaña `id` (0, 1, …). */
  lane: (id: number) => LaneBar;
  stop: () => void;
};

// Braille solo donde la fuente lo soporta seguro (Windows Terminal, VS Code, Linux/macOS); en la consola clásica de Windows, ASCII.
const fancy = colorsOn && (process.platform !== 'win32' || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode');
const SPIN = fancy ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\'];
/** Fases de un capítulo, en orden (para el avance de la barra de pestaña). */
const STAGES = ['abriendo', 'esperando', 'vídeos', 'animaciones', 'recursos', 'escribiendo'];
const stageStep = (s: string) => {
  const i = STAGES.findIndex((p) => s.startsWith(p));
  return i < 0 ? 0 : i + 1;
};
const fmtSecs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/**
 * Pantalla de carga: barra total (con indicador de RAM) + una barra con spinner por pestaña
 * mostrando el capítulo en curso, su fase y el tiempo que lleva.
 * Si la salida no es una terminal (CI, redirección a archivo) no se dibujan barras:
 * solo líneas de log (y, con -v 3, una línea de memoria cada 30 s).
 */
export function createProgress(total: number, opts: { enabled?: boolean; lanes?: number } = {}): Progress {
  const enabled = (opts.enabled ?? true) && !!process.stdout.isTTY && total > 0;
  const log = (m: string, level: Verbosity = 2) => ulog.at(level, m);

  if (!enabled) {
    let lastMem = Date.now();
    const lanesTxt = new Map<number, string>();
    const memLine = () => {
      if (verbosity() >= 3 && Date.now() - lastMem > 30_000) {
        lastMem = Date.now();
        ulog.detail(`    [memoria] ${memText(monitor.sample())}`);
      }
    };
    return {
      log: (m, level) => {
        log(m, level);
        memLine();
      },
      tick: () => memLine(),
      lane: (id) => ({
        start: (ch, label) => {
          lanesTxt.set(id, ch);
          ulog.detail(`    ↳ ${label ?? ch} · empieza (pestaña ${id + 1})`);
        },
        stage: () => undefined,
        idle: () => lanesTxt.delete(id),
      }),
      stop: () => undefined,
    };
  }

  const multi = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      stopOnComplete: false,
      autopadding: true,
      fps: 8,
      barsize: 26,
      format: (options, params, payload) => {
        const p = payload as Record<string, string>;
        const size = options.barsize ?? 26;
        const done = Math.round((params.progress || 0) * size);
        const bar = '█'.repeat(done) + '░'.repeat(size - done);
        if (p.kind === 'lane') {
          if (!p.chapter) return c.dim(`  ${p.spin === undefined ? ' ' : '·'} pestaña ${p.lane}  en espera`);
          return `  ${c.cyan(p.spin)} pestaña ${p.lane}  ${c.bold(p.chapter.padEnd(7))} ${c.blue(bar)} ${c.dim(p.elapsed.padStart(6))}  ${p.stage}`;
        }
        if (p.kind === 'mem') return ` ${c.magenta(fancy ? '▣' : '*')} ${p.mem}`;
        const pct = Math.round((params.progress || 0) * 100);
        const eta = params.value > 0 && params.value < params.total ? `ETA ${fmtSecs(((Date.now() - params.startTime) / params.value) * (params.total - params.value))}` : '';
        return (
          ` ${c.green(bar)} ${c.bold(`${params.value}/${params.total}`)} capítulos · ${pct}% · ${fmtSecs(Date.now() - params.startTime)} ${c.dim(eta)}`
        );
      },
    },
    cliProgress.Presets.shades_classic
  );
  const memPayload = () => {
    const s = monitor.sample();
    const used = s.nodeMb + (s.chromeMb ?? 0);
    const txt = memText(s) + c.dim(` · pico ${fmtMb(Math.max(monitor.peak(), used))}`);
    // rojo si queda poca RAM libre
    return s.freeMb < 700 ? c.red(txt) : s.freeMb < 1500 ? c.yellow(txt) : txt;
  };
  const totalBar = multi.create(total, 0, { kind: 'total' });
  const memBar = multi.create(1, 0, { kind: 'mem', mem: memPayload() });
  const nLanes = Math.max(1, Math.floor(opts.lanes ?? 1));
  type LaneState = { bar: cliProgress.SingleBar; chapter: string; stage: string; t0: number };
  const lanes: LaneState[] = [];
  const getLane = (id: number): LaneState => {
    while (lanes.length <= id) {
      const n = lanes.length;
      lanes.push({ bar: multi.create(STAGES.length, 0, { kind: 'lane', lane: String(n + 1), chapter: '', stage: '', elapsed: '', spin: ' ' }), chapter: '', stage: '', t0: 0 });
    }
    return lanes[id];
  };
  for (let i = 0; i < nLanes; i++) getLane(i);

  let frame = 0;
  const refresh = () => {
    frame++;
    memBar.update(0, { mem: memPayload() });
    for (const l of lanes) {
      l.bar.update(l.chapter ? stageStep(l.stage) : 0, {
        chapter: l.chapter,
        stage: l.stage,
        elapsed: l.chapter ? fmtSecs(Date.now() - l.t0) : '',
        spin: SPIN[frame % SPIN.length],
      });
    }
  };
  const timer = setInterval(refresh, 125);
  timer.unref();

  setSink((line) => multi.log(line + '\n'));
  // mensajes de otros módulos (console.log/warn) también por encima de las barras
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const toBars = (...a: unknown[]) => multi.log(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ') + '\n');
  console.log = (...a: unknown[]) => toBars(...a);
  console.warn = (...a: unknown[]) => toBars(...a.map((x) => (typeof x === 'string' ? c.yellow(x) : x)));
  console.error = (...a: unknown[]) => toBars(...a.map((x) => (typeof x === 'string' ? c.red(x) : x)));

  let stopped = false;
  return {
    log: (m, level = 2) => {
      if (verbosity() >= level) multi.log(paintLine(m) + '\n');
    },
    tick: () => {
      totalBar.increment(1);
    },
    lane: (id) => ({
      start: (chapter) => {
        const l = getLane(id);
        l.chapter = chapter;
        l.stage = 'abriendo';
        l.t0 = Date.now();
      },
      stage: (s) => {
        getLane(id).stage = s;
      },
      idle: () => {
        const l = getLane(id);
        l.chapter = '';
        l.stage = '';
      },
    }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const l of lanes) l.chapter = '';
      refresh();
      multi.stop();
      setSink(null);
      Object.assign(console, orig);
    },
  };
}
