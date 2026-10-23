import { Page } from 'puppeteer';
import { writeFile, mkdir, readdir, readFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { dirname, join } from 'path';
import { scrollLaunchContent } from './wait-for-chapter-content';
import { delay } from './util/promise';
import sanitize = require('sanitize-filename');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

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
};

// Serializa el documento del iframe de contenido (same-origin) incluyendo el
// Shadow DOM como Declarative Shadow DOM, deduplicando adoptedStyleSheets y
// reescribiendo TODAS las referencias a recursos hacia rutas locales.
async function serializeChapterData(page: Page): Promise<ChapterData> {
  return page.evaluate(() => {
    const empty: ChapterData = {
      ok: false,
      title: '',
      lang: 'es',
      html: '',
      sheets: [],
      assets: {},
      subtopics: [],
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

    const baseHref = doc.baseURI || iframe.src;

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
      if (t.startsWith('#') || t.startsWith('javascript:') || t.startsWith('mailto:'))
        return null;
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
      // url(...)
      let out = css.replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (m, _q, u) => {
          const ref = localRef(u);
          return ref ? `url("${ref}")` : m;
        }
      );
      // @import "..."  (sin url())
      out = out.replace(
        /@import\s+(['"])([^'"]+)\1/gi,
        (m, _q, u) => {
          const ref = localRef(u);
          return ref ? `@import "${ref}"` : m;
        }
      );
      return out;
    };

    const all = deepNodes(doc.body);

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

    for (const el of all) {
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
        if (rel.includes('stylesheet') || rel.includes('icon') || rel.includes('font'))
          setRef(el, 'href');
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
    }

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

    // ---- adoptedStyleSheets deduplicadas + reescritas ----
    const sheets: string[] = [];
    const sheetId = new Map<CSSStyleSheet, number>();
    for (const el of all) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      const adopted = (sr as unknown as { adoptedStyleSheets?: CSSStyleSheet[] })
        .adoptedStyleSheets;
      if (!adopted || !adopted.length) continue;
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
    }

    // ---- serialización manual con Declarative Shadow DOM ----
    const VOID = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr',
    ]);
    const escText = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    const serialize = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return escText(node.nodeValue || '');
      if (node.nodeType === Node.COMMENT_NODE) return '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'noscript' || tag === 'iframe') return '';

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
      return out;
    };

    const html = serialize(doc.documentElement);

    return {
      ok: true,
      title: doc.title || '',
      lang: doc.documentElement.lang || 'es',
      html,
      sheets,
      assets,
      subtopics,
    };
  });
}

async function downloadAsset(
  page: Page,
  absUrl: string,
  dest: string
): Promise<boolean> {
  try {
    const cookies = await page.cookies(absUrl).catch(() => []);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(absUrl, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.netacad.com/',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    if (!res.ok || !res.body) return false;
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    return true;
  } catch {
    return false;
  }
}

async function downloadAssets(
  page: Page,
  assets: Record<string, string>,
  siteDir: string,
  done: Map<string, boolean>
): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const [absUrl, rel] of Object.entries(assets)) {
    if (done.has(rel)) {
      if (!done.get(rel)) failed.add(rel);
      continue;
    }
    const ok = await downloadAsset(page, absUrl, join(siteDir, rel));
    done.set(rel, ok);
    if (!ok) failed.add(rel);
  }
  return failed;
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

  function run() {
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

export async function saveChapterHtml(
  page: Page,
  filePath: string,
  siteDir: string,
  done: Map<string, boolean>,
  chapterId?: string
): Promise<{
  ok: boolean;
  title: string;
  assets: number;
  failed: number;
  subtopics: Subtopic[];
}> {
  await scrollLaunchContent(page);
  await delay(400);
  const data = await serializeChapterData(page);
  if (!data.ok || data.html.length < 200) {
    return { ok: false, title: data.title, assets: 0, failed: 0, subtopics: [] };
  }

  const failed = await downloadAssets(page, data.assets, siteDir, done);

  // Revertir a URL absoluta los recursos que no se pudieron descargar.
  if (failed.size) {
    const invert: Record<string, string> = {};
    for (const [absUrl, rel] of Object.entries(data.assets)) invert[rel] = absUrl;
    const fixRef = (s: string): string => {
      let out = s;
      for (const rel of failed) {
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
  await writeFile(filePath, docHtml, 'utf8');

  let subtopics = filterSubtopics(data.subtopics);
  if (chapterId) {
    const fromOutline = await collectOutlineSubtopics(page, chapterId);
    subtopics = mergeSubtopics(subtopics, fromOutline);
  }

  return {
    ok: true,
    title: data.title,
    assets: Object.keys(data.assets).length,
    failed: failed.size,
    subtopics,
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
