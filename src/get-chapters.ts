import { HTTPResponse, Page } from 'puppeteer';
import * as cliProgress from 'cli-progress';
import { urlToChapter } from './url-to-chapter-id';
import { dropShadowedSubchapters } from './chapter-ids';
import { waitForSpinners } from './wait-for-spinners';
import { delay } from './util/promise';
import { restoreLaunchCurriculumPage } from './wait-for-chapter-content';

const LAUNCH_SECTION = /^(\d+\.\d+)\.?\s+/;
const LEGACY_CHAPTER = /(\d+\.\d+\.1)\b/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChapterEntry = { viewId: string; chapter: string };

type OutlineHelpers = {
  findOutlineSearchInput(): HTMLInputElement | null;
  findOutlineSidebar(): Element | null;
  findScrollableOutline(): Element | null;
  chapterFromLabel(label: string): string | undefined;
  isWantedChapter(chapter: string): boolean;
};

declare global {
  interface Window {
    __ccnaOutline?: OutlineHelpers;
  }
}

/** Barra de progreso para el escaneo del outline (0–100). */
class OutlineScanProgress {
  private bar: cliProgress.SingleBar | null = null;

  start(title = 'Escaneando outline') {
    this.bar = new cliProgress.SingleBar(
      {
        format: `  ${title} |{bar}| {percentage}% | {message}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );
    this.bar.start(100, 0, { message: 'iniciando…' });
  }

  set(percent: number, message: string) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    this.bar?.update(p, { message: message.slice(0, 44) });
  }

  stop() {
    this.bar?.stop();
    this.bar = null;
  }
}

export type GetChapterOptions = {
  /** Solo resolver este capítulo (p. ej. "12.1") con escaneo reducido. */
  only?: string;
};

export async function getChapterUrls(
  page: Page,
  options?: GetChapterOptions
): Promise<string[]> {
  if (isLaunchPage(page.url())) {
    console.log('Getting Launch Chapter URLs');
    if (options?.only) {
      console.log(`Modo capítulo único: ${options.only}`);
    }
    return getLaunchChapterUrls(page, options);
  }
  return getLegacyChapterUrls(page);
}

function isLaunchPage(url: string): boolean {
  return /\/launch\b/.test(url) && url.includes('id=');
}

function compareChapter(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function buildLaunchUrl(
  pageUrl: string,
  viewId: string,
  chapter: string
): string {
  const url = new URL(pageUrl);
  url.searchParams.set('tab', 'curriculum');
  url.searchParams.set('view', viewId);
  url.searchParams.set('_chapter', chapter);
  return url.toString();
}

function chapterFromLabel(label: string): string | undefined {
  const trimmed = label.trim();
  const launch = trimmed.match(LAUNCH_SECTION);
  if (launch) return launch[1];
  const legacy = trimmed.match(LEGACY_CHAPTER);
  return legacy?.[1];
}

function isWantedChapter(chapter: string): boolean {
  return /^\d+\.\d+$/.test(chapter) || /^\d+\.\d+\.1$/.test(chapter);
}

async function injectOutlineHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__ccnaOutline = {
      findOutlineSearchInput() {
        return (
          Array.from(document.querySelectorAll('input')).find((el) => {
            const ph = (el.getAttribute('placeholder') ?? '').toLowerCase();
            return (
              ph.includes('search course outline') || ph.includes('buscar')
            );
          }) ?? null
        );
      },

      findOutlineSidebar() {
        const byId = document.querySelector('#course-outline');
        if (byId) return byId;

        const nodeList = document.querySelector(
          '[class*="nodeList"][class*="LaunchCurriculum"], [class*="outlineContainer"]'
        );
        if (nodeList) return nodeList;

        const search = window.__ccnaOutline!.findOutlineSearchInput();
        if (!search) return null;
        return (
          search.closest(
            'aside, nav, [class*="outline"], [class*="sidebar"], [class*="curriculum"]'
          ) ??
          search.parentElement?.parentElement ??
          search.parentElement
        );
      },

      findScrollableOutline() {
        const candidates: Element[] = [];
        const push = (sel: string) => {
          document.querySelectorAll(sel).forEach((el) => candidates.push(el));
        };
        push('[class*="outlineContainer"]');
        push('#course-outline');
        push('[class*="nodeList"]');

        for (const el of candidates) {
          const style = getComputedStyle(el);
          const scrollable =
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll' ||
            style.overflow === 'auto';
          if (scrollable && el.scrollHeight > el.clientHeight + 30) return el;
        }

        const sidebar = window.__ccnaOutline!.findOutlineSidebar();
        if (sidebar) {
          const style = getComputedStyle(sidebar);
          const scrollable =
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll' ||
            style.overflow === 'auto';
          if (scrollable && sidebar.scrollHeight > sidebar.clientHeight + 30) {
            return sidebar;
          }
        }

        const search = window.__ccnaOutline!.findOutlineSearchInput();
        if (!search) return sidebar ?? null;

        let el = search.parentElement;
        while (el) {
          const style = getComputedStyle(el);
          const scrollable =
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll' ||
            style.overflow === 'auto';
          if (scrollable && el.scrollHeight > el.clientHeight + 30) return el;
          el = el.parentElement;
        }
        return sidebar ?? null;
      },

      chapterFromLabel(label: string) {
        const trimmed = label.trim();
        const launch = trimmed.match(/^(\d+\.\d+)\.?\s+/);
        if (launch) return launch[1];
        const legacy = label.match(/(\d+\.\d+\.1)\b/);
        return legacy?.[1];
      },

      isWantedChapter(chapter: string) {
        return /^\d+\.\d+$/.test(chapter) || /^\d+\.\d+\.1$/.test(chapter);
      },
    };
  });
}

async function getLegacyChapterUrls(page: Page): Promise<string[]> {
  await page.waitForSelector('iframe#contentframe');
  const contentPage = await page.$eval(
    'iframe#contentframe',
    (iframe) => iframe.src
  );
  await page.goto(contentPage, { waitUntil: 'networkidle2' });

  await page.waitForSelector('a.navlink.chunklink');
  await page.$eval('a.navlink.chunklink', (link) => link.click());
  let urls = await page.$$eval('a.navlink.chunklink', (links) =>
    links.map((link) => link.href)
  );
  urls = urls.filter((url) => /^[0-9]+\.[0-9]+\.1$/.test(urlToChapter(url)));
  return urls;
}

async function getLaunchChapterUrls(
  page: Page,
  options?: GetChapterOptions
): Promise<string[]> {
  const onlyChapter = options?.only;
  const fastScan = !!onlyChapter;
  const fromNetwork = new Map<string, string>();
  const jsonBodies: unknown[] = [];

  const onResponse = async (response: HTTPResponse) => {
    try {
      if (!response.ok() || response.status() === 204) return;
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('json')) return;
      if (!response.url().includes('netacad.com')) return;
      const method = response.request().method();
      if (method !== 'GET' && method !== 'POST') return;
      const json = await response.json();
      jsonBodies.push(json);
      extractChapterViews(json, fromNetwork);
    } catch {
      // cuerpo no disponible
    }
  };

  page.on('response', onResponse);
  const progress = new OutlineScanProgress();
  progress.start('Capítulos');
  try {
    progress.set(2, 'Cargando curriculum (API)…');
    await ensureCurriculumTab(page);
    const curriculumUrl = new URL(page.url());
    curriculumUrl.searchParams.set('tab', 'curriculum');
    await page.goto(curriculumUrl.toString(), {
      waitUntil: 'networkidle2',
      timeout: 120_000,
    });
    await waitForSpinners(page).catch(() => undefined);
    await waitForCourseOutline(page);
    await injectOutlineHelpers(page);
    await delay(800);

    progress.set(6, 'Leyendo curriculum (red)…');
    await refetchCurriculumFromNetwork(page, fromNetwork);
    await extractViewsFromPageHtml(page, fromNetwork);
    for (const body of jsonBodies) extractChapterViews(body, fromNetwork);
    const fromNetEarly = entriesFromMap(fromNetwork);
    progress.set(8, `API: ${fromNetEarly.length} capítulos`);

    let fromReact: ChapterEntry[] = [];

    if (fastScan) {
      progress.set(12, `Módulo ${onlyChapter!.split('.')[0]}…`);
      await expandModuleForChapter(page, onlyChapter!);
      await extractViewsFromPageHtml(page, fromNetwork);
      fromReact = await collectViewsFromReactOutline(page);
      progress.set(18, `React: ${fromReact.length} capítulos`);
      for (const { viewId, chapter } of fromReact) {
        fromNetwork.set(viewId, chapter);
      }
    } else {
      progress.set(10, 'Expandiendo módulos…');
      await expandOutlineModules(page, (round, max, clicks) => {
        progress.set(
          8 + (round / max) * 12,
          `Expandiendo módulos (${round}/${max}, ${clicks} clics)`
        );
      });

      progress.set(22, 'Recorriendo sidebar…');
      await exploreOutlineSidebar(page, (pass, step, total) => {
        const base = 22 + pass * 14;
        progress.set(
          base + (step / Math.max(1, total)) * 12,
          `Scroll outline paso ${step}/${total}`
        );
      });

      fromReact = await collectViewsFromReactOutline(page);
      progress.set(40, `React: ${fromReact.length} capítulos`);
      for (const { viewId, chapter } of fromReact) {
        fromNetwork.set(viewId, chapter);
      }
    }

    await refetchCurriculumFromNetwork(page, fromNetwork);
    await extractViewsFromPageHtml(page, fromNetwork);
    for (const body of jsonBodies) extractChapterViews(body, fromNetwork);

    fromReact = mergeChapterEntries(
      fromReact,
      await collectViewsFromReactOutline(page)
    );
    for (const { viewId, chapter } of fromReact) {
      fromNetwork.set(viewId, chapter);
    }
    progress.set(48, `React: ${fromReact.length} capítulos`);

    const fromNet = entriesFromMap(fromNetwork);
    progress.set(52, `Red: ${fromNet.length} capítulos`);

    let fromLinks = await collectViewsFromPageLinks(page);
    progress.set(56, `Enlaces: ${fromLinks.length} capítulos`);

    let fromDom = await collectViewsFromDom(page);
    progress.set(60, `DOM: ${fromDom.length} capítulos`);

    let fromOutline = await collectViewsFromOutlineTree(page);
    progress.set(64, `Outline: ${fromOutline.length} capítulos`);

    if (!fastScan) {
      progress.set(66, 'Segunda pasada del outline…');
      await exploreOutlineSidebar(page, (pass, step, total) => {
        const base = 66 + pass * 8;
        progress.set(
          base + (step / Math.max(1, total)) * 6,
          `Re-explorando ${step}/${total}`
        );
      });
      fromLinks = mergeChapterEntries(
        fromLinks,
        await collectViewsFromPageLinks(page)
      );
      fromDom = mergeChapterEntries(fromDom, await collectViewsFromDom(page));
      fromOutline = mergeChapterEntries(
        fromOutline,
        await collectViewsFromOutlineTree(page)
      );
    }
    progress.set(
      82,
      `Fusionado: ${mergeChapterEntries(fromNet, fromLinks, fromDom, fromOutline, fromReact).length} capítulos`
    );

    let entries = mergeChapterEntries(
      fromNet,
      fromLinks,
      fromDom,
      fromOutline,
      fromReact
    );
    const haveChapters = new Set(entries.map((e) => e.chapter));
    const outlineLabels = await listOutlineChapterLabels(page);
    let missing = outlineLabels.filter((ch) => !haveChapters.has(ch));

    if (onlyChapter && !haveChapters.has(onlyChapter)) {
      missing = [onlyChapter];
    } else if (onlyChapter) {
      missing = [];
    }

    if (missing.length > 0) {
      progress.set(84, `Resolviendo ${missing.length} capítulo(s)…`);
      const startUrl = page.url();
      const fromResolved = await collectViewsForMissingChapters(
        page,
        onlyChapter ? [onlyChapter] : missing,
        startUrl,
        fromNetwork
      );
      if (fromResolved.length < missing.length && !onlyChapter) {
        console.warn(
          `  · ${missing.length - fromResolved.length} capítulo(s) sin view ID tras resolución: ` +
            `${missing
              .filter((ch) => !fromResolved.some((e) => e.chapter === ch))
              .slice(0, 10)
              .join(', ')}${missing.length > 10 ? '…' : ''}`
        );
      }
      entries = mergeChapterEntries(entries, fromResolved);
    }

    if (onlyChapter) {
      entries = entries.filter((e) => e.chapter === onlyChapter);
    }
    progress.set(100, `Total: ${entries.length} capítulos`);
    progress.stop();

    if (entries.length === 0) {
      const sample = await sampleOutlineLabels(page);
      throw new Error(
        'No se encontraron secciones numeradas (p.ej. 1.1, 1.2) en el outline. ' +
          `Muestra: ${sample.slice(0, 8).join(' | ') || '(vacío)'}`
      );
    }

    // "2.2.1 Prueba..." es un sub-elemento de la sección 2.2, no un capítulo: su id de archivo
    // coincidiría con "2.2" y la sobrescribiría.
    const shadow = dropShadowedSubchapters(entries);
    if (shadow.dropped.length) {
      console.warn(
        `  · ${shadow.dropped.length} elemento(s) del outline ignorados por ser sub-elementos de una sección existente: ` +
          `${shadow.dropped.map((e) => e.chapter).slice(0, 10).join(', ')}${shadow.dropped.length > 10 ? '…' : ''}`
      );
      entries = shadow.kept;
    }

    const baseUrl = page.url();
    const urls = entries
      .sort((a, b) => compareChapter(a.chapter, b.chapter))
      .map((entry) => buildLaunchUrl(baseUrl, entry.viewId, entry.chapter));

    await restoreLaunchCurriculumPage(page, baseUrl);
    console.log(`Encontrados ${urls.length} capítulos en el outline.`);
    return urls;
  } finally {
    progress.stop();
    page.off('response', onResponse);
  }
}

function entriesFromMap(found: Map<string, string>): ChapterEntry[] {
  return [...found.entries()]
    .filter(([, chapter]) => isWantedChapter(chapter))
    .map(([viewId, chapter]) => ({ viewId, chapter }));
}

/** Fusiona entradas de varias fuentes; las fuentes posteriores tienen prioridad. */
function mergeChapterEntries(...sources: ChapterEntry[][]): ChapterEntry[] {
  const byChapter = new Map<string, ChapterEntry>();
  for (const entries of sources) {
    for (const entry of entries) {
      byChapter.set(entry.chapter, entry);
    }
  }
  return [...byChapter.values()];
}

async function ensureCurriculumTab(page: Page): Promise<void> {
  const url = new URL(page.url());
  if (url.searchParams.get('tab') === 'curriculum') return;
  url.searchParams.set('tab', 'curriculum');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
}

async function waitForCourseOutline(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return (
        text.includes('Course Outline') ||
        text.includes('Contenido del curso') ||
        text.includes('Search course outline') ||
        text.includes('Buscar en el contenido') ||
        text.includes('Buscar esquema del curso') ||
        /\d+\.\d+\./.test(text) ||
        /\d+\.\d+\.\d+/.test(text)
      );
    },
    { timeout: 60000 }
  );
}

async function expandOutlineModules(
  page: Page,
  onRound?: (round: number, maxRounds: number, clicks: number) => void
): Promise<void> {
  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round++) {
    const clicks = await page.evaluate(() => {
      const sidebar = window.__ccnaOutline?.findOutlineSidebar();
      if (!sidebar) return 0;

      let count = 0;
      const maxClicks = 35;
      const tryClick = (el: Element) => {
        if (count >= maxClicks) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.height > 72) return;
        (el as HTMLElement).click();
        count++;
      };

      sidebar
        .querySelectorAll(
          'button[aria-expanded="false"], [role="button"][aria-expanded="false"]'
        )
        .forEach(tryClick);

      sidebar.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height > 72 || rect.width > 400) return;
        tryClick(el);
      });

      return count;
    });

    onRound?.(round + 1, maxRounds, clicks);
    if (!clicks) break;
    await delay(200);
  }
}

const MAX_OUTLINE_SCROLL_STEPS = 55;

const OUTLINE_ITEM_SELECTORS =
  'button[class*="subModuleBtn"], [role="treeitem"], button, a[href*="view="], li';

async function ensureCurriculumOutlineView(
  page: Page,
  startUrl: string
): Promise<void> {
  let ready = false;
  try {
    ready = await page.evaluate(() => {
      const root =
        document.querySelector('#course-outline') ??
        document.querySelector('[class*="nodeList"]');
      return !!root && /tab=curriculum/.test(location.href);
    });
  } catch {
    ready = false;
  }

  if (ready) return;

  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForSpinners(page).catch(() => undefined);
  await injectOutlineHelpers(page);
  await delay(500);
}

/** Recorre el outline con scroll incremental y expande nodos en cada paso. */
async function exploreOutlineSidebar(
  page: Page,
  onStep?: (pass: number, step: number, totalSteps: number) => void
): Promise<void> {
  await injectOutlineHelpers(page);

  for (let pass = 0; pass < 2; pass++) {
    const info = await page.evaluate(() => {
      const sidebar = window.__ccnaOutline?.findScrollableOutline();
      if (!sidebar) return null;
      return {
        scrollHeight: sidebar.scrollHeight,
        step: Math.max(80, Math.floor(sidebar.clientHeight * 0.4)),
      };
    });

    if (!info) {
      await expandOutlineModules(page);
      return;
    }

    const totalSteps = Math.min(
      MAX_OUTLINE_SCROLL_STEPS,
      Math.ceil((info.scrollHeight + info.step) / info.step)
    );

    for (let step = 0; step < totalSteps; step++) {
      const pos = step * info.step;
      onStep?.(pass, step + 1, totalSteps);

      await page.evaluate((scrollTop) => {
        const scrollEl = window.__ccnaOutline?.findScrollableOutline();
        const root = window.__ccnaOutline?.findOutlineSidebar();
        if (!scrollEl) return;
        scrollEl.scrollTop = scrollTop;

        if (!root) return;
        let n = 0;
        root.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
          if (n >= 12) return;
          const rect = el.getBoundingClientRect();
          if (rect.height > 72 || rect.width === 0) return;
          (el as HTMLElement).click();
          n++;
        });
      }, pos);
      await delay(90);
    }

    await expandOutlineModules(page);
  }

  await page.evaluate(() => {
    const sidebar = window.__ccnaOutline?.findScrollableOutline();
    if (sidebar) sidebar.scrollTop = 0;
  });
}

async function scrollOutlineSidebar(page: Page): Promise<void> {
  await exploreOutlineSidebar(page);
}

async function expandModuleForChapter(page: Page, chapter: string): Promise<void> {
  const moduleNum = chapter.split('.')[0];
  await page.evaluate((mod) => {
    const root = document.querySelector('#course-outline');
    if (!root) return;
    const btn = Array.from(root.querySelectorAll('button')).find((b) => {
      const t = (b as HTMLElement).innerText.trim();
      return (
        new RegExp(`^Módulo ${mod}[:\\.]`, 'i').test(t) ||
        new RegExp(`^Module ${mod}[:\\.]`, 'i').test(t)
      );
    });
    if (btn && btn.getAttribute('aria-expanded') === 'false') {
      (btn as HTMLElement).click();
    }
  }, moduleNum);
  await delay(500);
}

async function extractViewsFromPageHtml(
  page: Page,
  found: Map<string, string>
): Promise<void> {
  const pairs = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const out: { view: string; chapter: string }[] = [];
    const seen = new Set<string>();

    const add = (chapter: string, view: string) => {
      const key = `${chapter}|${view}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ chapter, view });
    };

