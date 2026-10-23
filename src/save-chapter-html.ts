import { Page } from 'puppeteer';
import { writeFile, mkdir, readdir, readFile, rename } from 'fs/promises';
import { join } from 'path';
import { scrollLaunchContent } from './wait-for-chapter-content';
import { inspectContent, waitForContentStable } from './content-probe';
import { getWaitPolicy } from './wait-policy';
import {
  AssetOptions,
  DEFAULT_ASSET_OPTIONS,
  downloadAssets,
} from './download-assets';
import { CHAPTER_FORMAT, verifyChapterHtml } from './verify-chapter';
import sanitize = require('sanitize-filename');

type Subtopic = { sub: string; title: string };

/** Cuestionarios / "Prueba de mi conocimiento" — no van al índice. */
const QUIZ_SUBTOPIC =
  /prueba de mi conocimiento|prueba\s+de\s+conocimiento|knowledge\s+check|exam(en)?\s+(del\s+)?m[oó]dulo|cuestionario\s+(del\s+)?m[oó]dulo|module\s+(practice\s+)?exam/i;

function isQuizSubtopic(title: string): boolean {
  return QUIZ_SUBTOPIC.test(title.trim());
}

function filterSubtopics(subs: Subtopic[]): Subtopic[] {
  return subs.filter((s) => !isQuizSubtopic(s.title));
}

type ChapterData = {
  ok: boolean;
  title: string;
  lang: string;
  html: string;
  sheets: string[];
  // url absoluta -> ruta relativa canónica (p.ej. "assets/img/abc_logo.png")
  assets: Record<string, string>;
  subtopics: Subtopic[];
  /** Resultado de la captura de pestañas (tabs-view). */
  tabs: { widgets: number; tabs: number; captured: number; failed: number };
};

