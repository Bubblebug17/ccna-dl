import { ffmpegBin } from './platform';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { HTTPRequest, HTTPResponse, Page } from 'puppeteer';

/**
 * Captura de animaciones interactivas (Adobe Animate / CreateJS, lottie, canvas con línea de tiempo…).
 *
 * Problema real (módulo 2, "Función del DR" de 2.3.2): el componente es `<adobe-animate-view>`: un `<canvas>`
 * que el reproductor de Netacad (JS, que NO se guarda en el HTML) dibuja en tiempo de ejecución, unos
 * `<div>` de texto que ese mismo JS anima, y unos controles (`play-pause` + `aa-scrubber`, custom elements).
 * El HTML guardado es una foto estática del DOM: el canvas sale vacío (los píxeles no se serializan), no
 * hay código del reproductor ni URLs de recursos (json/svg/png/audio) y los controles no hacen nada. Por eso
 * no basta con "capturar las peticiones y reescribir URLs": sin el JS del reproductor no hay quién las use.
 *
 * Solución general, sin depender de cómo esté hecho el reproductor: durante la captura en vivo se pulsa
 * play y se GRABA la animación (canvas.captureStream + MediaRecorder -> webm) junto con una línea de tiempo
 * de los cambios en los elementos de texto superpuestos (MutationObserver). Se guarda el webm como asset y en
 * el HTML el canvas se sustituye (script de `buildStandaloneHtml`) por un `<video>` + controles propios
 * (play/pausa, barra, tiempo) que reaplican la línea de tiempo. Funciona abriendo el HTML con file://.
 */

export type AnimationCaptureResult = {
  /** Componentes de animación encontrados. */
  total: number;
  /** Grabados y guardados (data-ccna-anim-src puesto). */
  captured: number;
  /** No se pudieron grabar (se queda el canvas vacío). */
  pending: number;
  /** Bytes de webm guardados. */
  bytes: number;
  notes: string[];
  /** Descripción (sin contenido) de cada componente, para depuración (--debug-network). */
  components: Array<Record<string, unknown>>;
  /** Peticiones de red vistas durante la activación (URL sin tokens). */
  network: NetEntry[];
};

export type NetEntry = { method: string; url: string; status: number | null; type: string; resource: string; failed?: string };

export type AnimationOptions = {
  /** Carpeta del curso: el webm se guarda en `assets/video/`. */
  siteDir: string;
  /** Tiempo máximo de grabación por animación (ms). */
  maxMs?: number;
  log?: (m: string) => void;
};

export const EMPTY_ANIMATIONS: AnimationCaptureResult = { total: 0, captured: 0, pending: 0, bytes: 0, notes: [], components: [], network: [] };

/** Meta que marca "se intentó capturar animaciones" (el modo reanudar no repite en bucle las que no se pudieron). */
export const ANIM_META = 'ccna-dl-anim';

const MAX_WEBM_BYTES = 40 * 1024 * 1024;

/**
 * Quita de una URL lo que pueda ser secreto: usuario/contraseña, valores de la query (se dejan solo los nombres),
 * el fragmento y los tramos de la ruta que parecen tokens (largos y aleatorios).
 */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol + '…';
    const path = u.pathname
      .split('/')
      .map((seg) => (seg.length >= 32 && /^[A-Za-z0-9_\-.=~%]+$/.test(seg) && !/\.[a-z0-9]{2,5}$/i.test(seg) ? '<token>' : seg))
      .join('/');
    const keys = [...new Set([...u.searchParams.keys()])];
    return `${u.protocol}//${u.host}${path}${keys.length ? '?' + keys.map((k) => k + '=…').join('&') : ''}`;
  } catch {
    return String(raw).slice(0, 40) + '…';
  }
}