    const re1 =
      /_chapter(?:%3D|=)(\d+\.\d+)[^"'\\]{0,160}?view(?:%3D|=)([0-9a-f-]{36})/gi;
    const re2 =
      /view(?:%3D|=)([0-9a-f-]{36})[^"'\\]{0,160}?_chapter(?:%3D|=)(\d+\.\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re1.exec(html))) add(m[1], m[2]);
    while ((m = re2.exec(html))) add(m[2], m[1]);

    const headingRe =
      /headingtitle[=:"']+(\d+\.\d+)\.[^"']*["'][^>]{0,120}?modelid[=:"']+([0-9a-f-]{36})/gi;
    while ((m = headingRe.exec(html))) add(m[1], m[2]);

    return out;
  });

  for (const { view, chapter } of pairs) {
    if (isWantedChapter(chapter)) found.set(view, chapter);
  }
}

async function resolveChapterViewViaOutline(
  page: Page,
  chapter: string,
  _networkSink?: Map<string, string>
): Promise<string | null> {
  await injectOutlineHelpers(page).catch(() => undefined);
  await expandModuleForChapter(page, chapter);
  await ensureOutlineChapterVisible(page, chapter);

  const fromReact = await collectViewsFromReactOutline(page);
  const reactHit = fromReact.find((e) => e.chapter === chapter);
  return reactHit?.viewId ?? null;
}

async function collectViewsForMissingChapters(
  page: Page,
  chapters: string[],
  _startUrl: string,
  networkSink?: Map<string, string>
): Promise<ChapterEntry[]> {
  const results: ChapterEntry[] = [];
  const resolved = new Set<string>();

  const modules = [...new Set(chapters.map((ch) => ch.split('.')[0]))].sort(
    (a, b) => Number(a) - Number(b)
  );

  for (const mod of modules) {
    const modChapters = chapters.filter(
      (ch) => ch.startsWith(`${mod}.`) && !resolved.has(ch)
    );
    if (modChapters.length === 0) continue;

    console.log(
      `  · React módulo ${mod} (${modChapters.length} capítulo(s) pendientes)…`
    );
    await expandModuleForChapter(page, modChapters[0]).catch(() => undefined);
    await ensureOutlineChapterVisible(page, modChapters[0]).catch(
      () => undefined
    );
    await delay(300);

    let fromReact: ChapterEntry[] = [];
    try {
      fromReact = await collectViewsFromReactOutline(page);
    } catch (e) {
      console.warn(`  · React falló en módulo ${mod}: ${String(e)}`);
      continue;
    }

    for (const ch of modChapters) {
      const hit = fromReact.find((e) => e.chapter === ch);
      if (hit) {
        results.push(hit);
        resolved.add(ch);
        networkSink?.set(hit.viewId, ch);
        console.log(`  · ${ch} → view=${hit.viewId.slice(0, 8)}…`);
      }
    }
  }

  for (const ch of chapters) {
    if (!resolved.has(ch)) {
      console.warn(`  · no se pudo resolver view para ${ch}`);
    }
  }

  return results;
}

function viewIdFromRecord(record: Record<string, unknown>): string | undefined {
  const typeHint = String(
    record.type ?? record.nodeType ?? record.contentType ?? ''
  ).toLowerCase();
  const skipGenericId = /course|module|container|root|launch|tenant/i.test(
    typeHint
  );

  const viewFields = [
    'view',
    'viewId',
    'contentViewId',
    'pageId',
    'locationId',
    'modelId',
    'modelid',
    'contentObjectId',
    'activityId',
    'contentId',
    'refId',
  ];
  for (const field of viewFields) {
    const v = record[field];
    if (typeof v === 'string' && UUID.test(v)) return v;
  }
  if (!skipGenericId) {
    const id = record.id;
    if (typeof id === 'string' && UUID.test(id)) return id;
  }
  return undefined;
}

function extractChapterViews(
  value: unknown,
  found: Map<string, string>
): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item) => extractChapterViews(item, found));
    return;
  }

  const record = value as Record<string, unknown>;
  const strings = Object.values(record).filter(
    (v): v is string => typeof v === 'string'
  );

  const title = [
    record.title,
    record.name,
    record.label,
    record.displayName,
    record.text,
    record.sectionTitle,
    record.activityTitle,
    record.headingTitle,
    record.headingtitle,
    record.number,
  ].find((v) => typeof v === 'string') as string | undefined;

  const viewId = viewIdFromRecord(record);

  const chapter =
    (title ? chapterFromLabel(title) : undefined) ??
    (typeof record.number === 'string'
      ? chapterFromLabel(record.number) ?? record.number.match(/^(\d+\.\d+)$/)?.[1]
      : undefined) ??
    strings
      .map((s) => chapterFromLabel(s) ?? s.match(/^(\d+\.\d+)$/)?.[1])
      .find((c): c is string => !!c && isWantedChapter(c));

  if (viewId && chapter && isWantedChapter(chapter)) {
    found.set(viewId, chapter);
  }

  for (const s of strings) {
    if (!s.includes('view=') && !s.includes('view%3D')) continue;
    try {
      const normalized = s
        .replace(/view%3D/gi, 'view=')
        .replace(/_chapter%3D/gi, '_chapter=');
      const url = new URL(normalized, 'https://www.netacad.com');
      const vid = url.searchParams.get('view');
      const ch =
        url.searchParams.get('_chapter') ?? chapterFromLabel(s);
      if (vid && UUID.test(vid) && ch && isWantedChapter(ch)) {
        found.set(vid, ch);
      }
    } catch {
      // ignore
    }
  }

  Object.values(record).forEach((child) => extractChapterViews(child, found));
}

