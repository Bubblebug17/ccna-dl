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
import puppeteer, { Page, PaperFormat } from 'puppeteer';
// @ts-ignore
import { _paperFormats as paperFormats } from 'puppeteer-core';
import { delay, promisePool } from './util/promise';
import { fmtDuration, waitUntil } from './util/retry';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as muhammara from 'muhammara';
import * as cliProgress from 'cli-progress';
import * as inquirer from 'inquirer';
import { hasOwnProperty } from './util/object';
import { expandCarousels } from './expand-carousels';
import { waitForSpinners } from './wait-for-spinners';
import {
  gotoChapter,
  isLaunchChapterUrl,
  restoreLaunchCurriculumPage,
  waitForChapterContent,
} from './wait-for-chapter-content';
import { saveLaunchCourseSite } from './save-course';
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
import sanitize = require('sanitize-filename');
import { login } from './login';
import { getChapterUrls } from './get-chapters';
import { urlToChapter as urlToChapterId } from './url-to-chapter-id';
import { solveQuizzes } from './solve-quizzes';

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
        `por defecto ${DEFAULT_TABS} (o menos si hay poca RAM libre). Cada pestaña puede usar ~1 GB; se avisa si no caben en la RAM libre. ` +
        'Modo PDF antiguo: por defecto 10.',
    }),
    outDir: option({
      long: 'out-dir',
      short: 'o',
      type: string,
      defaultValue: () => '.',
      description: 'The directory, the item should be saved into.',
    }),
    format: option({
      long: 'format',
      type: optional(string),
      description: 'A puppeteer page format like "a4".',
    }),
    timeout: option({
      long: 'timeout',
      short: 't',
      type: optional(number),
      description: 'Terminates the download, when exceeded.',
    }),
    only: option({
      long: 'only',
      type: optional(string),
      description:
        'Only download the chapter with this number (e.g. "1.0"). For debugging.',
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
    noBlockMedia: flag({
      long: 'no-block-media',
      description:
        'No bloquear vídeo/audio (mp4, webm, mp3…) en el navegador. Por defecto se bloquean para ahorrar memoria: los archivos se descargan aparte con Node.',
    }),
    noBlockTrackers: flag({
      long: 'no-block-trackers',
      description:
        'No bloquear analítica/publicidad/seguimiento (Google Analytics, DoubleClick, Hotjar…) en el navegador.',
    }),
    screenshot: flag({
      long: 'screenshot',
      description: 'Guarda course.png (captura de depuración de la vista del curso).',
    }),
    headful: flag({
      long: 'headful',
      description:
        'Run the browser with a visible window (more reliable for the new NetAcad UI).',
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

    if (args.format && !hasOwnProperty(paperFormats, args.format)) {
      console.error(
        `Invalid page format specified. Possible options are: ${JSON.stringify(
          Object.keys(paperFormats)
        )}`
      );
      return;
    }

    if (args.urls.length < 1) {
      console.error('Please specify at least one url leading to a course.');
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

    const waitPolicy = setWaitPolicy({
      fast: args.fast,
      minWaitMs: args.minWait,
    });
    const blockPatterns = [
      ...(args.noBlockTrackers ? [] : TRACKER_PATTERNS),
      ...(args.noBlockMedia ? [] : MEDIA_PATTERNS),
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
    void waitPolicy;

    const browser = await puppeteer.launch({
      headless: args.headful ? false : true,
      protocolTimeout: 600_000,
      args: [
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        ...chromeLaunchArgs({ headful: args.headful }),
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
          if (args.screenshot) await sessionPage.screenshot({ path: 'course.png' });
          urls = await getChapterUrls(sessionPage, { only: args.only });
          if (args.only) {
            console.log(
              `Capítulo solicitado: ${args.only} → ${urls.length} URL(s)`
            );
          }

          if (urls.length === 0) {
            console.error(
              args.only
                ? `No se encontró el capítulo "${args.only}" en el outline.`
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

        const courseId =
          (() => {
            try {
              return new URL(url).searchParams.get('id') ?? undefined;
            } catch {
              return undefined;
            }
          })() ?? url.match(/[0-9]+/)?.at(0);
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
              retries: Math.max(0, Math.floor(args.retries)),
              concurrency: tabs,
              recycleEvery: Math.max(0, Math.floor(args.recycleEvery)),
              newPage: newWorkerPage,
              chapterTimeoutMs: Math.max(10, args.chapterTimeout) * 1000,
              signal: abort.signal,
              progressBar: true,
              prepareScrolls: true,
              prepareChapter: async (p, chapterUrl) => {
                await gotoChapter(p, chapterUrl);
                await dismissCookieBanner(p);
                await waitForChapterContent(p, chapterUrl);
                await waitForSpinners(p).catch(() => undefined);
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

        // Legacy UI: descarga a PDF y los une en un único archivo.
        console.log('Downloading chapters.');
        const saveDir = join(args.outDir, courseId);
        await rm(saveDir, { recursive: true, force: true });
        await mkdir(saveDir, { recursive: true });

        let outFiles = new Array(urls.length);

        const bar = new cliProgress.SingleBar(
          {},
          cliProgress.Presets.shades_classic
        );
        bar.start(urls.length, 0);
        const barUpdater = setInterval(() => bar.updateETA(), 1000);

        await sessionPage.close().catch(() => undefined);
        try {
          await promisePool(
            async (i) => {
              const chapterUrl = urls[i];
              const chapterPage = await browser.newPage();
              try {
                await chapterPage.goto(chapterUrl, { waitUntil: 'networkidle2' });
                await waitForChapterContent(chapterPage, chapterUrl);
                await waitForSpinners(chapterPage).catch(() => undefined);
                await expandCarousels(chapterPage);
                await solveQuizzes(chapterPage);

                const chapter = urlToChapterId(chapterUrl).replace(/\.1$/, '');
                const outFile = join(saveDir, `${chapter}.pdf`);
                const buf = (await chapterPage.pdf({
                  format: (args.format as PaperFormat | undefined) ?? 'a4',
                  landscape: false,
                  margin: { top: 0, right: 0, bottom: 0, left: 0 },
                  scale: 0.6,
                  printBackground: true,
                  displayHeaderFooter: false,
                  timeout: args.timeout,
                })) as Buffer;
                await writeFile(outFile, new Uint8Array(buf));
                outFiles[i] = outFile;
                bar.increment();
              } finally {
                await chapterPage.close();
              }
            },
            args.concurrency ?? 10,
            urls.length
          );
        } finally {
          clearInterval(barUpdater);
          bar.stop();
        }

        console.log('Merging pdfs.');
        const mergedPdf = join(
          args.outDir,
          `${courseId}_${sanitize(courseTitle)}.pdf`
        );
        const writeStream = new muhammara.PDFWStreamForFile(mergedPdf);
        const writer = muhammara.createWriter(writeStream);
        for (const outFile of outFiles) {
          writer.appendPDFPagesFromPDF(outFile);
        }
        writer.end();
        await new Promise<void>((resolve) => writeStream.close(resolve));
        await rm(saveDir, { recursive: true });
        console.log(`Success. File: ${mergedPdf}`);
      }
    } finally {
      await browser?.close();
    }
  },
});

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

run(cmd, process.argv.slice(2));
