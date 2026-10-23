import { HTTPResponse, Page, Target } from 'puppeteer';
import { catchedRace, delay } from './util/promise';
import { waitForSpinners } from './wait-for-spinners';

export async function login(page: Page, user: string, password: string) {
  console.log("Login Page Loaded");
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
  nextBtn.click();
  let nextThing = await catchedRace([
    waitForNav(),
    waitForCookies(),
    waitForPrivacyPage(),
  ]);
  // privacy page
  if (nextThing instanceof Target) {
    const page = await nextThing.page();
    page && (await page.close());

    nextBtn.click();
    nextThing = await catchedRace([waitForNav(), waitForCookies()]);
  }

  // cookie banner
  if (!(nextThing instanceof HTTPResponse)) {
    const savePrefsBtn = nextThing;
    if (savePrefsBtn) {
      await savePrefsBtn.click();
      await delay(1000);

      nextBtn.click();
      await waitForNav();
    }
  }

  await delay(2000);
  await waitForSpinners(page);

  const pwElm = await page.$('input[name="password"]');
  if (!pwElm) throw 'Password input not found.';
  await pwElm.type(password);

  const submitBtn = await page.$('input[name="login"]');
  if (!submitBtn) throw 'Login submit button not found.';
  console.log("Credentials Submitted");
  submitBtn.click();

  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  console.log("Navigation Completed");
  await delay(5000);
  if((await page.content()).includes('Invalid username or password.')){
    throw 'Invalid username or password.';
  }
  else if((await page.url()).includes('dashboard')){
    console.log("Login Successful");
  }
  else{
    throw 'Login Failed';
  }
  //console.log(await page.content());
}
