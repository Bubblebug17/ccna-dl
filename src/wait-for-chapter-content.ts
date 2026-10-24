import { log } from './ui/log';
import { Page } from 'puppeteer';
import { delay } from './util/promise';
import { waitForContentStable } from './content-probe';
import { getWaitPolicy } from './wait-policy';

export function isLaunchChapterUrl(url: string): boolean {
  return /\/launch\b/.test(url) && url.includes('view=');
}

function isAuthLoginUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('auth.netacad');
  } catch {
    return false;
  }
}

export async function waitForChapterContent(
  page: Page,
  chapterUrl?: string
): Promise<void> {
  const checkUrl = chapterUrl ?? page.url();
  if (isLaunchChapterUrl(checkUrl)) {
    const loaded = await waitForLaunchChapterContent(page);
    if (!loaded) {
      const chapter = new URL(checkUrl).searchParams.get('_chapter');
      log.warn(
        `  · advertencia: contenido no detectado para ${
          chapter ?? 'capítulo'
        }, capturando de todas formas`
      );
    }
    return;
  }
  await page.waitForSelector('.content-chunks', { timeout: 60000 });
}

async function waitForLaunchShell(page: Page, timeout = 60000): Promise<void> {
  const shellStableMs = getWaitPolicy().shellStableMs;
  const deadline = Date.now() + timeout;
  let stableUrl = '';
  let stableSince = 0;

  while (Date.now() < deadline) {
    let current: string;
    try {
      current = page.url();
    } catch {
      await delay(300);
      continue;
    }

    if (current !== stableUrl) {
      stableUrl = current;
      stableSince = Date.now();
      await delay(300);
      continue;
    }

    if (Date.now() - stableSince < shellStableMs) {
      await delay(200);
      continue;
    }

    if (isAuthLoginUrl(current)) {
      throw new Error(
        'Sesión no válida: redirigido al login al abrir el capítulo'
      );
    }

    try {
      const ready = await page.evaluate(() => {
        return !!(
          document.querySelector('main#main-content') ||
          document.querySelector('[class*="launchContainer"]') ||
          document.querySelector('#marketplace-container')
        );
      });
      if (ready) return;
    } catch {
      // navegación en curso
    }

    await delay(300);
  }

  throw new Error(`Launch UI no cargó. URL actual: ${page.url()}`);
}

// El contenido del capítulo vive en un iframe same-origin
// (www.netacad.com/authoring-resources/index.html) cuyo documento se
// renderiza dentro de un Shadow DOM. Detectamos la carga midiendo el
// scrollHeight real del documento del iframe, no su innerText.
type LaunchContentProbe = {
  crossOrigin: boolean;
  height: number;
  loading: boolean;
  hasIframe: boolean;
  textLength: number;
  hasStructure: boolean;
};

async function probeLaunchContent(page: Page): Promise<LaunchContentProbe> {
  return page.evaluate(() => {
    const result: LaunchContentProbe = {
      crossOrigin: false,
      height: 0,
      loading: true,
      hasIframe: false,
      textLength: 0,
      hasStructure: false,
    };

    const findContentIframe = (): HTMLIFrameElement | null => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      let best: HTMLIFrameElement | null = null;
      let bestArea = 0;
      for (const f of frames) {
        const src = f.src || '';
        if (src.includes('auth.netacad') || src.includes('doubleclick')) continue;
        const rect = f.getBoundingClientRect();
        const area = rect.width * rect.height;
        const isContent = src.includes('authoring-resources') || area > bestArea;
        if (isContent && (src.includes('authoring-resources') || area > 10000)) {
          if (src.includes('authoring-resources')) return f;
          if (area > bestArea) {
            bestArea = area;
            best = f;
          }
        }
      }
      return best;
    };

    const isVisible = (el: HTMLElement): boolean => {
      if (el.clientHeight <= 4 && el.clientWidth <= 4) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) < 0.05) return false;
      return el.getClientRects().length > 0;
    };

    const iframe = findContentIframe();
    if (!iframe) return result;

    result.hasIframe = true;

    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument;
    } catch {
      result.crossOrigin = true;
      return result;
    }

    if (!doc || !doc.body) {
      result.crossOrigin = true;
      return result;
    }

    result.loading = Array.from(
      doc.querySelectorAll(
        'sgpulse-loader, [class*="spinner"], [class*="Spinner"], [aria-busy="true"]'
      )
    ).some((el) => isVisible(el as HTMLElement));

    // Loaders genéricos solo cuentan si ocupan gran parte del viewport
    if (!result.loading) {
      const iframeH = iframe.clientHeight || 600;
      result.loading = Array.from(
        doc.querySelectorAll('[class*="loader"], [class*="Loader"]')
      ).some((el) => {
        const h = el as HTMLElement;
        return isVisible(h) && h.clientHeight > Math.min(iframeH * 0.25, 120);
      });
    }

    result.height = doc.documentElement.scrollHeight;
    result.textLength = (doc.body.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .length;
    result.hasStructure = !!doc.querySelector(
      'heading-view, .js-heading, [class*="page__body"], [class*="article__"], .component__body, [class*="packettracer"]'
    );

    return result;
  });
}