async function refetchCurriculumFromNetwork(
  page: Page,
  found: Map<string, string>
): Promise<void> {
  const payloads = await page.evaluate(async () => {
    const urls = [
      ...new Set(
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter(
            (u) =>
              u.includes('netacad.com') &&
              /api\.netacad|curriculum|outline|content|module|launch|activity|tree/i.test(
                u
              )
          )
      ),
    ].slice(-120);

    const results: unknown[] = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const type = res.headers.get('content-type') ?? '';
        if (res.ok && type.includes('json')) {
          results.push(await res.json());
        }
      } catch {
        // ignore
      }
    }
    return results;
  });

  for (const payload of payloads) {
    extractChapterViews(payload, found);
  }
}

async function collectViewsFromPageLinks(
  page: Page
): Promise<ChapterEntry[]> {
  return page.evaluate(() => {
    const helpers = window.__ccnaOutline;
    if (!helpers) return [];

    const results: { viewId: string; chapter: string }[] = [];
    const seen = new Set<string>();
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const add = (viewId: string | null | undefined, label: string) => {
      if (!viewId || !uuid.test(viewId)) return;
      const chapter = helpers.chapterFromLabel(label);
      if (!chapter || !helpers.isWantedChapter(chapter) || seen.has(chapter))
        return;
      seen.add(chapter);
      results.push({ viewId, chapter });
    };

    document.querySelectorAll('[href*="view="]').forEach((el) => {
      const href = (el as HTMLAnchorElement).href;
      try {
        add(
          new URL(href).searchParams.get('view'),
          el.textContent?.trim() ?? ''
        );
      } catch {
        // ignore
      }
    });

    return results;
  });
}

