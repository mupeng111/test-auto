import { chromium } from 'playwright';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const CREDITS_URL = 'https://app.axenthost.com/credits';
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitAndSolveTurnstile(page) {
  console.log('[turnstile] waiting for verification to complete...');

  for (let i = 0; i < 10; i++) {
    // 1. 尝试寻找并点击 Cloudflare 验证框
    const frames = page.frames().filter((f) => f.url().includes('challenges.cloudflare.com'));
    if (frames.length > 0) {
      try {
        const checkbox = frames[0].locator('input[type="checkbox"], .cb-lb, [role="checkbox"]').first();
        if (await checkbox.isVisible().catch(() => false)) {
          await checkbox.click({ timeout: 2000 }).catch(() => {});
          console.log('[turnstile] clicked challenge checkbox');
        }
      } catch {}
    }

    // 2. 检查验证成功的标识（出现 Verified, you are human 或 成功！）
    const verifiedText = page.locator('text=Verified, you are human, text="成功！"');
    const hasVerified = (await verifiedText.count()) > 0;

    // 3. 检查最终领取按钮是否已激活（非 disabled 状态）
    const claimBtn = page.locator('button:has-text("Claim 3 credits")').first();
    const isReady = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      return btn && !btn.disabled && !btn.classList.contains('disabled');
    }).catch(() => false);

    if (hasVerified || isReady) {
      console.log('[turnstile] verification passed');
      return true;
    }

    await sleep(3000);
  }

  console.log('[turnstile] timeout waiting for pass, attempting to continue');
  return false;
}

async function claimOnce(context) {
  const page = await context.newPage();
  try {
    // 访问 credits 页面
    await page.goto(CREDITS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    // 检查是否丢失登录态
    const currentUrl = page.url();
    const isLoginPage = currentUrl.includes('login') || (await page.locator('button:has-text("Login")').count()) > 0;
    if (isLoginPage) {
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 点击 Hourly Free Credits 卡片上的 Claim 按钮
    const hourlyClaimBtn = page.locator('button:has-text("Claim"), a:has-text("Claim")').first();
    if (!(await hourlyClaimBtn.count())) {
      // 检查当前是否在冷却中
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      if (/refill in|cooldown/i.test(bodyText)) {
        return { ok: false, reason: 'cooldown-or-already-claimed' };
      }
      return { ok: false, reason: 'hourly-claim-card-button-not-found' };
    }

    await hourlyClaimBtn.click();
    await page.waitForURL(/.*\/claim/, { timeout: 15000 }).catch(() => {});
    await sleep(3000);

    // 处理 Turnstile 验证
    await waitAndSolveTurnstile(page);

    // 点击 "Claim 3 credits" 按钮
    const claim3Btn = page.locator('button:has-text("Claim 3 credits")').first();
    if (await claim3Btn.count()) {
      await claim3Btn.click({ timeout: 5000 });
      console.log('[claim] clicked Claim 3 credits button');
      await sleep(5000);
    } else {
      return { ok: false, reason: 'claim-3-credits-button-not-found' };
    }

    // 验证结果
    const resultText = (await page.textContent('body').catch(() => '')) || '';
    if (/success|claimed|\+3/i.test(resultText)) {
      const match = resultText.match(/(\d+)\s*credits?/i);
      return { ok: true, balance: match ? match[1] : 'unknown' };
    }
    if (/already|cooldown|wait|hour|4\/5|5\/5/i.test(resultText)) {
      return { ok: false, reason: 'cooldown-or-already-claimed' };
    }

    return { ok: false, reason: 'unknown-result' };
  } catch (err) {
    return { ok: false, reason: `exception: ${err.message.slice(0, 120)}` };
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const launchArgs = ['--no-sandbox', '--disable-blink-features=AutomationControlled'];
  const launchOpts = {
    headless: true,
    args: launchArgs,
  };

  if (PROXY_SERVER) {
    launchOpts.proxy = { server: PROXY_SERVER };
    console.log('[proxy] using', PROXY_SERVER);
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // 注入 Cookies
  if (AXENT_COOKIES) {
    try {
      const parsed = JSON.parse(AXENT_COOKIES);
      const cookies = parsed.map((item) => ({
        name: item.name,
        value: item.value,
        domain: item.domain,
        path: item.path || '/',
        expires: item.expirationDate || item.expires || -1,
        httpOnly: item.httpOnly || false,
        secure: item.secure || false,
        sameSite: ['Strict', 'Lax', 'None'].includes(item.sameSite) ? item.sameSite : 'Lax',
      }));
      await context.addCookies(cookies);
      console.log('[auth] cookies injected successfully');
    } catch (e) {
      console.error('[auth] failed to parse AXENT_COOKIES:', e.message);
    }
  } else {
    console.warn('[auth] AXENT_COOKIES not provided!');
  }

  let result = { ok: false, reason: 'not-run' };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    console.log(`[run] attempt ${i + 1}/${MAX_ATTEMPTS}`);
    result = await claimOnce(context);
    console.log('[run] result:', JSON.stringify(result));

    if (result.ok || result.reason === 'cooldown-or-already-claimed') break;
    await sleep(10000);
  }

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
