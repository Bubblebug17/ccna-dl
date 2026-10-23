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
import { readFileSync } from 'fs';
import { join } from 'path';
import puppeteer, { Page, PaperFormat } from 'puppeteer';
// @ts-ignore
import { _paperFormats as paperFormats } from 'puppeteer-core';
import { delay, promisePool } from './util/promise';
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
import {
  buildIndexHtml,
  chapterFileName,
  entriesFromSavedChapters,
  IndexEntry,
  mergeIndexEntries,
  saveChapterHtml,
} from './save-chapter-html';
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
      type: string,
      description: 'Your login email/username.',
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
      type: number,
      defaultValue: () => 10,
      description: 'Specifies the maximum amount of pages downloaded at once.',
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
    headful: flag({
      long: 'headful',
      description:
        'Run the browser with a visible window (more reliable for the new NetAcad UI).',
    }),
  },
  handler: async (args) => {
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

    const browser = await puppeteer.launch({
      headless: args.headful ? false : true,
      protocolTimeout: 600_000,
      args: [
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1400,900',
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
            await delay(3000);
          } else {
            throw 'No Login Button Found';
          }

          await login(sessionPage, args.user, password);
          const profileEl = await sessionPage.$('.headerProfileName--cqryb');
          const studentName = profileEl
            ? await profileEl.evaluate((el) => el.textContent?.trim() ?? '')
            : null;
          console.log('Student Name: ' + studentName);
          console.log('Going to Course Page');
          console.log(url);
          await sessionPage.goto(url, { waitUntil: 'networkidle2' });
          console.log('Course Page Loaded');
          await delay(5000);
          await dismissCookieBanner(sessionPage);

          if (/\/launch\b/.test(url) && !/\/launch\b/.test(sessionPage.url())) {
            console.log('La página salió del curso, volviendo a abrirlo…');
            await sessionPage.goto(url, { waitUntil: 'networkidle2' });
            await delay(4000);
          }

          courseTitle = await getCourseTitle(sessionPage);
          console.log('Course Title: ' + courseTitle);
          await sessionPage.screenshot({ path: 'course.png' });
          urls = await getChapterUrls(sessionPage, { only: args.only });
          if (args.only) {
            console.log(
              `Capítulo solicitado: ${args.only} → ${urls.length} URL(s)`
            );
          }
          console.log('Chapter URLs: ' + urls);
          if (urls.length === 0) {
            console.error(
              args.only
                ? `No se encontró el capítulo "${args.only}" en el outline.`
                : 'No hay URLs de capítulo para descargar.'
            );
            await sessionPage.close();
            return;
          }
        } catch (e) {
          console.error('Error:', e);
          await sessionPage.close();
          return;
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
          await saveLaunchCourseSite(
            sessionPage,
            urls,
            courseId,
            courseTitle,
            args.outDir
          );
          await sessionPage.close().catch(() => undefined);
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
            args.concurrency,
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

async function saveLaunchCourseSite(
  page: Page,
  urls: string[],
  courseId: string,
  courseTitle: string,
  outDir: string
): Promise<void> {
  console.log('Guardando capítulos como HTML.');

  const folderName = sanitize(`${courseId}_${courseTitle}`) || courseId;
  const siteDir = join(outDir, folderName);
  const chaptersDir = join(siteDir, 'chapters');
  await mkdir(chaptersDir, { recursive: true });

  await page.setViewport({ width: 1400, height: 1200 });

  const entries: IndexEntry[] = [];
  const downloaded = new Map<string, boolean>();
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(urls.length, 0);

  try {
    for (const chapterUrl of urls) {
      const chapter = urlToChapterId(chapterUrl).replace(/\.1$/, '');
      try {
        await gotoChapter(page, chapterUrl);
        await dismissCookieBanner(page);
        await waitForChapterContent(page, chapterUrl);
        await waitForSpinners(page).catch(() => undefined);

        const fileName = chapterFileName(chapter);
        let res = await saveChapterHtml(
          page,
          join(chaptersDir, fileName),
          siteDir,
          downloaded,
          chapter
        );
        if (!res.ok) {
          console.warn(`\n  · reintentando capítulo ${chapter}…`);
          await gotoChapter(page, chapterUrl);
          await waitForChapterContent(page, chapterUrl);
          await waitForSpinners(page).catch(() => undefined);
          res = await saveChapterHtml(
            page,
            join(chaptersDir, fileName),
            siteDir,
            downloaded,
            chapter
          );
        }
        if (res.ok) {
          entries.push({
            chapter,
            title: res.title || chapter,
            file: `chapters/${fileName}`,
            subtopics: res.subtopics,
          });
          if (res.failed > 0) {
            console.warn(
              `\n  · ${chapter}: ${res.failed}/${res.assets} recursos no se pudieron descargar`
            );
          }
        } else {
          console.warn(`\n  · capítulo ${chapter}: sin contenido, omitido`);
        }
      } catch (e) {
        console.warn(`\n  · capítulo ${chapter}: error (${String(e)})`);
      }
      bar.increment();
    }
  } finally {
    bar.stop();
  }

  const indexPath = join(siteDir, 'index.html');
  let indexEntries = entries;
  if (indexEntries.length < urls.length) {
    const fromDisk = await entriesFromSavedChapters(chaptersDir);
    if (fromDisk.length) {
      indexEntries = mergeIndexEntries(fromDisk, entries);
      if (entries.length === 0) {
        console.warn(
          `No se guardó contenido nuevo; índice reconstruido desde ${fromDisk.length} capítulo(s) en disco.`
        );
      }
    }
  }

  if (indexEntries.length === 0) {
    console.error(
      'No hay capítulos guardados. No se actualiza index.html para no borrar el índice anterior.'
    );
    return;
  }

  await writeFile(indexPath, buildIndexHtml(courseTitle, indexEntries), 'utf8');

  console.log(
    `Success. ${entries.length}/${urls.length} capítulos guardados. Índice: ${indexEntries.length} entradas. Abre: ${indexPath}`
  );
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
        await delay(800);
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