/** View IDs desde props de React en botones subModuleBtn del outline (data.id). */
async function collectViewsFromReactOutline(
  page: Page
): Promise<ChapterEntry[]> {
  return page.evaluate(() => {
    const helpers = window.__ccnaOutline;
    if (!helpers) return [];

    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const results: { viewId: string; chapter: string }[] = [];
    const seen = new Set<string>();

    const viewIdFromData = (data: Record<string, unknown>): string => {
      const candidates = [String(data.id ?? ''), String(data.activityId ?? '')];
      return candidates.find((v) => uuid.test(v)) ?? '';
    };

    type Fiber = {
      memoizedProps?: { data?: Record<string, unknown> };
      pendingProps?: { data?: Record<string, unknown> };
      return?: Fiber;
      child?: Fiber;
    };

    const walkFiber = (fiber: Fiber | undefined, depth = 0): Record<string, unknown> | null => {
      if (!fiber || depth > 25) return null;
      const p = fiber.memoizedProps || fiber.pendingProps;
      const data = p?.data;
      if (
        data &&
        typeof data.displayName === 'string' &&
        /^\d+\.\d+/.test(data.displayName)
      ) {
        return data;
      }
      return (
        walkFiber(fiber.return, depth + 1) || walkFiber(fiber.child, depth + 1)
      );
    };

    const root =
      document.querySelector('#course-outline') ??
      helpers.findOutlineSidebar();
    if (!root) return [];

    root.querySelectorAll('button[class*="subModuleBtn"]').forEach((btn) => {
      const fiberKey = Object.keys(btn).find((k) => k.startsWith('__reactFiber'));
      if (!fiberKey) return;
      const data = walkFiber(
        (btn as unknown as Record<string, Fiber>)[fiberKey]
      );
      if (!data || data.contentType !== 'page') return;

      const displayName = String(data.displayName ?? '');
      const chapter = helpers.chapterFromLabel(displayName);
      if (!chapter || !helpers.isWantedChapter(chapter) || seen.has(chapter)) {
        return;
      }

      const viewId = viewIdFromData(data);
      if (!viewId) return;

      seen.add(chapter);
      results.push({ viewId, chapter });
    });

    return results;
  });
}

