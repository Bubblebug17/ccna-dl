import * as cliProgress from 'cli-progress';

export type Progress = {
  /** Escribe una línea sin romper la barra. */
  log: (msg: string) => void;
  /** Avanza la barra (un capítulo terminado, de la forma que sea). */
  tick: (info?: string) => void;
  stop: () => void;
};

/**
 * Barra de progreso (cli-progress) con log por encima. Si la salida no es una
 * terminal (CI, redirección a archivo) no se dibuja la barra: solo líneas de log.
 */
export function createProgress(total: number, opts: { enabled?: boolean } = {}): Progress {
  const enabled = (opts.enabled ?? true) && !!process.stdout.isTTY && total > 0;
  if (!enabled) {
    return { log: (m) => console.log(m), tick: () => undefined, stop: () => undefined };
  }
  const multi = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      stopOnComplete: false,
      format: ' {bar} {value}/{total} capítulos · {percentage}% · transcurrido {duration_formatted} · ETA {eta_formatted} {info}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
    },
    cliProgress.Presets.shades_classic
  );
  const bar = multi.create(total, 0, { info: '' });
  return {
    log: (m) => multi.log(m + '\n'),
    tick: (info = '') => bar.increment(1, { info }),
    stop: () => multi.stop(),
  };
}