const MIN_CONTENT_HEIGHT = 350;
const MIN_CONTENT_TEXT = 100;

function isLaunchContentReady(probe: LaunchContentProbe): boolean {
  if (probe.crossOrigin) return true;
  if (!probe.hasIframe || probe.loading) return false;
  return (
    probe.height >= MIN_CONTENT_HEIGHT ||
    probe.textLength >= MIN_CONTENT_TEXT ||
    probe.hasStructure
  );
}

export async function scrollLaunchContent(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const iframe = Array.from(document.querySelectorAll('iframe')).find((f) =>
        (f.src || '').includes('authoring-resources')
      ) as HTMLIFrameElement | undefined;
      if (!iframe || !iframe.contentWindow || !iframe.contentDocument) return;
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      const h = doc.documentElement.scrollHeight;
      for (let y = 0; y <= h; y += 500) {
        win.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 50));
      }
      win.scrollTo(0, 0);
    })
    .catch(() => undefined);
}

async function waitForLaunchChapterContent(page: Page): Promise<boolean> {
  const pol = getWaitPolicy();
  await waitForLaunchShell(page);

  const deadline = Date.now() + 90000;
  let readyStreak = 0;
  let lastReadyHeight = 0;
  let firstReadyAt = 0;

  // Asentamiento por CONDICIONES (sin loader/skeleton visible, imágenes cargadas,
  // red inactiva, DOM sin mutaciones) Y tiempo mínimo (--min-wait) desde que el
  // contenido apareció. Las condiciones y el mínimo corren a la vez: se espera
  // lo que tarde lo más lento, nunca menos que el mínimo.
  const settle = async (since: number): Promise<boolean> => {
    await scrollLaunchContent(page);
    await Promise.all([
      page
        .waitForNetworkIdle({ idleTime: pol.networkIdleMs, timeout: 10000 })
        .catch(() => undefined),
      delay(Math.max(0, pol.minWaitMs - (Date.now() - since))),
    ]);
    await waitForContentStable(page, { minMs: pol.minWaitMs, since });
    return true;
  };

  while (Date.now() < deadline) {
    const probe = await probeLaunchContent(page);

    if (probe.crossOrigin) {
      await delay(Math.max(4000, pol.minWaitMs));
      return true;
    }

    if (isLaunchContentReady(probe)) {
      if (!firstReadyAt) firstReadyAt = Date.now();
      const growing =
        lastReadyHeight > 0 &&
        probe.height > lastReadyHeight + 120 &&
        probe.loading === false;
      lastReadyHeight = probe.height;

      if (!growing) readyStreak++;
      else readyStreak = 1;

      // Capítulos cortos o primera carga: basta 1 lectura estable
      if (readyStreak >= 1) {
        await delay(300);
        const recheck = await probeLaunchContent(page);
        if (isLaunchContentReady(recheck)) {
          return settle(firstReadyAt);
        }
        readyStreak = 0;
        firstReadyAt = 0;
      }
    } else {
      readyStreak = 0;
      lastReadyHeight = 0;
      firstReadyAt = 0;
    }

    // Primera visita a un capítulo: poll más frecuente mientras carga
    await delay(probe.loading || !probe.hasIframe ? 300 : 400);
  }

  const last = await probeLaunchContent(page);
  if (isLaunchContentReady(last)) {
    return settle(Date.now());
  }

  return false;
}

/** Vuelve a la vista curriculum estable tras escanear el outline (muchos clics). */
export async function restoreLaunchCurriculumPage(
  page: Page,
  referenceUrl?: string
): Promise<void> {
  let target: URL;
  try {
    target = new URL(referenceUrl ?? page.url());
  } catch {
    return;
  }
  if (!/\/launch\b/.test(target.pathname)) return;

  target.searchParams.set('tab', 'curriculum');
  target.searchParams.delete('view');
  target.searchParams.delete('_chapter');

  log.detail('Restaurando vista del curso antes de guardar capítulos…');
  await page.goto(target.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await waitForLaunchShell(page);
  await delay(1200);
}

export async function gotoChapter(
  page: Page,
  chapterUrl: string
): Promise<void> {
  await page.goto(chapterUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  // sin espera fija: waitForChapterContent ya exige la URL estable (shellStableMs) y el contenido asentado
}
