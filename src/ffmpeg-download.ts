import { spawn } from 'child_process';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';

/** URL de un manifiesto de streaming (HLS/DASH) por su extensión. */
export function isStreamManifestUrl(url: string): boolean {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export class FfmpegMissingError extends Error {
  permanent = true;
  constructor() {
    super('ffmpeg no está instalado (hace falta para vídeos HLS/DASH; instálalo o define FFMPEG_PATH)');
  }
}

/**
 * Argumentos de ffmpeg para convertir un manifiesto HLS/DASH en un mp4 local sin recodificar.
 * Las cabeceras (cookies, Referer) viajan en -headers: nunca se escriben en logs ni mensajes de error.
 */
export function buildFfmpegArgs(url: string, destPart: string, headers: Record<string, string>): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const ua = headers['User-Agent'] || headers['user-agent'];
  if (ua) args.push('-user_agent', ua);
  const hdr = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  if (hdr) args.push('-headers', hdr);
  args.push('-i', url, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', destPart);
  return args;
}

/** Descarga un stream HLS/DASH a `dest` (mp4) con ffmpeg; escritura atómica (.part -> rename). */
export async function ffmpegDownload(
  url: string,
  dest: string,
  headers: Record<string, string>,
  timeoutMs = 20 * 60_000
): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const part = dest + '.part';
  await rm(part, { force: true }).catch(() => undefined);
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  const args = buildFfmpegArgs(url, part, headers);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      if (err.length < 4000) err += String(d);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg: timeout tras ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new FfmpegMissingError() : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // el comando lleva cookies en -headers: solo se devuelve la salida de error de ffmpeg, recortada
      const msg = err.replace(/\s+/g, ' ').trim().slice(-200);
      const http = msg.match(/HTTP error (\d{3})/i);
      const e = new Error(`ffmpeg falló (código ${code})${msg ? ': ' + msg : ''}`) as Error & { permanent?: boolean };
      if (http && http[1] !== '408' && http[1] !== '429' && http[1][0] === '4') e.permanent = true;
      reject(e);
    });
  });

  try {
    const size = (await stat(part)).size;
    if (size === 0) throw new Error('ffmpeg generó un archivo vacío');
    await rm(dest, { force: true });
    await rename(part, dest);
    return size;
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
}
