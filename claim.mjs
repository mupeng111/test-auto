// AxentHost hourly credit claim — runs on GitHub Actions every 12 min (5x/hour).
// Required secrets: DISCORD_EMAIL, DISCORD_PASSWORD
// Optional: AXENTHOST_EMAIL (if account uses email login instead of Discord)

import { chromium } from 'playwright';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_EMAIL = process.env.DISCORD_EMAIL;
const DISCORD_PASSWORD = process.env.DISCORD_PASSWORD;
const CLAIM_URL = 'https://app.axenthost.com/credits';
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryTurnstile(page) {
  // Turnstile often auto-passes; if an interactive checkbox appears, click it.
  for (let i = 0; i < 3; i++) {
    const frames = page.frames().filter((f) => f.url().includes('challenges.cloudflare.com'));
    if (frames.length === 0) return true;
    console.log(`[turnstile] challenge frame found, attempt ${i + 1}`);
    try {
      const box = frames[0].locator('input[type="checkbox"], .cb-lb, [role="checkbox"]').first();
      if (await box.count()) {
        await box.click({ timeout: 5000 }).catch(() => {});
        console.log('[turnstile] clicked checkbox');
      }
    } catch {}
    await sleep(8000);
    // check if challenge cleared
    const gone = page.frames().filter((f) => f.url().includes('challenges.cloudflare.com')).length === 0;
    if (gone) return true;
  }
  return page.frames().filter((f) => f.url().includes('challenges.cloudflare.com')).length === 0;
}

async function discordLogin(page) {
  console.log('[login] starting Discord OAuth');
  await page.goto('https://app.axenthost.com/', { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  // click Discord login button
  const discordBtn = page.locator('a[href*="discord"], button:has-text("Discord")').first();
  if (await discordBtn.count()) {
    await discordBtn.click();
    await page.waitForURL(/discord\.com/, { timeout: 20000 }).catch(() => {});
  }
  await sleep(3000);
  const url = page.url();
  if (!url.includes('discord.com')) {
    console.log('[login] already logged in or no OAuth redirect');
    return true;
  }
  // Discord authorize page (already logged into Discord) vs login form
  const authorizeBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
  if (await authorizeBtn.count()) {
    await authorizeBtn.click();
    await sleep(5000);
    console.log('[login] clicked Authorize');
    return true;
  }
  // Token auth: inject Discord token into localStorage (preferred, bypasses password/captcha/2FA)
  if (DISCORD_TOKEN) {
    console.log('[login] using Discord token auth');
    await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate((token) => {
      localStorage.setItem('token', `"${token}"`);
    }, DISCORD_TOKEN);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(6000);
    // now retry the AxentHost OAuth
    await page.goto('https://app.axenthost.com/', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const db = page.locator('a[href*="discord"], button:has-text("Discord")').first();
    if (await db.count()) {
      await db.click();
      await page.waitForURL(/discord\.com/, { timeout: 20000 }).catch(() => {});
      await sleep(3000);
    }
    const auth2 = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
    if (await auth2.count()) {
      await auth2.click();
      await sleep(5000);
      console.log('[login] token auth + Authorize done');
      return true;
    }
    console.log('[login] token auth did not reach Authorize page');
    return false;
  }
  // Full login form
  if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
    console.log('[login] need credentials but DISCORD_EMAIL/DISCORD_PASSWORD not set');
    return false;
  }
  await page.fill('input[name="email"]', DISCORD_EMAIL);
  await page.fill('input[name="password"]', DISCORD_PASSWORD);
  await page.click('button[type="submit"]');
  await sleep(8000);
  // possible captcha or 2FA — cannot solve automatically
  if (page.url().includes('discord.com')) {
    const auth2 = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
    if (await auth2.count()) {
      await auth2.click();
      await sleep(5000);
    } else {
      console.log('[login] stuck on Discord page (captcha/2FA?) — manual login needed');
      return false;
    }
  }
  console.log('[login] done');
  return true;
}

async function claimOnce(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    if (page.url().includes('discord.com') || (await page.locator('input[name="email"]').count())) {
      const ok = await discordLogin(page);
      if (!ok) return { ok: false, reason: 'discord-login-failed' };
      await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);
    }

    // find the hourly claim card button
    const claimBtn = page.locator('button:has-text("Claim"), a:has-text("Claim")').first();
    if (!(await claimBtn.count())) {
      return { ok: false, reason: 'claim-button-not-found' };
    }
    await claimBtn.click();
    await sleep(5000);

    // /claim page: handle Turnstile then click "Claim 3 credits"
    const tsOk = await tryTurnstile(page);
    if (!tsOk) console.log('[claim] turnstile may still be present, trying anyway');

    const claim3 = page.locator('button:has-text("Claim 3 credits"), button:has-text("Claim")').first();
    if (await claim3.count()) {
      await claim3.click();
      await sleep(6000);
    }

    const body = (await page.textContent('body').catch(() => '')) || '';
    if (/success|claimed|\+3/i.test(body)) {
      const bal = body.match(/(\d+)\s*credits?/i);
      return { ok: true, balance: bal ? bal[1] : 'unknown' };
    }
    if (/already|cooldown|wait|hour/i.test(body)) {
      return { ok: false, reason: 'cooldown-or-already-claimed' };
    }
    return { ok: false, reason: 'unknown-result' };
  } catch (e) {
    return { ok: false, reason: 'exception: ' + e.message.slice(0, 120) };
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  let result = { ok: false, reason: 'not-run' };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    console.log(`[run] attempt ${i + 1}/${MAX_ATTEMPTS}`);
    result = await claimOnce(browser);
    console.log('[run] result:', JSON.stringify(result));
    if (result.ok) break;
    if (result.reason === 'cooldown-or-already-claimed') break;
    await sleep(15000);
  }
  await browser.close();
  console.log('FINAL:', JSON.stringify(result));
  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') process.exitCode = 1;
})();