// Serializa el documento del iframe de contenido (same-origin) incluyendo el
// Shadow DOM como Declarative Shadow DOM, deduplicando adoptedStyleSheets y
// reescribiendo TODAS las referencias a recursos hacia rutas locales.
// Además recorre las pestañas (tabs-view) para guardar el panel de CADA pestaña
// (en la web solo el panel activo existe en el DOM).
async function serializeChapterData(page: Page, tabMinMs = 150): Promise<ChapterData> {
  return page.evaluate(async (tabMinMs: number) => {
    const empty: ChapterData = {
      ok: false,
      title: '',
      lang: 'es',
      html: '',
      sheets: [],
      assets: {},
      subtopics: [],
      tabs: { widgets: 0, tabs: 0, captured: 0, failed: 0 },
    };

    const iframe = Array.from(document.querySelectorAll('iframe')).find((f) =>
      (f.src || '').includes('authoring-resources')
    ) as HTMLIFrameElement | undefined;
    if (!iframe) return empty;

    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument;
    } catch {
      doc = null;
    }
    if (!doc || !doc.body) return empty;
    const idoc: Document = doc;

    const baseHref = idoc.baseURI || iframe.src;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // Asentamiento de una pestaña recién mostrada: mínimo `tabMinMs` Y condiciones
    // (2 frames de animación, imágenes del panel cargadas, sin skeleton/spinner visible).
    // En pestañas en segundo plano (descarga en paralelo) requestAnimationFrame puede no dispararse nunca: se limita con un temporizador.
    const raf = () =>
      new Promise<void>((r) => {
        const t = setTimeout(r, 120);
        requestAnimationFrame(() => {
          clearTimeout(t);
          r();
        });
      });
    const settlePanelOf = async (getPanel: () => Element | undefined) => {
      const t0 = Date.now();
      await raf();
      await raf();
      while (Date.now() - t0 < 2000) {
        const p = getPanel();
        if (!p) break;
        const imgs = Array.from(p.querySelectorAll('img')) as HTMLImageElement[];
        const busy = Array.from(p.querySelectorAll('*')).some((e) => {
          const c = (e.getAttribute('class') || '').toLowerCase();
          return /skeleton|shimmer|spinner/.test(c) && (e as HTMLElement).getClientRects().length > 0;
        });
        if (imgs.every((im) => im.complete) && !busy) break;
        await sleep(50);
      }
      const rest = tabMinMs - (Date.now() - t0);
      if (rest > 0) await sleep(rest);
    };

    const deepNodes = (root: ParentNode): Element[] => {
      const out: Element[] = [];
      const visit = (node: ParentNode) => {
        const kids = node.children;
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i];
          out.push(el);
          if (el.shadowRoot) visit(el.shadowRoot);
          visit(el);
        }
      };
      visit(root);
      return out;
    };

    // ---- Registro de recursos -> ruta local ----
    const assets: Record<string, string> = {};
    const hashStr = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(36);
    };
    const FONT = ['woff2', 'woff', 'ttf', 'otf', 'eot'];
    const IMG = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];
    const VID = ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mp3', 'wav'];
    const FILE = [
      'pdf', 'pka', 'pkt', 'pksz', 'pkz', 'zip', 'doc', 'docx', 'ppt',
      'pptx', 'xls', 'xlsx', 'txt', 'csv', 'json',
    ];
    const catFor = (ext: string): string => {
      if (FONT.includes(ext)) return 'fonts/';
      if (IMG.includes(ext)) return 'img/';
      if (VID.includes(ext)) return 'video/';
      if (ext === 'css') return 'css/';
      if (FILE.includes(ext)) return 'files/';
      return 'other/';
    };

    const resolve = (url: string): string | null => {
      if (!url) return null;
      const t = url.trim();
      if (!t || t.startsWith('data:') || t.startsWith('blob:')) return null;
      // referencias a ids internos de SVG: url(#clip0) o su forma codificada %23clip0
      if (t.startsWith('#') || t.startsWith('%23')) return null;
      // ya reescrita por nosotros (procesar dos veces un mismo nodo no debe duplicar rutas)
      if (t.startsWith('../assets/')) return null;
      if (t.startsWith('javascript:') || t.startsWith('mailto:')) return null;
      try {
        const u = new URL(t, baseHref);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.href;
      } catch {
        return null;
      }
    };

    // Devuelve la ruta relativa (desde chapters/) para usar en el HTML.
    const localRef = (rawUrl: string): string | null => {
      const abs = resolve(rawUrl);
      if (!abs) return null;
      if (!assets[abs]) {
        let path = '';
        let ext = '';
        try {
          const u = new URL(abs);
          path = u.pathname;
        } catch {
          path = abs;
        }
        let base = (path.split('/').pop() || 'asset').toLowerCase();
        const dot = base.lastIndexOf('.');
        if (dot > 0) ext = base.slice(dot + 1).replace(/[^a-z0-9]/g, '');
        base = base.replace(/[^a-z0-9._-]/g, '_').slice(-48) || 'asset';
        const canonical = 'assets/' + catFor(ext) + hashStr(abs) + '_' + base;
        assets[abs] = canonical;
      }
      // los HTML de capítulo viven en chapters/, los assets en assets/
      return '../' + assets[abs];
    };

    const rewriteCss = (css: string): string => {
      if (!css) return css;
      // url(...) con comillas que respetan escapes: así un data:image/svg+xml con
      // url(%23clip) dentro NO se parte ni se reescribe (localRef ignora data:).
      let out = css.replace(
        /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)\s'"]+))\s*\)/gi,
        (m, dq, sq, bare) => {
          const u = (dq ?? sq ?? bare ?? '') as string;
          const ref = localRef(u);
          return ref ? `url("${ref}")` : m;
        }
      );
      // @import "..."  (sin url())
      out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, _q, u) => {
        const ref = localRef(u);
        return ref ? `@import "${ref}"` : m;
      });
      return out;
    };

    const LINK_EXT = new Set(FILE);
    const hasFileExt = (url: string): boolean => {
      try {
        const p = new URL(url, baseHref).pathname.toLowerCase();
        const ext = p.split('.').pop() || '';
        return LINK_EXT.has(ext);
      } catch {
        return false;
      }
    };

    const setRef = (el: Element, attr: string) => {
      const val = el.getAttribute(attr);
      if (!val) return;
      const ref = localRef(val);
      if (ref) el.setAttribute(attr, ref);
    };

    // Reescribe las referencias de UN elemento (atributos y style inline).
    const processElement = (el: Element) => {
      const tag = el.tagName.toLowerCase();

      if (tag === 'img' || tag === 'source' || tag === 'video' ||
          tag === 'audio' || tag === 'track' || tag === 'embed') {
        setRef(el, 'src');
        setRef(el, 'poster');
        const ss = el.getAttribute('srcset');
        if (ss) {
          const rewritten = ss
            .split(',')
            .map((part) => {
              const seg = part.trim();
              const sp = seg.split(/\s+/);
              const ref = localRef(sp[0]);
              if (ref) sp[0] = ref;
              return sp.join(' ');
            })
            .join(', ');
          el.setAttribute('srcset', rewritten);
        }
      } else if (tag === 'object') {
        setRef(el, 'data');
      } else if (tag === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        // los favicon se descartan al serializar (no aportan y el servidor devuelve 404/HTML)
        if (rel.includes('stylesheet') || rel.includes('font')) setRef(el, 'href');
      } else if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href && hasFileExt(href)) setRef(el, 'href');
      } else if (tag === 'button') {
        for (const attr of ['data-pdf', 'data-href', 'data-src', 'data-url']) {
          const val = el.getAttribute(attr);
          if (val && (hasFileExt(val) || /\.(pdf|pka|pkt)\b/i.test(val))) {
            setRef(el, attr);
          }
        }
      }

      // Registrar URLs de descarga en atributos data-* (p.ej. botones de práctica)
      for (const attr of ['data-pdf', 'data-href', 'data-src', 'data-url', 'data-download']) {
        const val = el.getAttribute(attr);
        if (val && (hasFileExt(val) || /\.(pdf|pka|pkt)\b/i.test(val))) {
          localRef(val);
        }
      }

      if (el.hasAttribute('poster')) setRef(el, 'poster');

      // style inline
      const style = el.getAttribute('style');
      if (style && style.includes('url(')) {
        el.setAttribute('style', rewriteCss(style));
      }
    };

    // ---- adoptedStyleSheets deduplicadas + reescritas ----
    const sheets: string[] = [];
    const sheetId = new Map<CSSStyleSheet, number>();
    const processAdopted = (el: Element) => {
      const sr = el.shadowRoot;
      if (!sr) return;
      const adopted = (sr as unknown as { adoptedStyleSheets?: CSSStyleSheet[] })
        .adoptedStyleSheets;
      if (!adopted || !adopted.length) return;
      const ids: number[] = [];
      for (const sheet of adopted) {
        let id = sheetId.get(sheet);
        if (id === undefined) {
          let css = '';
          try {
            const rules = sheet.cssRules;
            for (let i = 0; i < rules.length; i++) css += rules[i].cssText + '\n';
          } catch {
            css = '';
          }
          id = sheets.length;
          sheets.push(rewriteCss(css));
          sheetId.set(sheet, id);
        }
        ids.push(id);
      }
      el.setAttribute('data-adopted', ids.join(','));
    };

    // ---- serialización manual con Declarative Shadow DOM ----
    const VOID = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr',
    ]);
    const escText = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    // panels capturados de las pestañas: se añaden tras el panel activo
    const extraAfter = new Map<Element, string[]>();

    const serialize = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return escText(node.nodeValue || '');
      if (node.nodeType === Node.COMMENT_NODE) return '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'noscript' || tag === 'iframe') return '';
      if (tag === 'link' && /\bicon\b/i.test(el.getAttribute('rel') || '')) return '';

      let out = '<' + tag;
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        out += ' ' + attrs[i].name + '="' + escAttr(attrs[i].value) + '"';
      }
      out += '>';
      if (VOID.has(tag)) return out;

      if (el.shadowRoot) {
        out += '<template shadowrootmode="open">';
        const sk = el.shadowRoot.childNodes;
        for (let i = 0; i < sk.length; i++) out += serialize(sk[i]);
        out += '</template>';
      }

      if (tag === 'style') {
        out += rewriteCss(el.textContent || '');
      } else {
        const kids = el.childNodes;
        for (let i = 0; i < kids.length; i++) out += serialize(kids[i]);
      }
      out += '</' + tag + '>';
      const extra = extraAfter.get(el);
      if (extra) out += extra.join('');
      return out;
    };

    // ---- pestañas: capturar el panel de cada pestaña ----
    const tabStats = { widgets: 0, tabs: 0, captured: 0, failed: 0 };
    const expandTabs = async () => {
      const roots: ParentNode[] = [idoc];
      for (const el of deepNodes(idoc.body)) if (el.shadowRoot) roots.push(el.shadowRoot);

      for (const root of roots) {
        const count = root.querySelectorAll('[role="tablist"]').length;
        for (let li = 0; li < count; li++) {
          const getList = () => root.querySelectorAll('[role="tablist"]')[li] as HTMLElement | undefined;
          const getTabs = () =>
            Array.from(getList()?.querySelectorAll('[role="tab"]') ?? []) as HTMLElement[];
          // contenedor del widget = primer ancestro del tablist que contiene algún tabpanel
          const getWidget = (): ParentNode | null => {
            let cur: Element | null = getList() ?? null;
            while (cur) {
              if (cur.querySelector('[role="tabpanel"]')) return cur;
              cur = cur.parentElement;
            }
            return root.querySelector('[role="tabpanel"]') ? root : null;
          };
          const getPanels = () =>
            Array.from(getWidget()?.querySelectorAll('[role="tabpanel"]') ?? []);
          const selectedIndex = () => getTabs().findIndex((t) => t.getAttribute('aria-selected') === 'true');

          const tabs0 = getTabs();
          if (tabs0.length < 2) continue;
          tabStats.widgets++;
          tabStats.tabs += tabs0.length;
          if (getPanels().length >= tabs0.length) {
            tabStats.captured += tabs0.length; // ya están todos en el DOM
            continue;
          }

          const start = Math.max(0, selectedIndex());
          const captured: Array<{ index: number; html: string }> = [];

          for (let i = 0; i < tabs0.length; i++) {
            if (i === start) continue;
            try {
              const btn = getTabs()[i];
              if (!btn) throw new Error('pestaña desaparecida');
              btn.click();
              // espera real: pestaña seleccionada + panel con contenido
              const t0 = Date.now();
              while (Date.now() - t0 < 2500) {
                const p = getPanels()[0];
                if (selectedIndex() === i && p && (p.textContent || '').trim().length + p.querySelectorAll('*').length > 0) break;
                await sleep(50);
              }
              await settlePanelOf(() => getPanels()[0]); // imágenes/estilos del panel recién montado
              const panel = getPanels()[0];
              if (!panel || selectedIndex() !== i) throw new Error('el panel no cambió');
              const pnodes = [panel, ...deepNodes(panel)];
              pnodes.forEach(processElement);
              pnodes.forEach(processAdopted);
              let h = serialize(panel);
              h = h.replace(
                /^<([a-z0-9-]+)/i,
                `<$1 data-ccna-tab="${i}" hidden style="display:none"`
              );
              captured.push({ index: i, html: h });
              tabStats.captured++;
            } catch {
              tabStats.failed++;
            }
          }

          // volver a la pestaña original
          try {
            const back = getTabs()[start];
            if (back && selectedIndex() !== start) {
              back.click();
              const t0 = Date.now();
              while (Date.now() - t0 < 2500 && selectedIndex() !== start) await sleep(50);
              await settlePanelOf(() => getPanels()[0]);
            }
          } catch {
            // ignorar
          }

          const livePanel = getPanels()[0];
          if (livePanel) {
            livePanel.setAttribute('data-ccna-tab', String(start));
            tabStats.captured++;
            if (captured.length) {
              captured.sort((a, b) => a.index - b.index);
              extraAfter.set(livePanel, captured.map((c) => c.html));
            }
          } else {
            tabStats.failed += captured.length;
          }
        }
      }
    };
    try {
      await expandTabs();
    } catch {
      tabStats.failed++;
    }

    // <head> también: hojas de estilo enlazadas, etc.
    const all = [...deepNodes(idoc.head ?? idoc.documentElement), ...deepNodes(idoc.body)];
    for (const el of all) processElement(el);

    // ---- botones "open-dialog" que abren un PDF en un iframe ----
    // Emparejamos cada botón con el PDF del mismo widget Packet Tracer / content-links.
    const dialogBtns = all.filter((e) => {
      const c = e.className && e.className.toString ? e.className.toString() : '';
      return /\bopen-dialog\b/.test(c);
    });
    dialogBtns.forEach((btn) => {
      const widget =
        btn.closest(
          '[class*="packettracer"], [class*="content-links"], [class*="packet-tracer"]'
        ) ?? btn.parentElement;
      let pdfUrl = btn.getAttribute('data-pdf') ?? '';

      if (widget) {
        const pdfLink = widget.querySelector(
          'a[href*=".pdf"], a.download-file[href*=".pdf"]'
        );
        if (pdfLink) pdfUrl = pdfLink.getAttribute('href') || pdfUrl;

        if (!pdfUrl || !/\.pdf/i.test(pdfUrl)) {
          const ifr = widget.querySelector('iframe[src*=".pdf"]');
          if (ifr) pdfUrl = ifr.getAttribute('src') || pdfUrl;
        }
      }

      if (!pdfUrl) {
        const ifr = all.find(
          (e) =>
            e.tagName === 'IFRAME' && /\.pdf/i.test(e.getAttribute('src') || '')
        );
        pdfUrl = ifr?.getAttribute('src') || '';
      }

      const ref = pdfUrl ? localRef(pdfUrl) : null;
      if (ref) btn.setAttribute('data-pdf', ref);
    });

    // Enlaces de descarga directa (.pka, .pdf) en widgets de práctica
    for (const el of all) {
      const cls =
        el.className && el.className.toString ? el.className.toString() : '';
      if (!/\bdownload-file\b/.test(cls)) continue;
      setRef(el, 'href');
    }

    // ---- subtemas (1.0.1, 1.0.2, ...) para el índice ----
    const subtopics: { sub: string; title: string }[] = [];
    const subSeen = new Set<string>();
    const statusPrefix =
      /^\s*(?:(?:completas?|incomplet[oa]s?|complete|incomplete)\s*)?/i;
    const subRe = new RegExp(
      '^\\s*(?:(?:completas?|incomplet[oa]s?|complete|incomplete)\\s*)?(\\d+\\.\\d+\\.\\d+)\\b',
      'i'
    );

    const trySubtopic = (el: Element, txt: string) => {
      const m = txt.match(subRe);
      if (!m) return;
      const num = m[1];
      if (subSeen.has(num)) return;

      const title = txt
        .replace(statusPrefix, '')
        .replace(/^\d+\.\d+\.\d+\s*/i, '')
        .slice(0, 90);

      // Omitir cuestionarios (p.ej. 1.6.4 "Prueba de mi conocimiento")
      const quizRe =
        /prueba de mi conocimiento|prueba\s+de\s+conocimiento|knowledge\s+check|exam(en)?\s+(del\s+)?m[oó]dulo|cuestionario\s+(del\s+)?m[oó]dulo|module\s+(practice\s+)?exam/i;
      if (quizRe.test(title)) return;
      if (el.closest('assessment-loader, [class*="assessment"], [class*="cyu-quiz"]'))
        return;

      subSeen.add(num);
      el.setAttribute('data-sub', num);
      const wrapper = el.closest('.article__header-wrapper');
      if (wrapper) wrapper.setAttribute('data-sub', num);
      subtopics.push({ sub: num, title });
    };

    for (const el of all) {
      const cls =
        el.className && el.className.toString ? el.className.toString() : '';
      const tag = el.tagName.toLowerCase();

      // heading-view expone el título en un atributo (p.ej. "1.6.1 Packet Tracer…")
      if (tag === 'heading-view') {
        const headingtitle = el.getAttribute('headingtitle')?.trim() ?? '';
        if (headingtitle) trySubtopic(el, headingtitle);
      }

      const isHeading =
        /^h[1-6]$/.test(tag) ||
        /js-heading\b|article__title\b|article__header\b|heading\b|title\b/i.test(
          cls
        );

      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 160) continue;

      if (isHeading) {
        trySubtopic(el, txt);
        continue;
      }

      // Actividades/cuestionarios sin clase js-heading (p.ej. 1.6.1, 1.6.2)
      if (txt.length <= 120 && subRe.test(txt)) {
        const childCount = el.children.length;
        if (childCount <= 4) trySubtopic(el, txt);
      }
    }

    for (const el of all) processAdopted(el);

    const html = serialize(idoc.documentElement);

    return {
      ok: true,
      title: idoc.title || '',
      lang: idoc.documentElement.lang || 'es',
      html,
      sheets,
      assets,
      subtopics,
      tabs: tabStats,
    };
  }, tabMinMs);
}

