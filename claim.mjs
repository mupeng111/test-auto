import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const AXENT_LOCAL_STORAGE = process.env.AXENT_LOCAL_STORAGE || '';
const CREDITS_URL = 'https://app.axenthost.com/credits';
const MAX_ATTEMPTS = 3;

const SCREENSHOT_DIR = 'screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeScreenshot(page, name) {
  try {
    const filePath = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[screenshot] saved: ${filePath}`);
  } catch (err) {
    console.error(`[screenshot] failed to capture ${name}:`, err.message);
  }
}

// 尝试关闭可能存在的弹窗遮罩
async function dismissAnyModals(page) {
  try {
    await page.evaluate(() => {
      const closeButtons = document.querySelectorAll(
        'button:has-text("Close"), .close, [aria-label="Close"], [class*="modal"] button, [id*="close"]'
      );
      closeButtons.forEach((btn) => btn.click());
    });
  } catch {}
}

async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification...');

  // 1. 等待 "Verifying you're human in 0:0X" 倒计时结束
  for (let i = 0; i < 15; i++) {
    const isCountingDown = await page.evaluate(() => {
      return document.body.innerText.includes("Verifying you're human in");
    }).catch(() => false);

    if (!isCountingDown) break;
    console.log('[turnstile] waiting for countdown timer to finish...');
    await sleep(2000);
  }

  // 2. 轮询处理 Turnstile 验证框
  for (let i = 0; i < 12; i++) {
    await dismissAnyModals(page);

    const frames = page.frames().filter((f) => f.url().includes('challenges.cloudflare.com'));
    if (frames.length > 0) {
      try {
        // 匹配图 17 中的真实标签结构
        const labelBox = frames[0].locator('.ctp-checkbox-label, label, input[type="checkbox"], body').first();
        if (await labelBox.isVisible().catch(() => false)) {
          await labelBox.click({ force: true, timeout: 2000 }).catch(() => {});
          console.log('[turnstile] clicked verification label/box');
        }
      } catch {}
    }

    // 检查验证是否通过
    const verifiedText = page.locator('text=Verified, you are human, text="成功！"');
    const hasVerified = (await verifiedText.count()) > 0;

    // 检查 "Claim 3 credits" 按钮是否已解除 disabled 状态
    const isReady = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      return btn && !btn.disabled && !btn.classList.contains('disabled');
    }).catch(() => false);

    if (hasVerified || isReady) {
      console.log('[turnstile] verification passed');
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }

    await sleep(3000);
  }

  console.log('[turnstile] timeout waiting for pass, attempting to continue');
  await takeScreenshot(page, `attempt${attemptIndex}-turnstile-timeout`);
  return false;
}

async function claimOnce(context, attemptIndex) {
  const page = await context.newPage();

  // 关键优化：拦截第三方广告域名，防止全屏弹窗截断页面
  await page.route(
    /(doubleclick|googleadservices|googlesyndication|adnxs|rubiconproject|pubmatic|criteo|amazon-adsystem|outbrain|taboola|fiverr|adservice)/i,
    (route) => route.abort()
  );

  try {
    await page.goto(CREDITS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    const currentUrl = page.url();
    const isLoginPage = currentUrl.includes('login') || (await page.locator('button:has-text("Login")').count()) > 0;
    if (isLoginPage) {
      await takeScreenshot(page, `attempt${attemptIndex}-login-failed`);
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 点击 Hourly Free Credits 卡片上的 Claim 按钮
    const hourlyClaimBtn = page.locator('button:has-text("Claim"), a:has-text("Claim")').first();
    if (!(await hourlyClaimBtn.count())) {
      await takeScreenshot(page, `attempt${attemptIndex}-credits-page-no-claim-btn`);
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      if (/refill in|cooldown/i.test(bodyText)) {
        return { ok: false, reason: 'cooldown-or-already-claimed' };
      }
      return { ok: false, reason: 'hourly-claim-card-button-not-found' };
    }

    await hourlyClaimBtn.click();
    await page.waitForURL(/.*\/claim/, { timeout: 15000 }).catch(() => {});
    await sleep(3000);

    // 等待倒计时及 Turnstile 验证完成
    await waitAndSolveTurnstile(page, attemptIndex);

    // 等待并点击 "Claim 3 credits" 按钮
    const claim3Btn = page.locator('button:has-text("Claim 3 credits"), [role="button"]:has-text("Claim 3 credits")').first();
    
    // 确保按钮变为可用状态（Enabled）
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      return btn && !btn.disabled && !btn.classList.contains('disabled');
    }, { timeout: 15000 }).catch(() => {});

    if (await claim3Btn.count()) {
      await claim3Btn.click({ force: true, timeout: 5000 });
      console.log('[claim] clicked Claim 3 credits button');
      await sleep(5000);
      await takeScreenshot(page, `attempt${attemptIndex}-after-click-claim3`);
    } else {
      await takeScreenshot(page, `attempt${attemptIndex}-claim3-btn-not-found`);
      return { ok: false, reason: 'claim-3-credits-button-not-found' };
    }

    const resultText = (await page.textContent('body').catch(() => '')) || '';
    if (/success|claimed|\+3/i.test(resultText)) {
      const match = resultText.match(/(\d+)\s*credits?/i);
      return { ok: true, balance: match ? match[1] : 'unknown' };
    }
    if (/already|cooldown|wait|hour|4\/5|5\/5/i.test(resultText)) {
      return { ok: false, reason: 'cooldown-or-already-claimed' };
    }

    await takeScreenshot(page, `attempt${attemptIndex}-unknown-result`);
    return { ok: false, reason: 'unknown-result' };
  } catch (err) {
    await takeScreenshot(page, `attempt${attemptIndex}-exception`);
    return { ok: false, reason: `exception: ${err.message.slice(0, 120)}` };
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  };

  if (PROXY_SERVER) {
    launchOpts.proxy = { server: PROXY_SERVER };
    console.log('[proxy] using', PROXY_SERVER);
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // 1. 注入 LocalStorage
  if (AXENT_LOCAL_STORAGE) {
    try {
      const storage = JSON.parse(AXENT_LOCAL_STORAGE);
      await context.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) {
          window.localStorage.setItem(k, v);
        }
      }, storage);
      console.log('[auth] localStorage injected successfully');
    } catch (e) {
      console.error('[auth] failed to parse AXENT_LOCAL_STORAGE:', e.message);
    }
  }

  // 2. 注入 Cookies
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
  }

  let result = { ok: false, reason: 'not-run' };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    console.log(`[run] attempt ${i + 1}/${MAX_ATTEMPTS}`);
    result = await claimOnce(context, i + 1);
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