export async function captureAnimations(page: Page, opts: AnimationOptions): Promise<AnimationCaptureResult> {
  const result: AnimationCaptureResult = { ...EMPTY_ANIMATIONS, notes: [], components: [], network: [] };
  const log = opts.log ?? (() => undefined);

  let found: ComponentInfo[] = [];
  try {
    found = await page.evaluate(listAnimations);
  } catch {
    return result;
  }
  if (found.length === 0) return result;
  result.total = found.length;
  result.components = found.map((c) => ({ ...c }));

  const onResponse = (res: HTTPResponse) => {
    try {
      if (result.network.length >= 400) return;
      const req = res.request();
      result.network.push({
        method: req.method(),
        url: sanitizeUrl(res.url()),
        status: res.status(),
        type: (res.headers()['content-type'] || '').split(';')[0],
        resource: req.resourceType(),
      });
    } catch {
      // respuesta sin cabeceras
    }
  };
  const onFailed = (req: HTTPRequest) => {
    if (result.network.length >= 400) return;
    result.network.push({ method: req.method(), url: sanitizeUrl(req.url()), status: null, type: '', resource: req.resourceType(), failed: req.failure()?.errorText ?? 'fallo' });
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  try {
    const maxMs = opts.maxMs ?? 90_000;
    for (let i = 0; i < found.length; i++) {
      let rec: Recording | null = null;
      try {
        rec = await page.evaluate(recordAnimation, i, maxMs);
      } catch (e) {
        result.notes.push(`animación ${i + 1}: error al grabar (${e instanceof Error ? e.message : String(e)})`);
      }
      if (!rec || !rec.ok || !rec.b64) {
        result.pending++;
        if (rec) result.notes.push(`animación ${i + 1}: ${rec.note || 'no se pudo grabar'}`);
        if (rec) Object.assign(result.components[i], { recorded: false, note: rec.note });
        continue;
      }
      let rel = '';
      try {
        const saved = await saveWebm(opts.siteDir, Buffer.from(rec.b64, 'base64'));
        rel = saved.rel;
        result.bytes += saved.bytes;
      } catch (e) {
        result.pending++;
        result.notes.push(`animación ${i + 1}: no se pudo guardar el vídeo (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      const ok = await page
        .evaluate(attachAnimation, { i, src: '../' + rel, tl: JSON.stringify({ d: rec.durationMs, ov: rec.ov }), w: rec.w, h: rec.h })
        .catch(() => false);
      if (!ok) {
        result.pending++;
        result.notes.push(`animación ${i + 1}: no se pudo marcar el componente`);
        continue;
      }
      result.captured++;
      Object.assign(result.components[i], { recorded: true, durationMs: rec.durationMs, overlays: Object.keys(rec.ov).length, events: rec.events, file: rel });
      log(`    · animación ${i + 1}/${found.length} grabada (${(rec.durationMs / 1000).toFixed(1)} s, ${Math.round(rec.size / 1024)} KB)`);
    }
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
  }
  return result;
}

/** Guarda el webm en `assets/video/anim-<hash>.webm` (escritura atómica; mismo contenido = mismo archivo). */
async function saveWebm(siteDir: string, data: Buffer): Promise<{ rel: string; bytes: number }> {
  if (data.length < 1024) throw new Error('la grabación está vacía');
  if (data.length > MAX_WEBM_BYTES) throw new Error(`la grabación pesa demasiado (${Math.round(data.length / 1048576)} MB)`);
  const dir = join(siteDir, 'assets', 'video');
  await mkdir(dir, { recursive: true });
  const name = `anim-${createHash('sha1').update(data).digest('hex').slice(0, 12)}.webm`;
  const dest = join(dir, name);
  try {
    const st = await stat(dest);
    if (st.size > 0) return { rel: `assets/video/${name}`, bytes: st.size };
  } catch {
    // no existe todavía
  }
  const part = dest + '.part';
  await writeFile(part, data);
  // MediaRecorder no escribe duración ni índice: si hay ffmpeg se remuxa (sin recodificar) para poder buscar con la barra
  const fixed = part + '.fix.webm';
  const ok = await remuxWebm(part, fixed).catch(() => false);
  if (ok) {
    await rm(part, { force: true });
    await rename(fixed, part);
  } else {
    await rm(fixed, { force: true }).catch(() => undefined);
  }
  await rename(part, dest);
  return { rel: `assets/video/${name}`, bytes: (await stat(dest)).size };
}

function remuxWebm(src: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bin = ffmpegBin();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-c', 'copy', '-f', 'webm', dest], { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(false);
      try {
        resolve((await stat(dest)).size > 1024);
      } catch {
        resolve(false);
      }
    });
  });
}

// ───────────────────────── funciones que se ejecutan en la página ─────────────────────────
// (se serializan con toString: no pueden usar nada del ámbito externo)

type ComponentInfo = {
  i: number;
  host: string;
  canvas: { w: number; h: number };
  play: string;
  range: { max: number; value: number } | null;
  overlays: number;
};

type Recording = {
  ok: boolean;
  note: string;
  b64: string;
  size: number;
  durationMs: number;
  w: number;
  h: number;
  /** clave data-ccna-ov -> eventos [t(ms), style, class, texto|null] */
  ov: Record<string, Array<[number, string, string, string | null]>>;
  events: number;
};

/** Marca cada componente (canvas + botón play + control deslizante) con data-ccna-anim y lo describe. */
function listAnimations(): ComponentInfo[] {
  let doc: Document = document;
  const f = Array.from(document.querySelectorAll('iframe')).find((x) => (x.src || '').includes('authoring-resources')) as
    | HTMLIFrameElement
    | undefined;
  if (f && f.contentDocument) doc = f.contentDocument;
  const deep = (root: ParentNode, out: Element[]): Element[] => {
    const kids = root.children;
    for (let k = 0; k < kids.length; k++) {
      out.push(kids[k]);
      const sr = (kids[k] as Element).shadowRoot;
      if (sr) deep(sr, out);
      deep(kids[k], out);
    }
    return out;
  };
  const isRange = (e: Element) => e.tagName === 'INPUT' && (e as HTMLInputElement).type === 'range';
  const isPlay = (e: Element) => {
    const t = e.tagName.toLowerCase();
    if (/^(play-pause|play-button|.*-play-pause)$/.test(t)) return true;
    if (t !== 'button' && e.getAttribute('role') !== 'button') return false;
    const s = ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('class') || '') + ' ' + (e.textContent || '')).toLowerCase();
    return /\b(play|pause|reproducir|pausar)\b|play_circle|pause_circle|play_arrow/.test(s) && !/vjs-big-play-button/.test(s);
  };
  const all = deep(doc, []);
  const out: ComponentInfo[] = [];
  let n = 0;
  for (const c of all) {
    if (c.tagName !== 'CANVAS') continue;
    const cv = c as HTMLCanvasElement;
    if (cv.width < 120 || cv.height < 60) continue;
    // sube hasta un ancestro que contenga controles de reproducción (play + deslizador)
    let box: Element | null = cv.parentElement || ((cv.getRootNode() as ShadowRoot).host ?? null);
    let found: Element | null = null;
    let hops = 0;
    while (box && hops++ < 10) {
      const inner = (box.shadowRoot ? deep(box.shadowRoot, []) : []).concat(deep(box, []));
      if (inner.some(isRange) && inner.some(isPlay)) {
        found = box;
        break;
      }
      box = box.parentElement || ((box.getRootNode() as ShadowRoot).host ?? null);
    }
    if (!found || found.hasAttribute('data-ccna-anim')) continue;
    const inner = (found.shadowRoot ? deep(found.shadowRoot, []) : []).concat(deep(found, []));
    // los controles quedan marcados para ocultarlos offline (los sustituyen otros propios)
    const mark = (e: Element, kind: string) => {
      let top: Element = e;
      for (;;) {
        const rn = top.getRootNode();
        const host = rn instanceof ShadowRoot ? rn.host : null;
        if (host && found!.contains(host)) top = host;
        else break;
      }
      if (top !== found) top.setAttribute('data-ccna-anim-ctl', kind);
    };
    const play = inner.find(isPlay);
    const range = inner.find(isRange) as HTMLInputElement | undefined;
    if (play) mark(play, 'play');
    if (range) mark(range, 'range');
    found.setAttribute('data-ccna-anim', String(n));
    out.push({
      i: n,
      host: found.tagName.toLowerCase() + (found.getRootNode() instanceof ShadowRoot ? ' (shadow)' : ''),
      canvas: { w: cv.width, h: cv.height },
      play: play ? play.tagName.toLowerCase() : '',
      range: range ? { max: Number(range.max) || 100, value: Number(range.value) || 0 } : null,
      overlays: cv.parentElement ? cv.parentElement.querySelectorAll('div').length : 0,
    });
    n++;
  }
  return out;
}

/** Pulsa play en el componente `i` y lo graba (vídeo + línea de tiempo de los textos superpuestos). */
async function recordAnimation(i: number, maxMs: number): Promise<Recording> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fail = (note: string): Recording => ({ ok: false, note, b64: '', size: 0, durationMs: 0, w: 0, h: 0, ov: {}, events: 0 });
  let doc: Document = document;
  const fr = Array.from(document.querySelectorAll('iframe')).find((x) => (x.src || '').includes('authoring-resources')) as
    | HTMLIFrameElement
    | undefined;
  if (fr && fr.contentDocument) doc = fr.contentDocument;
  const deep = (root: ParentNode, out: Element[]): Element[] => {
    const kids = root.children;
    for (let k = 0; k < kids.length; k++) {
      out.push(kids[k]);
      const sr = (kids[k] as Element).shadowRoot;
      if (sr) deep(sr, out);
      deep(kids[k], out);
    }
    return out;
  };
  const box = deep(doc, []).find((e) => e.getAttribute('data-ccna-anim') === String(i));
  if (!box) return fail('componente no encontrado');
  const inner = (box.shadowRoot ? deep(box.shadowRoot, []) : []).concat(deep(box, []));
  const canvases = inner.filter((e) => e.tagName === 'CANVAS') as HTMLCanvasElement[];
  const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!canvas) return fail('sin canvas');
  if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return fail('el navegador no permite grabar el canvas (captureStream/MediaRecorder)');
  const range = inner.find((e) => e.tagName === 'INPUT' && (e as HTMLInputElement).type === 'range') as HTMLInputElement | undefined;
  const playHost = inner.find((e) => e.getAttribute('data-ccna-anim-ctl') === 'play');
  const playEl = (() => {
    if (!playHost) return null;
    const inside = playHost.shadowRoot ? deep(playHost.shadowRoot, []).find((e) => e.tagName === 'BUTTON') : null;
    return (inside as HTMLElement | undefined) ?? (playHost as HTMLElement);
  })();
  if (!playEl) return fail('sin botón de play');

  // elementos superpuestos al canvas (textos que anima el reproductor): se marcan con data-ccna-ov
  const tracked: Element[] = [];
  const overlayRoots: Element[] = [];
  let p: Element | null = canvas.parentElement;
  for (let up = 0; p && up < 4; up++, p = p.parentElement) {
    for (const ch of Array.from(p.children)) {
      if (ch === canvas || ch.contains(canvas) || ch.tagName === 'CANVAS' || ch.hasAttribute('data-ccna-anim-ctl') || ch.querySelector('[data-ccna-anim-ctl]')) continue;
      if (ch.tagName === 'STYLE' || ch.tagName === 'SCRIPT') continue;
      overlayRoots.push(ch);
    }
    if (overlayRoots.length) break;
  }
  for (const r of overlayRoots) {
    tracked.push(r);
    for (const d of Array.from(r.querySelectorAll('*'))) {
      if (d.tagName === 'STYLE' || d.tagName === 'SCRIPT') continue;
      if (tracked.length < 500) tracked.push(d);
    }
  }
  tracked.forEach((e, k) => e.setAttribute('data-ccna-ov', String(k)));
  const stateOf = (e: Element): [string, string, string | null] => [
    e.getAttribute('style') || '',
    e.getAttribute('class') || '',
    e.children.length === 0 ? (e.textContent ?? '') : null,
  ];
  const ov: Recording['ov'] = {};
  let events = 0;
  let t0 = 0;
  const push = (e: Element, t: number) => {
    const k = e.getAttribute('data-ccna-ov');
    if (k === null) return;
    const s = stateOf(e);
    const list = ov[k] || (ov[k] = []);
    const last = list[list.length - 1];
    if (last && last[1] === s[0] && last[2] === s[1] && last[3] === s[2]) return;
    list.push([Math.max(0, Math.round(t)), s[0], s[1], s[2]]);
    events++;
  };

  box.scrollIntoView({ block: 'center' });
  await sleep(700);
  const getValue = () => (range ? Number(range.value) || 0 : 0);
  const max = range ? Number(range.max) || 100 : 100;
  if (range && getValue() > 0) {
    // llevar el deslizador al principio (como haría el usuario)
    range.value = '0';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
  }
  const isPaused = () => {
    const h = playHost as Element;
    return h.hasAttribute('paused') || (h.shadowRoot && /play_circle|play_arrow/.test(h.shadowRoot.textContent || '') && !/pause/.test(h.shadowRoot.textContent || '')) || false;
  };

  // estado inicial de los textos (t = 0) y observación de cambios
  tracked.forEach((e) => push(e, 0));
  const mo = new MutationObserver((recs) => {
    const t = performance.now() - t0;
    const seen = new Set<Element>();
    for (const r of recs) {
      let el: Node | null = r.target;
      if (el && el.nodeType === 3) el = el.parentNode;
      if (el && el.nodeType === 1 && !seen.has(el as Element)) {
        seen.add(el as Element);
        push(el as Element, t);
      }
    }
  });
  const rootsObs = overlayRoots.length ? overlayRoots : [];
  for (const r of rootsObs) mo.observe(r, { attributes: true, attributeFilter: ['style', 'class'], characterData: true, subtree: true, childList: true });

  let stream: MediaStream;
  try {
    stream = canvas.captureStream(30);
  } catch (e) {
    mo.disconnect();
    return fail('captureStream no permitido (canvas contaminado por recursos de otro origen): ' + (e instanceof Error ? e.message : String(e)));
  }
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) {
    mo.disconnect();
    return fail('el navegador no puede grabar webm');
  }
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size) chunks.push(ev.data);
  };
  const stopped = new Promise<void>((r) => {
    recorder.onstop = () => r();
  });
  recorder.start(1000);
  t0 = performance.now();
  const tr = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  if (tr && tr.requestFrame) tr.requestFrame();

  playEl.click();

  // esperar a que arranque y luego a que termine (deslizador al final, parado, o vuelve el icono de "play")
  let started = false;
  let lastVal = getValue();
  let lastChange = performance.now();
  let startedAt = 0;
  let why = '';
  for (;;) {
    await sleep(100);
    const now = performance.now();
    const v = getValue();
    if (v !== lastVal) {
      lastVal = v;
      lastChange = now;
      if (!started && v > 0) {
        started = true;
        startedAt = now;
      }
    }
    if (!started && !isPaused() && now - t0 > 600) {
      started = true;
      startedAt = now;
    }
    if (tr && tr.requestFrame) tr.requestFrame();
    if (now - t0 > maxMs) {
      why = 'límite de tiempo';
      break;
    }
    if (!started && now - t0 > 6000) {
      why = 'no arrancó';
      break;
    }
    if (started && range && v >= max * 0.995) {
      why = 'fin';
      break;
    }
    if (started && range && now - lastChange > 3000) {
      why = 'parada';
      break;
    }
    if (started && !range && now - startedAt > 1500 && isPaused()) {
      why = 'fin';
      break;
    }
    if (started && range && now - startedAt > 1500 && isPaused() && v > 0 && now - lastChange > 800) {
      why = 'fin';
      break;
    }
  }
  await sleep(500);
  const endMs = performance.now() - t0;
  if (tr && tr.requestFrame) tr.requestFrame();
  mo.disconnect();
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  if (!started) return fail('el botón de play no arrancó la animación (el deslizador no avanza)');
  if (why === 'límite de tiempo') return fail(`la animación no terminó en ${Math.round(maxMs / 1000)} s`);
  const blob = new Blob(chunks, { type: mime });
  if (blob.size < 1024) return fail('la grabación salió vacía');
  if (blob.size > 40 * 1024 * 1024) return fail(`la grabación pesa demasiado (${Math.round(blob.size / 1048576)} MB)`);
  const b64 = await new Promise<string>((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
    rd.onerror = () => reject(new Error('lectura de la grabación'));
    rd.readAsDataURL(blob);
  });
  return { ok: true, note: why, b64, size: blob.size, durationMs: Math.round(endMs), w: canvas.width, h: canvas.height, ov, events };
}

/** Marca el componente con el vídeo grabado y su línea de tiempo (el script offline lo activa). */
function attachAnimation(a: { i: number; src: string; tl: string; w: number; h: number }): boolean {
  let doc: Document = document;
  const fr = Array.from(document.querySelectorAll('iframe')).find((x) => (x.src || '').includes('authoring-resources')) as
    | HTMLIFrameElement
    | undefined;
  if (fr && fr.contentDocument) doc = fr.contentDocument;
  const find = (root: ParentNode): Element | null => {
    const kids = root.children;
    for (let k = 0; k < kids.length; k++) {
      if (kids[k].getAttribute('data-ccna-anim') === String(a.i)) return kids[k];
      const sr = (kids[k] as Element).shadowRoot;
      const x = sr ? find(sr) : null;
      if (x) return x;
      const y = find(kids[k]);
      if (y) return y;
    }
    return null;
  };
  const box = find(doc);
  if (!box) return false;
  box.setAttribute('data-ccna-anim-src', a.src);
  box.setAttribute('data-ccna-anim-tl', a.tl);
  box.setAttribute('data-ccna-anim-w', String(a.w));
  box.setAttribute('data-ccna-anim-h', String(a.h));
  return true;
}
