import { HTTPResponse, Page, Target } from 'puppeteer';
import { log } from './ui/log';
import { catchedRace, delay } from './util/promise';
import { waitUntil } from './util/retry';
import { waitForSpinners } from './wait-for-spinners';

export async function login(page: Page, user: string, password: string) {
  log.detail("Login Page Loaded");
  const userElm = await page.$('input[name="username"]');
  if (!userElm) throw 'Username input not found.';
  await userElm.type(user);

  const nextBtn = await page.$('input[name="login"]');
  if (!nextBtn) {
    throw 'No next button found.';
  }

  // navigation
  const waitForNav = () =>
    page.waitForNavigation({ waitUntil: 'networkidle2' });

  // cookie banner
  const waitForCookies = () =>
    page.waitForSelector(
      '.save-preference-btn-handler.onetrust-close-btn-handler',
      { visible: true, hidden: false }
    );

  // https://www.cisco.com/c/en/us/about/legal/privacy-full.html page
  const waitForPrivacyPage = () =>
    page
      .browser()
      .waitForTarget((target) =>
        target.url().includes('about/legal/privacy-full.html')
      );

  // handle multiple scenarios
  nextBtn.click().catch(() => undefined);
  let nextThing = await catchedRace([
    waitForNav(),
    waitForCookies(),
    waitForPrivacyPage(),
  ]);
  // privacy page
  if (nextThing instanceof Target) {
    const page = await nextThing.page();
    page && (await page.close());

    nextBtn.click().catch(() => undefined);
    nextThing = await catchedRace([waitForNav(), waitForCookies()]);
  }

  // cookie banner
  if (!(nextThing instanceof HTTPResponse)) {
    const savePrefsBtn = nextThing;
    if (savePrefsBtn) {
      await savePrefsBtn.click();
      await delay(1000);

      // se registra la espera ANTES del clic para no perder la navegación
      await Promise.all([waitForNav(), nextBtn.click()]);
    }
  }

  // en cuanto aparece el campo de contraseña seguimos (máx. 2 s, como antes)
  await waitUntil(async () => !!(await page.$('input[name="password"]')), 2000, 100);
  await waitForSpinners(page);

  const pwElm = await page.$('input[name="password"]');
  if (!pwElm) throw 'Password input not found.';
  await pwElm.type(password);

  const submitBtn = await page.$('input[name="login"]');
  if (!submitBtn) throw 'Login submit button not found.';
  log.detail("Credentials Submitted");
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    submitBtn.click(),
  ]);
  log.detail("Navigation Completed");
  // resultado conocido (dashboard o error) en cuanto aparece; máx. 5 s como antes
  await waitUntil(
    async () =>
      page.url().includes('dashboard') ||
      (await page.content()).includes('Invalid username or password.'),
    5000,
    200
  );
  if((await page.content()).includes('Invalid username or password.')){
    throw 'Invalid username or password.';
  }
  else if((await page.url()).includes('dashboard')){
    log.detail("Login Successful");
  }
  else{
    throw 'Login Failed';
  }
  //log.detail(await page.content());
}
