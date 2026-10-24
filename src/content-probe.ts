import type { Page } from 'puppeteer';
import { delay } from './util/promise';
import { getWaitPolicy } from './wait-policy';

export type ContentInspection = {
  present: boolean;
  /** Firma del DOM: cambia si cambia el nº de nodos, el texto, la altura, las imágenes pendientes o los loaders. */
  sig: string;
  nodes: number;
  height: number;
  text: number;
  imgsPending: number;
  /** Loaders/skeletons/spinners VISIBLES (carga sin terminar), p. ej. "skeleton-text". */
  loaders: string[];
  /** Contenedores de contenido vacíos (indicio débil de carga sin terminar). */
  empties: string[];
  /** ms desde el último cambio en el DOM (MutationObserver dentro del iframe). */
  quietMs: number;
};

/**
 * Inspecciona el documento del iframe de contenido (incluido el Shadow DOM):
 * loaders visibles, imágenes pendientes, contenedores vacíos y tiempo sin mutaciones.
 */
export async function inspectContent(page: Page): Promise<ContentInspection> {
  return page.evaluate(() => {
    const out = {
      present: false,
      sig: '',
      nodes: 0,
      height: 0,
      text: 0,
      imgsPending: 0,
      loaders: [] as string[],
      empties: [] as string[],
      quietMs: 0,
    };
    const f = Array.from(document.querySelectorAll('iframe')).find((x) =>
      (x.src || '').includes('authoring-resources')
    ) as HTMLIFrameElement | undefined;
    let d: Document | null = null;
    try {
      d = f?.contentDocument ?? null;
    } catch {
      d = null;
    }
    if (!f || !d || !d.body) return out;
    const w = f.contentWindow as (Window & { __ccnaMut?: number; __ccnaMO?: MutationObserver; __ccnaObs?: WeakSet<object> }) | null;
    if (!w) return out;
    out.present = true;

    // MutationObserver (childList + texto): marca el último cambio real del DOM
    if (!w.__ccnaMO) {
      w.__ccnaMut = Date.now();
      w.__ccnaObs = new WeakSet();
      w.__ccnaMO = new (w as unknown as typeof globalThis).MutationObserver(() => {
        w.__ccnaMut = Date.now();
      });
    }
    const observe = (root: Node) => {
      if (w.__ccnaObs!.has(root)) return;
      w.__ccnaObs!.add(root);
      w.__ccnaMO!.observe(root, { childList: true, subtree: true, characterData: true });
    };
    observe(d);

    const frameH = f.clientHeight || 600;
    const isShown = (el: Element): boolean => {
      const h = el as HTMLElement;
      if (!h.getClientRects || h.getClientRects().length === 0) return false;
      const r = h.getBoundingClientRect();
      if (r.width <= 4 && r.height <= 4) return false;
      let cur: Element | null = el;
      for (let i = 0; i < 12 && cur; i++) {
        const cs = (cur.ownerDocument.defaultView || w).getComputedStyle(cur);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return false;
        const p: Element | null = cur.parentElement;
        cur = p ?? ((cur.getRootNode() as ShadowRoot).host ?? null);
      }
      return true;
    };

    const STRONG = /skeleton|shimmer|spinner|sgpulse-loader/i;
    const WEAK = /loader|loading|placeholder/i;
    const VIEWISH = /-view$/i;
    const MEDIA = new Set(['IMG', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'EMBED', 'PICTURE']);
    let textLen = 0;

    const walk = (root: ParentNode) => {
      const all = root.querySelectorAll('*');
      out.nodes += all.length;
      all.forEach((el) => {
        const tag = el.tagName;
        const cls = (el.getAttribute('class') || '').toLowerCase();
        if (tag === 'IMG' && !(el as HTMLImageElement).complete) out.imgsPending++;
        if ((tag === 'STYLE' || tag === 'SCRIPT') && !el.shadowRoot) return;
        const id = tag.toLowerCase() + (cls ? '.' + cls.split(/\s+/)[0] : '');
        const busy = el.getAttribute('aria-busy') === 'true';
        // spinners internos del reproductor de vídeo (video.js): el reproductor se sustituye al guardar
        const vjs = /(^|\s)vjs-/.test(cls);
        if (vjs) {
          // no cuenta como carga pendiente
        } else if (STRONG.test(tag) || STRONG.test(cls) || busy) {
          if (isShown(el)) out.loaders.push(id);
        } else if (WEAK.test(cls) && out.loaders.length < 20) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.height > Math.min(frameH * 0.25, 120) && isShown(el)) out.loaders.push(id);
        }
        // contenedores de contenido vacíos (vistas Adapt / cuerpos de componente)
        if (
          (VIEWISH.test(tag) || /component__(body|inner)/.test(cls)) &&
          !el.shadowRoot &&
          (el.textContent || '').trim().length === 0 &&
          !el.querySelector('img,svg,video,audio,canvas,iframe,input,textarea,select,object,embed,picture') &&
          !MEDIA.has(tag)
        ) {
          out.empties.push(id);
        }
        if (el.shadowRoot) {
          observe(el.shadowRoot);
          walk(el.shadowRoot);
        }
      });
    };
    walk(d);
    textLen = (d.body.textContent || '').length;
    // texto de los Shadow DOM (textContent del body no los incluye)
    const shadowText = (root: ParentNode): number => {
      let n = 0;
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) n += (el.shadowRoot.textContent || '').length + shadowText(el.shadowRoot);
      });
      return n;
    };
    textLen += shadowText(d);
    out.text = textLen;
    out.height = d.documentElement.scrollHeight;
    out.quietMs = Date.now() - (w.__ccnaMut ?? Date.now());
    out.sig = `${out.nodes}:${out.height}:${out.text}:${out.imgsPending}:${out.loaders.length}`;
    return out;
  });
}