async function collectViewsFromOutlineTree(
  page: Page
): Promise<ChapterEntry[]> {
  return page.evaluate(() => {
    const helpers = window.__ccnaOutline;
    const root =
      document.querySelector('#course-outline') ??
      document.querySelector('[class*="nodeList"]') ??
      helpers?.findOutlineSidebar();
    if (!root || !helpers) return [];

    const results: { viewId: string; chapter: string }[] = [];
    const seen = new Set<string>();
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const viewFromNode = (node: Element | null): string | null => {
      for (let el: Element | null = node; el && el !== root; el = el.parentElement) {
        for (const attr of [
          'data-view-id',
          'data-view',
          'data-item-id',
          'data-content-id',
          'data-id',
        ]) {
          const v = el.getAttribute(attr);
          if (v && uuid.test(v)) return v;
        }
        const href =
          el.getAttribute('href') ?? el.getAttribute('data-href') ?? '';
        if (href.includes('view=')) {
          try {
            const v = new URL(href, location.href).searchParams.get('view');
            if (v && uuid.test(v)) return v;
          } catch {
            // ignore
          }
        }
      }
      return null;
    };

    const add = (viewId: string | null | undefined, label: string) => {
      if (!viewId || !uuid.test(viewId)) return;
      const chapter = helpers.chapterFromLabel(label);
      if (!chapter || !helpers.isWantedChapter(chapter) || seen.has(chapter))
        return;
      seen.add(chapter);
      results.push({ viewId, chapter });
    };

    root.querySelectorAll('[role="treeitem"], li, button, a, div, span').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const label = (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
      if (!label || label.length > 120) return;
      const chapter = helpers.chapterFromLabel(label);
      if (!chapter || !helpers.isWantedChapter(chapter)) return;

      add(viewFromNode(el), label);
    });

    return results;
  });
}

