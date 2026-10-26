import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Termux (Android): PREFIX dentro de com.termux, TERMUX_VERSION, o Node compilado para Android.
 * CCNA_DL_TERMUX=1 lo fuerza (y =0 lo desactiva), útil para probar en otro Linux.
 */
export function isTermux(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.CCNA_DL_TERMUX === '0') return false;
  if (env.CCNA_DL_TERMUX === '1') return true;
  return platform === 'android' || !!env.TERMUX_VERSION || /com\.termux/.test(env.PREFIX ?? '');
}

/** Valores por defecto de bajo consumo en Termux (el usuario puede sobreescribirlos con las opciones). */
export const TERMUX_DEFAULTS = { concurrency: 1, recycleEvery: 3, assetConcurrency: 3, jsHeapMb: 512 };

const isExec = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Busca un ejecutable en el PATH (y en $PREFIX/bin en Termux). */
export function which(names: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  if (env.PREFIX) dirs.unshift(join(env.PREFIX, 'bin'));
  for (const n of names) for (const d of dirs) if (isExec(join(d, n))) return join(d, n);
  return undefined;
}

export type BrowserChoice = { path?: string; source: string };

/**
 * Navegador a usar:
 *  1. --browser-path
 *  2. PUPPETEER_EXECUTABLE_PATH
 *  3. En Termux: el Chromium del sistema ($PREFIX/bin/chromium-browser o chromium)
 *  4. El Chrome que descarga puppeteer (Windows/macOS/Linux)
 */
export function resolveBrowser(cliPath: string | undefined, env: NodeJS.ProcessEnv = process.env, termux = isTermux(env)): BrowserChoice {
  if (cliPath) return { path: cliPath, source: '--browser-path' };
  if (env.PUPPETEER_EXECUTABLE_PATH) return { path: env.PUPPETEER_EXECUTABLE_PATH, source: 'PUPPETEER_EXECUTABLE_PATH' };
  if (termux) {
    const p = which(['chromium-browser', 'chromium'], env);
    return { path: p, source: p ? 'Chromium de Termux' : 'no encontrado' };
  }
  return { source: 'Chrome de puppeteer' };
}

/** ffmpeg: FFMPEG_PATH, si no el del PATH (incluye $PREFIX/bin en Termux), si no "ffmpeg". */
export function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_PATH || which(process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'], env) || 'ffmpeg';
}

/**
 * RAM disponible real en Linux/Android (/proc/meminfo MemAvailable; os.freemem() da MemFree,
 * que en Android es muy bajo porque la caché ocupa casi todo). undefined si no se puede leer.
 */
export function memAvailableMb(): number | undefined {
  if (process.platform !== 'linux' && process.platform !== ('android' as NodeJS.Platform)) return undefined;
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Math.round(Number(m[1]) / 1024) : undefined;
  } catch {
    return undefined;
  }
}

/** Ayuda para la ruta de salida en el almacenamiento compartido de Android. */
export function sharedStorageHint(outDir: string): string | undefined {
  if (!/storage\/(shared|emulated)|\/sdcard/.test(outDir)) return undefined;
  const home = process.env.HOME ?? '';
  if (/storage\/shared/.test(outDir) && !existsSync(join(home, 'storage', 'shared'))) {
    return 'No existe ~/storage/shared: ejecuta una vez "termux-setup-storage" y acepta el permiso de almacenamiento.';
  }
  return undefined;
}