export type StableResult = { stable: boolean; last: ContentInspection; waitedMs: number };

/**
 * Espera hasta que el contenido esté "terminado": sin loaders/skeletons visibles,
 * sin imágenes pendientes, firma del DOM sin cambios y sin mutaciones durante
 * `quietMs`. Con `minMs` además exige que hayan pasado al menos esos ms desde `since`.
 * Si no se cumple en `maxMs`, devuelve stable=false (el llamador decide).
 */
export async function waitForContentStable(
  page: Page,
  opts: { quietMs?: number; maxMs?: number; minMs?: number; since?: number } = {}
): Promise<StableResult> {
  const pol = getWaitPolicy();
  const quietMs = opts.quietMs ?? pol.stableMs;
  const maxMs = opts.maxMs ?? pol.maxStableMs;
  const minMs = opts.minMs ?? 0;
  const since = opts.since ?? Date.now();
  const t0 = Date.now();
  let lastSig = '';
  let sigSince = Date.now();
  let last: ContentInspection | undefined;
  while (true) {
    try {
      last = await inspectContent(page);
      if (last.present) {
        if (last.sig !== lastSig) {
          lastSig = last.sig;
          sigSince = Date.now();
        }
        const calm = Date.now() - sigSince >= quietMs && last.quietMs >= quietMs;
        const done = last.loaders.length === 0 && last.imgsPending === 0 && calm;
        if (done && Date.now() - since >= minMs) return { stable: true, last, waitedMs: Date.now() - t0 };
      }
    } catch {
      // la página puede estar navegando
    }
    if (Date.now() - t0 >= maxMs) {
      return {
        stable: false,
        last: last ?? ({ present: false, sig: '', nodes: 0, height: 0, text: 0, imgsPending: 0, loaders: [], empties: [], quietMs: 0 } as ContentInspection),
        waitedMs: Date.now() - t0,
      };
    }
    await delay(100);
  }
}