async function collectViewsFromDom(page: Page): Promise<ChapterEntry[]> {
  return page.evaluate(() => {
    const helpers = window.__ccnaOutline;
    const sidebar = helpers?.findOutlineSidebar();
    if (!sidebar || !helpers) return [];

    const results: { viewId: string; chapter: string }[] = [];
    const seen = new Set<string>();
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const add = (viewId: string | null | undefined, label: string) => {
      if (!viewId || !uuid.test(viewId)) return;
      const chapter = helpers.chapterFromLabel(label);
      if (!chapter || !helpers.isWantedChapter(chapter) || seen.has(chapter))
        return;
      seen.add(chapter);
      results.push({ viewId, chapter });
    };

    sidebar
      .querySelectorAll('[href*="view="], [data-href*="view="]')
      .forEach((el) => {
        const href =
          el.getAttribute('href') ?? el.getAttribute('data-href') ?? '';
        if (!href.includes('view=')) return;
        try {
          add(new URL(href, location.href).searchParams.get('view'), el.textContent?.trim() ?? '');
        } catch {
          // href relativo inválido
        }
      });

    sidebar.querySelectorAll('button, a, [role="button"], [role="treeitem"], li, div').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.height > 72) return;

      const label = (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
      const chapter = helpers.chapterFromLabel(label);
      if (!chapter || !helpers.isWantedChapter(chapter)) return;

      for (const attr of [
        'data-view-id',
        'data-view',
        'data-item-id',
        'data-id',
        'data-content-id',
      ]) {
        add(el.getAttribute(attr), label);
      }

      let parent: Element | null = el;
      for (let depth = 0; depth < 4 && parent; depth++) {
        for (const attr of ['data-view-id', 'data-view', 'data-item-id']) {
          add(parent.getAttribute(attr), label);
        }
        parent = parent.parentElement;
      }

      const link = el.closest('[href*="view="]') as HTMLAnchorElement | null;
      if (link) {
        try {
          add(new URL(link.href).searchParams.get('view'), label);
        } catch {
          // ignore
        }
      }
    });

    return results;
  });
}