function buildStandaloneHtml(data: ChapterData): string {
  const sheetsJson = JSON.stringify(data.sheets).replace(/<\//g, '<\\/');

  const loader = `
<script id="__ccna_adopted" type="application/json">${sheetsJson}</script>
<script>
(function () {
  try {
    var raw = document.getElementById('__ccna_adopted');
    if (!raw) return;
    var data = JSON.parse(raw.textContent || '[]');
    var cache = data.map(function (css) {
      try { var s = new CSSStyleSheet(); s.replaceSync(css); return s; }
      catch (e) { return null; }
    });
    function apply(root) {
      var hosts = root.querySelectorAll('[data-adopted]');
      for (var i = 0; i < hosts.length; i++) {
        var el = hosts[i];
        if (!el.shadowRoot) continue;
        var ids = (el.getAttribute('data-adopted') || '').split(',');
        var sheets = [];
        for (var j = 0; j < ids.length; j++) {
          var c = cache[parseInt(ids[j], 10)];
          if (c) sheets.push(c);
        }
        try { el.shadowRoot.adoptedStyleSheets = sheets; } catch (e) {}
        apply(el.shadowRoot);
      }
    }
    apply(document);
  } catch (e) { console.error('adopted styles loader', e); }
})();
</script>
<script>
(function () {
  // Rehabilita interacciones que dependían del JS original (eliminado en el
  // snapshot): reproductor de vídeo, transcripción y navegación a subtemas.
  function allRoots() {
    var roots = [document];
    (function visit(root) {
      var els = root.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        if (els[i].shadowRoot) { roots.push(els[i].shadowRoot); visit(els[i].shadowRoot); }
      }
    })(document);
    return roots;
  }

  function fixVideos() {
    allRoots().forEach(function (root) {
      var players = root.querySelectorAll('.video-js');
      players.forEach(function (pl) {
        if (pl.dataset.ccnaDone) return;
        var src = '';
        var srcEl = pl.querySelector('source[type="video/mp4"]') ||
          pl.querySelector('source[src*=".mp4"]') ||
          pl.querySelector('source[src*="assets/video"]');
        if (srcEl) src = srcEl.getAttribute('src') || '';
        var vid = pl.querySelector('video');
        if (!src && vid) {
          var vs = vid.getAttribute('src') || '';
          if (vs.indexOf('.mp4') >= 0) src = vs;
        }
        var poster = pl.getAttribute('poster') ||
          (vid && vid.getAttribute('poster')) || '';
        if (!src) return;
        var n = document.createElement('video');
        n.setAttribute('controls', '');
        n.setAttribute('playsinline', '');
        n.setAttribute('preload', 'metadata');
        if (poster) n.setAttribute('poster', poster);
        n.setAttribute('src', src);
        n.style.width = '100%';
        n.style.height = 'auto';
        n.style.maxHeight = '70vh';
        n.style.background = '#000';
        n.dataset.ccnaDone = '1';
        pl.replaceWith(n);
      });
    });
  }

  function fixTranscripts() {
    allRoots().forEach(function (root) {
      var btns = root.querySelectorAll(
        '.vjs-signedTranscript-widget-toggle-btn, [class*="transcript"][class*="toggle"]'
      );
      btns.forEach(function (btn) {
        if (btn.dataset.ccnaDone) return;
        btn.dataset.ccnaDone = '1';
        btn.addEventListener('click', function () {
          var scope = btn.getRootNode();
          var content = scope.querySelector(
            '.vjs-signedTranscript-widget-content-container, [class*="transcript"][class*="content"]'
          );
          if (content) {
            var hidden = getComputedStyle(content).display === 'none';
            content.style.display = hidden ? 'block' : 'none';
          }
        });
      });
    });
  }

  function fixPdfButtons() {
    allRoots().forEach(function (root) {
      var btns = root.querySelectorAll('[data-pdf]');
      btns.forEach(function (el) {
        if (el.dataset.ccnaPdf) return;
        el.dataset.ccnaPdf = '1';
        el.style.cursor = 'pointer';
        el.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          window.open(el.getAttribute('data-pdf'), '_blank');
        });
      });
    });
  }

  function scrollToHash() {
    var h = decodeURIComponent((location.hash || '').replace('#', ''));
    var m = h.match(/^sub-(.+)$/);
    if (!m) return;
    var num = m[1];
    var roots = allRoots();
    for (var i = 0; i < roots.length; i++) {
      var t = roots[i].querySelector('[data-sub="' + num + '"]');
      if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
  }

  // Pestañas (tabs-view): en la web solo existía el panel activo; el descargador
  // guardó el panel de cada pestaña con data-ccna-tab="N". Aquí se alternan.
  function fixTabs() {
    allRoots().forEach(function (root) {
      var lists = root.querySelectorAll('[role="tablist"]');
      lists.forEach(function (list) {
        if (list.dataset.ccnaTabs) return;
        var scope = list.getRootNode();
        var panels = scope.querySelectorAll('[data-ccna-tab]');
        if (!panels.length) return;
        list.dataset.ccnaTabs = '1';
        var btns = list.querySelectorAll('[role="tab"]');
        btns.forEach(function (btn, idx) {
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var n = btn.getAttribute('data-index');
            if (n === null || n === '') n = String(idx);
            n = String(parseInt(n, 10));
            scope.querySelectorAll('[data-ccna-tab]').forEach(function (p) {
              var on = p.getAttribute('data-ccna-tab') === n;
              if (on) { p.removeAttribute('hidden'); p.style.display = ''; }
              else { p.setAttribute('hidden', ''); p.style.display = 'none'; }
            });
            btns.forEach(function (b, j) {
              var sel = b === btn;
              b.setAttribute('aria-selected', sel ? 'true' : 'false');
              b.classList.toggle('isSelected', sel);
            });
          });
        });
      });
    });
  }

  function run() {
    try { fixTabs(); } catch (e) {}
    try { fixVideos(); } catch (e) {}
    try { fixTranscripts(); } catch (e) {}
    try { fixPdfButtons(); } catch (e) {}
    try { scrollToHash(); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(run, 200); });
  } else {
    setTimeout(run, 200);
  }
  window.addEventListener('hashchange', scrollToHash);
})();
</script>`;

  let inner = data.html;
  const meta = `<meta name="ccna-dl-format" content="${CHAPTER_FORMAT}">`;
  if (/<head[^>]*>/i.test(inner)) {
    inner = inner.replace(/<head[^>]*>/i, (m) => m + meta);
  } else {
    inner = inner.replace(/<html[^>]*>/i, (m) => m + '<head>' + meta + '</head>');
  }
  if (/<\/body>/i.test(inner)) {
    inner = inner.replace(/<\/body>/i, loader + '</body>');
  } else {
    inner += loader;
  }

  return '<!DOCTYPE html>\n' + inner;
}

/** Lee subtemas de práctica visibles en el outline lateral (excluye cuestionarios). */
async function collectOutlineSubtopics(
  page: Page,
  sectionPrefix: string
): Promise<Subtopic[]> {
  const raw = await page.evaluate((prefix) => {
    const root =
      document.querySelector('#course-outline') ??
      document.querySelector('[class*="nodeList"]');
    if (!root) return [] as { sub: string; title: string }[];

    const re = new RegExp(`^\\s*(\\d+\\.\\d+\\.\\d+)\\b`);
    const results: { sub: string; title: string }[] = [];
    const seen = new Set<string>();

    root.querySelectorAll('[role="treeitem"], li, button, a, div, span').forEach((el) => {
      const line = (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
      const m = line.match(re);
      if (!m) return;
      const sub = m[1];
      if (!sub.startsWith(prefix + '.') || seen.has(sub)) return;
      seen.add(sub);
      const title = line.replace(/^\s*\d+\.\d+\.\d+\.?\s*/, '').slice(0, 90);
      results.push({ sub, title });
    });

    return results.sort((a, b) => {
      const pa = a.sub.split('.').map(Number);
      const pb = b.sub.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  }, sectionPrefix);

  return filterSubtopics(raw);
}

function mergeSubtopics(a: Subtopic[], b: Subtopic[]): Subtopic[] {
  const bySub = new Map<string, Subtopic>();
  for (const s of filterSubtopics([...a, ...b])) {
    if (!bySub.has(s.sub)) bySub.set(s.sub, s);
  }
  return [...bySub.values()].sort((x, y) => {
    const px = x.sub.split('.').map(Number);
    const py = y.sub.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (px[i] ?? 0) - (py[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

export type SaveChapterResult = {
  ok: boolean;
  title: string;
  assets: number;
  failed: number;
  /** Rutas de assets no descargados -> motivo. */
  failedAssets: Record<string, string>;
  subtopics: Subtopic[];
  /** Problemas de verificación del HTML guardado (vacío = todo bien). */
  problems: string[];
  warnings: string[];
  tabs: { widgets: number; tabs: number; captured: number; failed: number };
  reused: number;
  /** Carga sin terminar al guardar (loader/skeleton visible o imágenes pendientes) tras re-esperar. */
  incomplete?: string;
  /** Se repitió la captura en el sitio porque la primera salió con carga sin terminar. */
  recaptured?: boolean;
};

export type SaveChapterOptions = {
  /** La página ya se desplazó y estabilizó en prepareChapter: no repetir el scroll completo. */
  prescrolled?: boolean;
  /** Re-captura: espera el doble (mínimo y ventana de estabilidad). */
  patient?: boolean;
};

/** Marca de captura con carga sin terminar (el modo reanudar la vuelve a descargar). */
export const INCOMPLETE_META = 'ccna-dl-incomplete';

export async function saveChapterHtml(
  page: Page,
  filePath: string,
  siteDir: string,
  done: Map<string, boolean>,
  chapterId?: string,
  assetOpts: AssetOptions = DEFAULT_ASSET_OPTIONS,
  assetReasons: Map<string, string> = new Map(),
  saveOpts: SaveChapterOptions = {}
): Promise<SaveChapterResult> {
  const none = (title = ''): SaveChapterResult => ({
    ok: false,
    title,
    assets: 0,
    failed: 0,
    failedAssets: {},
    subtopics: [],
    problems: [],
    warnings: [],
    tabs: { widgets: 0, tabs: 0, captured: 0, failed: 0 },
    reused: 0,
  });

  const pol = getWaitPolicy();
  const tabMinMs = pol.fast ? 100 : 150;
  let data!: ChapterData;
  let recaptured = false;
  let firstWhy = '';
  let unfinished: { strong: string[]; weak: string[] } = { strong: [], weak: [] };
  // Hasta 2 pasadas: si tras serializar aún hay loader/skeleton visible o imágenes
  // pendientes, se espera más (el doble) y se vuelve a capturar UNA vez.
  for (let pass = 0; pass < 2; pass++) {
    const patient = pass > 0 || !!saveOpts.patient;
    if (pass > 0 || !saveOpts.prescrolled) await scrollLaunchContent(page);
    await waitForContentStable(page, {
      quietMs: patient ? pol.stableMs * 2 : pol.stableMs,
      maxMs: patient ? pol.maxStableMs * 2 : Math.min(pol.maxStableMs, 4000),
      minMs: patient ? pol.minWaitMs : 0,
    });
    const prev = pass > 0 && data?.ok ? data : null;
    data = await serializeChapterData(page, tabMinMs);
    if (!data.ok) break;
    // La serialización reescribe las referencias en el DOM vivo: en la 2ª pasada los recursos de
    // la 1ª ya aparecen como locales y no se volverían a listar. Se conservan los de ambas pasadas.
    if (prev) data.assets = { ...prev.assets, ...data.assets };
    let insp = await inspectContent(page).catch(() => null);
    // imágenes que acaban de re-montarse (p. ej. al volver a la pestaña inicial): darles un momento
    for (let i = 0; i < 12 && insp && insp.loaders.length === 0 && insp.imgsPending > 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      insp = await inspectContent(page).catch(() => null);
    }
    unfinished = {
      strong: insp ? [...insp.loaders, ...(insp.imgsPending ? [`${insp.imgsPending} imagen(es) sin cargar`] : [])] : [],
      weak: insp ? insp.empties : [],
    };
    if (unfinished.strong.length === 0) break;
    if (pass === 0) {
      recaptured = true;
      firstWhy = [...new Set(unfinished.strong)].slice(0, 3).join(', ');
    }
  }
  if (!data.ok || data.html.length < 200) {
    return { ...none(data.title), problems: ['no se encontró el contenido del capítulo (iframe vacío)'] };
  }

  const batch = await downloadAssets(
    page,
    data.assets,
    siteDir,
    done,
    assetOpts,
    assetReasons
  );
  const failed = batch.failed;

  // Revertir a URL absoluta los recursos que no se pudieron descargar.
  if (failed.size) {
    const invert: Record<string, string> = {};
    for (const [absUrl, rel] of Object.entries(data.assets)) invert[rel] = absUrl;
    const fixRef = (s: string): string => {
      let out = s;
      for (const rel of failed.keys()) {
        const abs = invert[rel];
        if (!abs) continue;
        out = out.split('../' + rel).join(abs);
      }
      return out;
    };
    data.html = fixRef(data.html);
    data.sheets = data.sheets.map(fixRef);
  }

  const docHtml = buildStandaloneHtml(data);

  // Verificación previa a escribir: contenido no vacío, sin spinner/errores.
  const check = verifyChapterHtml(docHtml);
  if (!check.ok && check.textLength < 80) {
    // no se sobrescribe un buen archivo anterior con una página vacía
    return {
      ...none(data.title),
      problems: check.problems,
      warnings: check.warnings,
      tabs: data.tabs,
    };
  }
  const incomplete = unfinished.strong.length
    ? `carga sin terminar al guardar: ${[...new Set(unfinished.strong)].slice(0, 3).join(', ')}`
    : '';
  const finalHtml = incomplete
    ? docHtml.replace(/<\/head>/i, `<meta name="${INCOMPLETE_META}" content="1">\n</head>`)
    : docHtml;
  await mkdir(join(siteDir, 'chapters'), { recursive: true });
  // escritura atómica: un corte (Ctrl+C, apagón) nunca deja un capítulo a medias
  const part = `${filePath}.part`;
  await writeFile(part, finalHtml, 'utf8');
  await rename(part, filePath);

  let subtopics = filterSubtopics(data.subtopics);
  if (chapterId) {
    const fromOutline = await collectOutlineSubtopics(page, chapterId);
    subtopics = mergeSubtopics(subtopics, fromOutline);
  }

  const warnings = [...check.warnings];
  // Recursos que el servidor dice que no existen (404/410, o 403 cuando el resto de recursos
  // sí se descargó, es decir, la sesión es válida): son referencias rotas del propio curso
  // (p.ej. imágenes de fondo de los cuestionarios). Reintentar no sirve: se anotan como
  // aviso y NO marcan el capítulo como parcial (si no, cada ejecución lo repetiría).
  const totalAssets = Object.keys(data.assets).length;
  const sessionOk = totalAssets - failed.size > 0;
  const missingOnServer: string[] = [];
  for (const [rel, why] of [...failed.entries()]) {
    if (/^HTTP (404|410)\b/.test(why) || (sessionOk && /^HTTP 403\b/.test(why))) {
      missingOnServer.push(why.replace(/^HTTP \d+ \(?/, '').replace(/\)$/, '').slice(0, 140));
      failed.delete(rel);
    }
  }
  if (missingOnServer.length) {
    warnings.push(
      `${missingOnServer.length} recurso(s) no existen en el servidor (404/403, referencias rotas del curso; no se reintentan): ` +
        [...new Set(missingOnServer)].slice(0, 2).join(' | ')
    );
  }
  if (recaptured) {
    warnings.push(incomplete ? 'recapturado una vez; sigue con carga sin terminar' : `recapturado una vez (la primera captura tenía la carga sin terminar: ${firstWhy})`);
  }
  if (!incomplete && unfinished.weak.length) {
    warnings.push(`${unfinished.weak.length} contenedor(es) de contenido vacío(s) (${[...new Set(unfinished.weak)].slice(0, 2).join(', ')})`);
  }
  if (data.tabs.failed > 0) {
    warnings.push(`${data.tabs.failed} pestaña(s) no se pudieron capturar (${data.tabs.captured}/${data.tabs.tabs})`);
  }

  return {
    ok: check.ok,
    title: data.title,
    assets: Object.keys(data.assets).length,
    failed: failed.size,
    failedAssets: Object.fromEntries(failed),
    subtopics,
    problems: check.problems,
    warnings,
    tabs: data.tabs,
    reused: batch.reused,
    incomplete: incomplete || undefined,
    recaptured,
  };
}

export type IndexEntry = {
  chapter: string;
  title: string;
  file: string;
  subtopics?: Subtopic[];
};

function compareChapterIds(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function parseSubtopicsFromSavedHtml(html: string): Subtopic[] {
  const result: Subtopic[] = [];
  const seen = new Set<string>();
  const re = /data-sub="(\d+\.\d+\.\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const sub = m[1];
    if (seen.has(sub)) continue;
    seen.add(sub);
    const chunk = html.slice(m.index, m.index + 8000);
    const tm =
      chunk.match(/class="[^"]*headingtitle[^"]*"[^>]*>([^<]+)/i) ??
      chunk.match(/<h[1-6][^>]*>([^<]+)/i);
    result.push({ sub, title: tm ? tm[1].trim() : sub });
  }
  return filterSubtopics(result).sort((a, b) => compareChapterIds(a.sub, b.sub));
}

/** Reconstruye entradas del índice a partir de HTML ya guardados en chapters/. */
export async function entriesFromSavedChapters(
  chaptersDir: string
): Promise<IndexEntry[]> {
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const entries: IndexEntry[] = [];

  for (const file of files) {
    if (!file.endsWith('.html')) continue;
    const chapter = file.replace(/\.html$/i, '');
    const html = await readFile(join(chaptersDir, file), 'utf8');
    let title = chapter;
    const tm = html.match(/<title>([^<]+)<\/title>/i);
    if (tm) {
      const parts = tm[1].split('|').map((s) => s.trim());
      title = parts[parts.length - 1] || chapter;
    }
    entries.push({
      chapter,
      title,
      file: `chapters/${file}`,
      subtopics: parseSubtopicsFromSavedHtml(html),
    });
  }

  return entries.sort((a, b) => compareChapterIds(a.chapter, b.chapter));
}

export function mergeIndexEntries(
  onDisk: IndexEntry[],
  savedNow: IndexEntry[]
): IndexEntry[] {
  const byChapter = new Map<string, IndexEntry>();
  for (const entry of onDisk) byChapter.set(entry.chapter, entry);
  for (const entry of savedNow) byChapter.set(entry.chapter, entry);
  return [...byChapter.values()].sort((a, b) =>
    compareChapterIds(a.chapter, b.chapter)
  );
}

export function buildIndexHtml(
  courseTitle: string,
  entries: IndexEntry[]
): string {
  const first = entries[0]?.file ?? '';
  const links = entries
    .map((e) => {
      const subs = (e.subtopics ?? [])
        .map(
          (s) =>
            `<li class="sub"><a href="${e.file}#sub-${escapeHtml(s.sub)}" target="content" data-file="${e.file}">` +
            `<span class="num">${escapeHtml(s.sub)}</span> ` +
            `<span class="t">${escapeHtml(s.title)}</span></a></li>`
        )
        .join('\n');
      return (
        `<li class="chap"><a href="${e.file}" target="content" data-file="${e.file}">` +
        `<span class="num">${escapeHtml(e.chapter)}</span> ` +
        `<span class="t">${escapeHtml(stripChapterPrefix(e.title))}</span></a>` +
        (subs ? `<ul class="subs">\n${subs}\n</ul>` : '') +
        `</li>`
      );
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(courseTitle)}</title>
<style>
  :root { --bar: #1b3a57; --accent: #2e7d32; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; display: flex; height: 100vh; }
  #sidebar { width: 340px; min-width: 280px; background: #f4f6f8; border-right: 1px solid #d6dde4; overflow-y: auto; }
  #sidebar h1 { font-size: 15px; padding: 16px; margin: 0; background: var(--bar); color: #fff; position: sticky; top: 0; }
  #sidebar ul { list-style: none; margin: 0; padding: 0; }
  #sidebar li.chap > a { display: flex; gap: 8px; padding: 10px 16px; text-decoration: none; color: #1b2733; border-bottom: 1px solid #e7ecf1; font-size: 14px; font-weight: 600; }
  #sidebar li.chap > a:hover { background: #e7f1e8; }
  #sidebar .num { color: var(--accent); font-weight: 700; min-width: 42px; }
  #sidebar ul.subs { background: #fbfcfd; }
  #sidebar li.sub > a { display: flex; gap: 8px; padding: 7px 16px 7px 26px; text-decoration: none; color: #41525f; border-bottom: 1px solid #eef2f5; font-size: 13px; }
  #sidebar li.sub > a:hover { background: #eef5ef; }
  #sidebar li.sub .num { color: #6b7b88; font-weight: 600; min-width: 50px; }
  #content { flex: 1; border: 0; height: 100vh; }
</style>
</head>
<body>
<nav id="sidebar">
  <h1>${escapeHtml(courseTitle)}</h1>
  <ul>
${links}
  </ul>
</nav>
<iframe id="content" name="content" src="${first}"></iframe>
<script>
  var links = document.querySelectorAll('#sidebar a');
  function mark(file) {
    links.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-file') === file);
    });
  }
  links.forEach(function (a) {
    a.addEventListener('click', function () { mark(a.getAttribute('data-file')); });
  });
  mark('${first}');
</script>
</body>
</html>`;
}

function stripChapterPrefix(title: string): string {
  if (!title) return '';
  const parts = title.split('|');
  return parts[parts.length - 1].trim() || title;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function chapterFileName(chapter: string): string {
  return sanitize(`${chapter}.html`) || `${chapter}.html`;
}
