import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const AXENT_LOCAL_STORAGE = process.env.AXENT_LOCAL_STORAGE || '';
const CLAIM_URL = 'https://app.axenthost.com/claim';
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

// 关闭 Fiverr 等模态广告弹窗，而不阻断网络请求（绕过反广告插件检测）
async function dismissAdModals(page) {
  try {
    // 1. 模拟按 ESC 键
    await page.keyboard.press('Escape');

    // 2. 寻找右上角的 Close 文本或按钮进行点击
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 2000 }).catch(() => {});
      console.log('[ad-modal] clicked close button');
    }

    // 3. 辅助移除遮罩 DOM（避开 Cloudflare）
    await page.evaluate(() => {
      document.querySelectorAll('div').forEach((el) => {
        if (el.innerText && el.innerText.includes('Fiverr freelancers do')) {
          el.remove();
        }
      });
    }).catch(() => {});
  } catch {}
}

async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification...');

  // 1. 等待 "Verifying you're human in 0:0X" 倒计时结束
  for (let i = 0; i < 15; i++) {
    await dismissAdModals(page);
    const isCountingDown = await page.evaluate(() => {
      return document.body.innerText.includes("Verifying you're human in");
    }).catch(() => false);

    if (!isCountingDown) break;
    console.log('[turnstile] waiting for human verification countdown...');
    await sleep(2000);
  }

  // 2. 轮询并点击 Cloudflare Turnstile 验证框
  for (let i = 0; i < 15; i++) {
    await dismissAdModals(page);

    const frames = page.frames().filter((f) => f.url().includes('challenges.cloudflare.com'));
    if (frames.length > 0) {
      try {
        const checkboxLabel = frames[0].locator('.ctp-checkbox-label, label, input[type="checkbox"], #main-wrapper').first();
        if (await checkboxLabel.isVisible().catch(() => false)) {
          await checkboxLabel.click({ force: true, timeout: 2000 }).catch(() => {});
          console.log('[turnstile] clicked challenge checkbox');
        }
      } catch {}
    }

    // 检查是否显示通过
    const verifiedText = page.locator('text=Verified, you are human, text="成功！"');
    const hasVerified = (await verifiedText.count()) > 0;

    // 检查 "Claim 3 credits" 按钮是否已由灰色变为黄色激活状态
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

  try {
    // 直接进入 /claim 页面
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);
    await dismissAdModals(page);

    // 检查登录状态
    const currentUrl = page.url();
    const isLoginPage = currentUrl.includes('login') || (await page.locator('button:has-text("Login")').count()) > 0;
    if (isLoginPage) {
      await takeScreenshot(page, `attempt${attemptIndex}-login-failed`);
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 若直接访问 /claim 被重定向回 /credits，则从卡片处点击跳转
    if (page.url().includes('/credits')) {
      const hourlyClaimBtn = page.locator('button:has-text("Claim"), a:has-text("Claim")').first();
      if (!(await hourlyClaimBtn.count())) {
        await takeScreenshot(page, `attempt${attemptIndex}-credits-page-no-claim-btn`);
        const bodyText = (await page.textContent('body').catch(() => '')) || '';
        if (/refill in\s*\d+:\d+/i.test(bodyText) || /cooldown/i.test(bodyText)) {
          return { ok: false, reason: 'cooldown-or-already-claimed' };
        }
        return { ok: false, reason: 'hourly-claim-card-button-not-found' };
      }
      await hourlyClaimBtn.click();
      await page.waitForURL(/.*\/claim/, { timeout: 15000 }).catch(() => {});
      await sleep(3000);
    }

    // 检查是否在冷却时间中（如 Claims refill in 45:14）
    const pageText = (await page.textContent('body').catch(() => '')) || '';
    if (/Claims refill in\s*\d+:\d+/i.test(pageText)) {
      await takeScreenshot(page, `attempt${attemptIndex}-in-cooldown`);
      return { ok: false, reason: 'cooldown-or-already-claimed' };
    }

    // 处理 Turnstile 与倒计时
    await waitAndSolveTurnstile(page, attemptIndex);

    // 等待并点击 "Claim 3 credits" 按钮
    const claim3Btn = page.locator('button:has-text("Claim 3 credits"), [role="button"]:has-text("Claim 3 credits")').first();

    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      return btn && !btn.disabled && !btn.classList.contains('disabled');
    }, { timeout: 20000 }).catch(() => {});

    if (await claim3Btn.count()) {
      await claim3Btn.click({ force: true, timeout: 5000 });
      console.log('[claim] clicked Claim 3 credits button');
      await sleep(5000);
      await takeScreenshot(page, `attempt${attemptIndex}-after-click-claim3`);
    } else {
      await takeScreenshot(page, `attempt${attemptIndex}-claim3-btn-not-found`);
      return { ok: false, reason: 'claim-3-credits-button-not-found' };
    }

    // 校验领取结果
    const resultText = (await page.textContent('body').catch(() => '')) || '';
    if (/success|claimed|\+3/i.test(resultText)) {
      const match = resultText.match(/(\d+)\s*credits?/i);
      return { ok: true, balance: match ? match[1] : 'unknown' };
    }
    if (/already|cooldown|wait|hour/i.test(resultText)) {
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