async function ensureOutlineChapterVisible(
  page: Page,
  chapter: string
): Promise<void> {
  try {
    await page.evaluate((ch) => {
      const helpers = window.__ccnaOutline;
      const scrollEl = helpers?.findScrollableOutline();
      const root = helpers?.findOutlineSidebar();
      if (!helpers || !scrollEl || !root) return;

      const chEsc = ch.replace(/\./g, '\\.');
      const lineRe = new RegExp('^\\s*' + chEsc + '\\.');

      const expandFew = () => {
        let n = 0;
        root.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
          if (n >= 10) return;
          const rect = el.getBoundingClientRect();
          if (rect.height > 72 || rect.width === 0) return;
          (el as HTMLElement).click();
          n++;
        });
      };

      const tryFind = (): boolean => {
        const nodes = Array.from(
          root.querySelectorAll(
            '[role="treeitem"], button, a[href*="view="], li'
          )
        );
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          const line =
            (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
          if (!lineRe.test(line)) continue;
          if (helpers.chapterFromLabel(line) !== ch) continue;
          el.scrollIntoView({ block: 'center' });
          return true;
        }
        return false;
      };

      expandFew();
      if (tryFind()) return;

      const step = Math.max(80, Math.floor(scrollEl.clientHeight * 0.4));
      const maxSteps = 40;
      for (let s = 0; s < maxSteps; s++) {
        scrollEl.scrollTop = s * step;
        expandFew();
        if (tryFind()) return;
      }
    }, chapter);
  } catch {
    // outline no disponible; el clic siguiente puede fallar sin tumbar el escaneo
  }
  await delay(200);
}

