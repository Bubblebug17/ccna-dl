#!/usr/bin/env node

import './config/env';

import {
  command,
  flag,
  number,
  option,
  optional,
  restPositionals,
  run,
  string,
} from 'cmd-ts';
import { existsSync, readFileSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { spawnSync } from 'child_process';
import puppeteer, { Page } from 'puppeteer';
import { delay } from './util/promise';
import { waitUntil } from './util/retry';
import { mkdir } from 'fs/promises';
import * as inquirer from 'inquirer';
import { waitForSpinners } from './wait-for-spinners';
import {
  gotoChapter,
  isLaunchChapterUrl,
  restoreLaunchCurriculumPage,
  waitForChapterContent,
} from './wait-for-chapter-content';
import { saveLaunchCourseSite, courseSiteDir, chapterIdFromUrl } from './save-course';
import { OnlySpec, parseOnly, wholeModulesOfOnly } from './only-spec';
import {
  OUTLINE_CACHE_FILE,
  chaptersFromCache,
  entriesFromUrls,
  mergeOutlineCache,
  readOutlineCache,
  writeOutlineCache,
} from './outline-cache';
import { setWaitPolicy } from './wait-policy';
import {
  AGGRESSIVE_PATTERNS,
  blockUnneededResources,
  MEDIA_PATTERNS,
  TRACKER_PATTERNS,
} from './block-resources';
import { chromeLaunchArgs } from './browser-args';
import { DEFAULT_RECYCLE_EVERY, DEFAULT_TABS, planTabs } from './memory';
import { DEFAULT_ASSET_OPTIONS } from './download-assets';
import { DEBUG_DIR } from './save-chapter-html';
import { removedFlagErrors } from './removed-flags';
import { login } from './login';
import { buildLaunchUrl, getChapterUrls } from './get-chapters';

const { version } = JSON.parse(
  readFileSync(join(__dirname, '../package.json')).toString()
);

const cmd = command({
  name: 'ccna-dl',
  description:
    'CCNA Downloader\n' +
    '> Downloads courses from https://netacad.com/' +
    version,
  args: {
    urls: restPositionals({
      displayName: 'urls',
      type: string,
      description: 'The urls to the courses you want to download.',
    }),
    user: option({
      long: 'user',
      short: 'u',
      type: optional(string),
      description: 'Your login email/username (not needed with --validate).',
    }),
    password: option({
      long: 'password',
      short: 'p',
      type: optional(string),
      description: 'Your login password.',
    }),
    concurrency: option({
      long: 'concurrency',
      short: 'c',
      type: optional(number),
      description:
        'Páginas descargadas a la vez. Cursos "launch" (HTML offline): pestañas del navegador en paralelo, máximo 6; ' +
        `por defecto ${DEFAULT_TABS} (o menos si hay poca RAM libre). Cada pestaña puede usar ~1 GB; se avisa si no caben en la RAM libre.`,
    }),
    outDir: option({
      long: 'out-dir',
      short: 'o',
      type: string,
      defaultValue: () => '.',
      description: 'The directory, the item should be saved into.',
    }),
    only: option({
      long: 'only',
      type: optional(string),
      description:
        'Descarga solo parte del curso SIN sincronizar el curso entero (solo se lee el outline de esos módulos; una sola sesión). ' +
        'Acepta un capítulo (--only 2.3), un módulo entero (--only 2), varios separados por coma (--only 2.1,2.3,5) y rangos (--only 2.1-2.4, --only 2-4). ' +
        'El índice y el resumen se mezclan con lo ya existente (el resto del curso no se toca). Combínalo con --force para rehacer solo lo pedido.',
    }),
    refreshOutline: flag({
      long: 'refresh-outline',
      description:
        'Con --only: ignora outline-cache.json y vuelve a leer el outline del curso (por defecto, si la caché del curso ya tiene lo pedido, no se escanea).',
    }),
    validate: flag({
      long: 'validate',
      description:
        'Valida OFFLINE (sin login) las descargas de --out-dir y escribe validation-report.md. No descarga nada.',
    }),
    retryFailed: flag({
      long: 'retry-failed',
      description:
        'Descarga solo los capítulos listados en descarga-fallos.json del curso (de la ejecución anterior).',
    }),
    force: flag({
      long: 'force',
      description:
        'Vuelve a descargar todo aunque el capítulo ya exista y esté verificado (por defecto se omiten).',
    }),
    assetConcurrency: option({
      long: 'asset-concurrency',
      type: number,
      defaultValue: () => DEFAULT_ASSET_OPTIONS.concurrency,
      description: 'Descargas simultáneas de recursos (imágenes, fuentes…) por capítulo.',
    }),
    retries: option({
      long: 'retries',
      type: number,
      defaultValue: () => DEFAULT_ASSET_OPTIONS.retries,
      description: 'Reintentos con espera creciente para recursos y capítulos fallidos.',
    }),
    minWait: option({
      long: 'min-wait',
      type: optional(number),
      description:
        'Tiempo mínimo (ms) que el contenido de cada capítulo debe llevar cargado antes de guardarlo, además de las esperas por condición (spinner/skeleton fuera, DOM estable, red inactiva). Por defecto 1500 (500 con --fast).',
    }),
    fast: flag({
      long: 'fast',
      description:
        'Modo rápido (opt-in, menos seguro): esperas mínimas más cortas y bloquea también vídeo/audio y el gestor de etiquetas de Adobe en el navegador. Por defecto se prioriza que la captura sea correcta.',
    }),
    chapterTimeout: option({
      long: 'chapter-timeout',
      type: number,
      defaultValue: () => 300,
      description:
        'Segundos máximos por intento de capítulo; al agotarse se reinicia esa pestaña y se reintenta.',
    }),
    recycleEvery: option({
      long: 'recycle-every',
      type: number,
      defaultValue: () => DEFAULT_RECYCLE_EVERY,
      description:
        'Cada cuántos capítulos se cierra y reabre la pestaña de cada worker para liberar la memoria del navegador ' +
        `(0 = nunca; por defecto ${DEFAULT_RECYCLE_EVERY}). También se recicla antes si el heap de JS es alto o queda poca RAM libre.`,
    }),
    noVideos: flag({
      long: 'no-videos',
      description:
        'No activar los reproductores de vídeo ni descargar vídeos/subtítulos (solo se guarda el póster) y bloquear vídeo/audio en el navegador. Más rápido y ligero; una ejecución posterior sin esta opción solo repite los capítulos que tienen vídeos.',
    }),
    noAnimations: flag({
      long: 'no-animations',
      description:
        'No grabar las animaciones interactivas (Adobe Animate/CreateJS: canvas con botón play y barra). Por defecto se pulsa play y se graba cada una en un webm para verla sin conexión.',
    }),
    debugNetwork: flag({
      long: 'debug-network',
      description:
        'Depuración: guarda <curso>/debug/red-<capítulo>.json con las peticiones de red del capítulo y los componentes de animación detectados (sin cookies, cabeceras ni tokens). Úsalo con --only para un capítulo.',
    }),
    noBlockTrackers: flag({
      long: 'no-block-trackers',
      description:
        'No bloquear analítica/publicidad/seguimiento (Google Analytics, DoubleClick, Hotjar…) en el navegador.',
    }),
    debugScreenshot: flag({
      long: 'debug-screenshot',
      description: 'Depuración: guarda <curso>/debug/course.png (captura de la vista del curso tras el login).',
    }),
    debugHeadful: flag({
      long: 'debug-headful',
      description: 'Depuración: abre el navegador con ventana visible para ver lo que hace.',
    }),
  },
  handler: async (args) => {
    if (args.validate) {
      process.exitCode = runValidator(args.outDir);
      return;
    }
    if (!args.user) {
      console.error('Falta --user (tu correo/usuario de Netacad).');
      process.exitCode = 2;
      return;
    }
    const user: string = args.user;

    if (args.urls.length < 1) {
      console.error('Please specify at least one url leading to a course.');
      return;
    }
    const notLaunch = args.urls.filter((u) => !/\/launch\b/.test(u));
    if (notLaunch.length) {
      console.error(
        `Solo se admiten cursos "launch" (https://www.netacad.com/.../launch?id=…). La interfaz clásica (descarga a PDF) ya no existe y se quitó: ${notLaunch.join(', ')}`
      );
      process.exitCode = 2;
      return;
    }

    let password: string;
    if (args.password) {
      password = args.password;
    } else {
      password =
        process.env.PASSWORD ??
        (
          await inquirer.prompt({
            name: 'password',
            type: 'password',
          })
        ).password;
      console.log('');
    }

    let onlySpec: OnlySpec | undefined;
    if (args.only) {
      try {
        onlySpec = parseOnly(args.only);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 2;
        return;
      }
    }

    setWaitPolicy({
      fast: args.fast,
      minWaitMs: args.minWait,
    });
    const blockPatterns = [
      ...(args.noBlockTrackers ? [] : TRACKER_PATTERNS),
      ...(args.noVideos ? MEDIA_PATTERNS : []),
      ...(args.fast ? AGGRESSIVE_PATTERNS : []),
    ];
    // pestañas en paralelo: por defecto min(2, las que caben en la RAM libre); entre 1 y 6
    if (args.concurrency !== undefined && Math.floor(args.concurrency) > 6) {
      console.warn(`--concurrency ${Math.floor(args.concurrency)} es demasiado alto para el modo HTML; se limita a 6 pestañas (Netacad puede limitar o bloquear muchas pestañas a la vez).`);
    }
    const plan = planTabs(args.concurrency);
    const tabs = plan.tabs;
    if (plan.warn) console.warn(plan.warn);
    else if (plan.auto) {
      console.log(`Pestañas en paralelo: ${tabs} (automático; RAM libre ~${(plan.freeMb / 1024).toFixed(1)} GB de ${(plan.totalMb / 1024).toFixed(1)} GB). Cambia con --concurrency.`);
    }

    const browser = await puppeteer.launch({
      headless: !args.debugHeadful,
      protocolTimeout: 600_000,
      args: [
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        ...chromeLaunchArgs({ headful: args.debugHeadful }),
      ],
    });

    try {
      for (const url of args.urls) {
        let urls: string[];
        let courseTitle: string;
        const sessionPage = await browser.newPage();
        sessionPage.setDefaultTimeout(120_000);
        sessionPage.setDefaultNavigationTimeout(90_000);

        try {
          await sessionPage.goto('https://www.netacad.com', {
            waitUntil: 'networkidle2',
          });
          console.log('Going to Netacad.com');
          await waitForSpinners(sessionPage);
          const LoginButton = await sessionPage.$('#netacad-login-button');

          if (LoginButton) {
            console.log('Login Button Found');
            console.log('Requesting Login Page');
            await LoginButton.click();
            // en cuanto aparece el formulario seguimos (máx. 3 s, igual que antes)
            await waitUntil(async () => !!(await sessionPage.$('input[name="username"]')), 3000, 150);
          } else {
            throw 'No Login Button Found';
          }

          await login(sessionPage, user, password);
          const profileEl = await sessionPage.$('.headerProfileName--cqryb');
          const studentName = profileEl
            ? await profileEl.evaluate((el) => el.textContent?.trim() ?? '')
            : null;
          console.log('Student Name: ' + studentName);
          console.log('Going to Course Page');
          console.log(url);
          await sessionPage.goto(url, { waitUntil: 'networkidle2' });
          console.log('Course Page Loaded');
          await waitUntil(
            async () =>
              !!(await sessionPage.$(
                '#course-outline, [class*="nodeList"], [class*="courseTitle"], iframe'
              )),
            5000,
            150
          );
          await dismissCookieBanner(sessionPage);

          if (/\/launch\b/.test(url) && !/\/launch\b/.test(sessionPage.url())) {
            console.log('La página salió del curso, volviendo a abrirlo…');
            await sessionPage.goto(url, { waitUntil: 'networkidle2' });
            await waitUntil(
              async () => !!(await sessionPage.$('#course-outline, [class*="nodeList"], iframe')),
              4000,
              150
            );
          }

          courseTitle = await getCourseTitle(sessionPage);
          console.log('Course Title: ' + courseTitle);
          const isLaunchUrl = /\/launch\b/.test(url);
          const courseIdEarly = courseIdOf(url);
          const siteDir = courseIdEarly ? courseSiteDir(args.outDir, courseIdEarly, courseTitle) : undefined;
          if (args.debugScreenshot && siteDir) {
            await mkdir(join(siteDir, DEBUG_DIR), { recursive: true });
            await sessionPage.screenshot({ path: join(siteDir, DEBUG_DIR, 'course.png') });
          }

          let fromCache = false;
          urls = [];
          if (onlySpec && isLaunchUrl && courseIdEarly && siteDir && !args.refreshOutline) {
            const cache = await readOutlineCache(siteDir, courseIdEarly);
            const hit = chaptersFromCache(cache, onlySpec);
            if (cache && hit) {
              const base = sessionPage.url();
              urls = hit.map((e) => buildLaunchUrl(base, e.viewId, e.chapter));
              fromCache = true;
              console.log(
                `--only ${onlySpec.text}: ${urls.length} capítulo(s) tomados de ${OUTLINE_CACHE_FILE} (${cache.savedAt.slice(0, 10)}); no se escanea el outline. Usa --refresh-outline para volver a leerlo.`
              );
            }
          }
          if (!fromCache) {
            const tScan = Date.now();
            urls = await getChapterUrls(sessionPage, { only: args.only });
            if (!args.only) console.log(`Outline completo leído en ${((Date.now() - tScan) / 1000).toFixed(0)} s.`);
            if (isLaunchUrl && courseIdEarly && siteDir && urls.length > 0) {
              try {
                const prev = await readOutlineCache(siteDir, courseIdEarly);
                const found = entriesFromUrls(urls);
                const present = new Set(found.map((e) => Number(e.chapter.split('.')[0])));
                const cacheNow = mergeOutlineCache(prev, courseIdEarly, found, {
                  fullScan: !onlySpec,
                  wholeModules: onlySpec ? wholeModulesOfOnly(onlySpec).filter((m) => present.has(m)) : [],
                });
                await writeOutlineCache(siteDir, cacheNow);
              } catch (e) {
                console.warn(`No se pudo guardar ${OUTLINE_CACHE_FILE}: ${e instanceof Error ? e.message : e}`);
              }
            }
          }
          if (args.only) {
            console.log(`--only ${args.only} → ${urls.length} capítulo(s): ${urls.map((u) => chapterIdFromUrl(u)).join(', ') || '(ninguno)'}`);
          }

          if (urls.length === 0) {
            console.error(
              args.only
                ? `No se encontró ningún capítulo para --only "${args.only}" en el outline.`
                : 'No hay URLs de capítulo para descargar.'
            );
            await sessionPage.close();
            process.exitCode = 1;
            continue;
          }
        } catch (e) {
          console.error(`Error en el curso ${url}:`, e);
          await sessionPage.close().catch(() => undefined);
          process.exitCode = 1;
          continue; // antes: return (abortaba también los demás cursos)
        }

        const launchCourse =
          urls.length > 0 && urls.every(isLaunchChapterUrl);

        const courseId = courseIdOf(url);
        if (!courseId) throw `No course id found in url: ${url}`;

        if (launchCourse) {
          await restoreLaunchCurriculumPage(sessionPage, url);
          await blockUnneededResources(sessionPage, blockPatterns);
          const newWorkerPage = async () => {
            const p = await browser.newPage();
            p.setDefaultTimeout(120_000);
            p.setDefaultNavigationTimeout(90_000);
            await blockUnneededResources(p, blockPatterns);
            return p;
          };

          // Ctrl+C: termina los capítulos en curso (escritura atómica), guarda índice y resumen.
          const abort = new AbortController();
          let sigints = 0;
          const onSigint = () => {
            sigints++;
            if (sigints === 1) {
              console.log(
                '\nCtrl+C: se terminan los capítulos en curso y se guardan índice y resumen… (Ctrl+C otra vez para salir ya)'
              );
              abort.abort();
            } else {
              process.exit(130);
            }
          };
          process.on('SIGINT', onSigint);
          let saved;
          try {
            saved = await saveLaunchCourseSite(sessionPage, urls, courseId, courseTitle, args.outDir, {
              courseUrl: url,
              resume: !args.force,
              retryFailed: args.retryFailed,
              partial: !!args.only,
              retries: Math.max(0, Math.floor(args.retries)),
              concurrency: tabs,
              recycleEvery: Math.max(0, Math.floor(args.recycleEvery)),
              videos: !args.noVideos,
              animations: !args.noAnimations,
              debugNetwork: args.debugNetwork,
              newPage: newWorkerPage,
              chapterTimeoutMs: Math.max(10, args.chapterTimeout) * 1000,
              signal: abort.signal,
              progressBar: true,
              prepareScrolls: true,
              prepareChapter: async (p, chapterUrl) => {
                await gotoChapter(p, chapterUrl);
                await dismissCookieBanner(p);
                await waitForChapterContent(p, chapterUrl); // incluye loaders/spinners, red, DOM estable y --min-wait
              },
              assetOpts: {
                ...DEFAULT_ASSET_OPTIONS,
                concurrency: Math.max(1, Math.floor(args.assetConcurrency)),
                retries: Math.max(0, Math.floor(args.retries)),
              },
            });
          } finally {
            process.off('SIGINT', onSigint);
          }
          await sessionPage.close().catch(() => undefined);
          if (saved.aborted) {
            process.exitCode = 130;
            break; // no se empiezan más cursos
          }
          continue;
        }

        console.error(`No es un curso "launch" (HTML offline): ${url}. La interfaz clásica de Netacad (descarga a PDF) ya no existe y se quitó.`);
        await sessionPage.close().catch(() => undefined);
        process.exitCode = 1;
      }
    } finally {
      await browser?.close();
    }
  },
});

function courseIdOf(url: string): string | undefined {
  try {
    const id = new URL(url).searchParams.get('id');
    if (id) return id;
  } catch {
    // no es una URL
  }
  return url.match(/[0-9]+/)?.at(0);
}

/** Ejecuta scripts/validate-download.js (sin login, sin red) sobre outDir. */
function runValidator(outDir: string): number {
  const script = join(__dirname, '..', 'scripts', 'validate-download.js');
  if (!existsSync(script)) {
    console.error(`No se encontró el validador: ${script}`);
    return 2;
  }
  const root = resolvePath(outDir);
  console.log(`Validando descargas en ${root} (sin conexión)…`);
  const r = spawnSync(process.execPath, [script, '--root', root], { stdio: 'inherit' });
  return r.status ?? 2;
}

async function dismissCookieBanner(page: Page): Promise<void> {
  // Solo botones de aceptar cookies específicos. NO usar selectores genéricos
  // como [aria-label="Close"] porque coinciden con el botón de cerrar el curso.
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#accept-recommended-btn-handler',
    '.onetrust-close-btn-handler',
  ];
  for (const selector of selectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click();
        // espera a que el banner desaparezca (máx. 800 ms, como antes), en vez de dormir fijo
        await waitUntil(
          async () => !(await page.$eval(selector, (el) => (el as HTMLElement).getClientRects().length > 0).catch(() => false)),
          800,
          100
        );
        await delay(150);
        return;
      }
    } catch {
      // ignore
    }
  }
}

async function getCourseTitle(page: Page): Promise<string> {
  const selectors = [
    'h1[class*="courseTitle"]',
    '[class*="courseNameContainer"] h1',
    '[class*="launchTopBar"] h1',
    'main#main-content h1',
    '.page-title',
  ];

  // El topbar puede tardar en renderizar; reintentamos unos segundos.
  for (let attempt = 0; attempt < 15; attempt++) {
    for (const selector of selectors) {
      const title = await page
        .$eval(selector, (el) => el.textContent?.trim() ?? '')
        .catch(() => '');
      if (title && title.length > 1) return title;
    }
    await delay(1000);
  }

  return 'Unknown';
}

const argv = process.argv.slice(2);
const removed = removedFlagErrors(argv);
if (removed.length) {
  for (const m of removed) console.error(m);
  process.exitCode = 2;
} else {
  run(cmd, argv);
}