async function collectViewsByClicking(
  page: Page,
  alreadyHave = new Set<string>(),
  onChapter?: (index: number, total: number, chapter: string) => void
): Promise<ChapterEntry[]> {
  await injectOutlineHelpers(page);

  let targets: { chapter: string; index: number }[] = [];
  try {
    targets = await page.evaluate(
      (skip, itemSelectors) => {
        const helpers = window.__ccnaOutline;
        const sidebar = helpers?.findOutlineSidebar();
        if (!sidebar || !helpers) return [] as { chapter: string; index: number }[];

        const candidates: {
          chapter: string;
          area: number;
          index: number;
        }[] = [];

        Array.from(sidebar.querySelectorAll(itemSelectors)).forEach(
          (el, index) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || rect.height > 80)
              return;

            const label =
              (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
            const chapter = helpers.chapterFromLabel(label);
            if (
              !chapter ||
              !helpers.isWantedChapter(chapter) ||
              skip.includes(chapter)
            )
              return;

            candidates.push({ chapter, area: rect.width * rect.height, index });
          }
        );

        const best = new Map<
          string,
          { chapter: string; area: number; index: number }
        >();
        for (const c of candidates) {
          const prev = best.get(c.chapter);
          if (!prev || c.area < prev.area) best.set(c.chapter, c);
        }

        return [...best.values()]
          .sort((a, b) => a.index - b.index)
          .map(({ chapter, index }) => ({ chapter, index }));
      },
      [...alreadyHave],
      OUTLINE_ITEM_SELECTORS
    );
  } catch (e) {
    console.warn(`    · no se pudo listar capítulos para clic: ${String(e)}`);
    return [];
  }

  if (targets.length === 0) return [];

  const collected = new Map<string, string>();
  const usedViews = new Set<string>();
  const startUrl = page.url();
  const deadline = Date.now() + 300_000;

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() > deadline) {
      console.warn(`    · tiempo agotado tras ${i}/${targets.length} clics`);
      break;
    }

    const { chapter } = targets[i];
    onChapter?.(i + 1, targets.length, chapter);

    try {
      await ensureCurriculumOutlineView(page, startUrl);
      await ensureOutlineChapterVisible(page, chapter);

      const viewBefore = new URL(page.url()).searchParams.get('view');
      const clicked = await page.evaluate(
        (targetChapter, itemSelectors) => {
          const helpers = window.__ccnaOutline;
          const sidebar = helpers?.findOutlineSidebar();
          if (!sidebar || !helpers) return false;

          const nodes = Array.from(sidebar.querySelectorAll(itemSelectors));
          let bestEl: HTMLElement | null = null;
          let bestArea = Infinity;

          for (const el of nodes) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || rect.height > 80)
              continue;

            const label =
              (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
            if (helpers.chapterFromLabel(label) !== targetChapter) continue;

            const area = rect.width * rect.height;
            if (area < bestArea) {
              bestArea = area;
              bestEl = el as HTMLElement;
            }
          }

          if (!bestEl) return false;
          bestEl.scrollIntoView({ block: 'center' });
          bestEl.click();
          return true;
        },
        chapter,
        OUTLINE_ITEM_SELECTORS
      );

      if (!clicked) continue;

      await Promise.race([
        page.waitForFunction(
          (prev) => new URL(location.href).searchParams.get('view') !== prev,
          { timeout: 3000 },
          viewBefore
        ),
        delay(1200),
      ]).catch(() => undefined);

      const stuck = await page
        .evaluate(() => {
          const text = document.body.innerText.trim();
          return text.length < 80 && !text.includes('Course Outline');
        })
        .catch(() => false);

      if (stuck) {
        await page.goto(startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 90_000,
        });
        await waitForSpinners(page).catch(() => undefined);
        await injectOutlineHelpers(page);
        await delay(400);
        continue;
      }

      const viewAfter = new URL(page.url()).searchParams.get('view');
      if (
        viewAfter &&
        viewAfter !== viewBefore &&
        UUID.test(viewAfter) &&
        !usedViews.has(viewAfter)
      ) {
        collected.set(chapter, viewAfter);
        usedViews.add(viewAfter);
      }
    } catch (e) {
      console.warn(`    · capítulo ${chapter} omitido en clic: ${String(e)}`);
      await page
        .goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
        .catch(() => undefined);
      await injectOutlineHelpers(page).catch(() => undefined);
      await delay(400);
    }
  }

  if (collected.size === 0) return [];

  if (page.url() !== startUrl) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await injectOutlineHelpers(page);
  }

  return [...collected.entries()].map(([chapter, viewId]) => ({
    chapter,
    viewId,
  }));
}

/** Capítulos X.Y visibles en el outline lateral (sin view ID). */
async function listOutlineChapterLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const helpers = window.__ccnaOutline;
    const root = document.querySelector('#course-outline') ?? helpers?.findOutlineSidebar();
    if (!root || !helpers) return [] as string[];

    const chapters = new Set<string>();
    root
      .querySelectorAll(
        'button[class*="subModuleBtn"] [class*="subModuleName"], button[class*="subModuleBtn"]'
      )
      .forEach((el) => {
        const title =
          el.getAttribute('title') ??
          (el as HTMLElement).innerText?.trim().split('\n')[0] ??
          '';
        const chapter = helpers.chapterFromLabel(title);
        if (chapter && helpers.isWantedChapter(chapter)) chapters.add(chapter);
      });
    return [...chapters];
  });
}

async function sampleOutlineLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sidebar = window.__ccnaOutline?.findOutlineSidebar();
    if (!sidebar) return [];

    const labels: string[] = [];
    sidebar.querySelectorAll('*').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.height < 16 || rect.height > 56) return;

      const line = (el as HTMLElement).innerText?.trim().split('\n')[0] ?? '';
      if (line.length < 3 || line.length > 90 || labels.includes(line)) return;
      labels.push(line);
    });

    return labels.slice(0, 20);
  });
}
