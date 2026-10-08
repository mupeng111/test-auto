import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const AXENT_LOCAL_STORAGE = process.env.AXENT_LOCAL_STORAGE || '';
const CLAIM_URL = 'https://app.axenthost.com/claim';
const MAX_ATTEMPTS = 3;

// 截图输出目录
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

// 轻量处理弹窗，避免触发反广告拦截阻断
async function dismissAdModals(page) {
  try {
    await page.keyboard.press('Escape');
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 1500 }).catch(() => {});
    }
  } catch {}
}

async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification...');

  // 1. 等待倒计时 (如 Verifying you're human in 0:0X)
  for (let i = 0; i < 8; i++) {
    const isCountingDown = await page.evaluate(() => {
      return document.body.innerText.includes("Verifying you're human in");
    }).catch(() => false);

    if (!isCountingDown) break;
    console.log('[turnstile] waiting for countdown timer to finish...');
    await sleep(2000);
  }

  // 2. 轮询并精确命中 24x24 空白复选框正中心
  for (let i = 0; i < 15; i++) {
    await dismissAdModals(page);

    // 检查隐藏表单是否已生成 Token
    const hasToken = await page.evaluate(() => {
      const input = document.querySelector('input[name*="turnstile-response"]');
      return !!(input && input.value && input.value.length > 20);
    }).catch(() => false);

    // 检查前端提示
    const isVerifiedText = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('Verified, you are human') || text.includes('成功！');
    }).catch(() => false);

    // 检查按钮是否已就绪（排除 Securing 状态）
    const isBtnReady = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      const isSecuring = document.body.innerText.includes('Securing your claim');
      return btn && !btn.disabled && !isSecuring;
    }).catch(() => false);

    if (hasToken || isVerifiedText || isBtnReady) {
      console.log('[turnstile] verification passed successfully!');
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }

    // 严格定位 Cloudflare 验证 iframe，排除广告干扰
    const cfIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    const isVisible = await cfIframe.isVisible().catch(() => false);

    if (isVisible) {
      // 聚焦 iframe
      await cfIframe.focus().catch(() => {});
      await sleep(100);

      // 对准 24x24 复选框中心 (X=24 是理论中心，20 与 28 为微调容错)
      const targetOffsets = [24, 20, 28];
      const offsetX = targetOffsets[i % targetOffsets.length];

      try {
        await cfIframe.click({
          position: { x: offsetX, y: 32 },
          delay: 80,
          timeout: 3000,
          force: true,
        });
        console.log(`[turnstile] attempt ${i + 1}: clicked checkbox at offset (${offsetX}, 32)`);
      } catch (err) {
        console.warn(`[turnstile] frame click error: ${err.message}`);
      }
    } else {
      console.log(`[turnstile] attempt ${i + 1}: cf iframe not visible yet`);
    }

    await sleep(2500);
  }

  console.log('[turnstile] timeout waiting for pass');
  await takeScreenshot(page, `attempt${attemptIndex}-turnstile-timeout`);
  return false;
}

async function claimOnce(context, attemptIndex) {
  const page = await context.newPage();

  try {
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);
    await dismissAdModals(page);

    // 检查登录状态
    const isLoginPage = page.url().includes('login') || (await page.locator('button:has-text("Login")').count()) > 0;
    if (isLoginPage) {
      await takeScreenshot(page, `attempt${attemptIndex}-login-failed`);
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 检查右侧统计卡片是否处于冷却中（需包含明确的时间数字，如 45:14）
    const isCooling = await page.evaluate(() => {
      const refillMatch = document.body.innerText.match(/Claims refill in\s*(\d+:\d+)/i);
      return refillMatch ? refillMatch[1] : null;
    });

    if (isCooling) {
      console.log(`[claim] currently in cooldown: ${isCooling}`);
      await takeScreenshot(page, `attempt${attemptIndex}-in-cooldown`);
      return { ok: true, reason: 'cooldown-or-already-claimed', cooldown: isCooling };
    }

    // 处理 Turnstile 验证
    await waitAndSolveTurnstile(page, attemptIndex);

    // 等待按钮解锁
    const isEnabled = await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      const isSecuring = document.body.innerText.includes('Securing your claim');
      return btn && !btn.disabled && !isSecuring;
    }, { timeout: 12000 }).catch(() => false);

    if (!isEnabled) {
      console.log('[claim] button still disabled or securing, cannot submit');
      await takeScreenshot(page, `attempt${attemptIndex}-btn-disabled`);
      return { ok: false, reason: 'button-disabled-verification-failed' };
    }

    // 正常激活后点击
    const claim3Btn = page.locator('button:has-text("Claim 3 credits")').first();
    await claim3Btn.click({ timeout: 5000 });
    console.log('[claim] successfully clicked Claim 3 credits button');
    await sleep(5000);
    await takeScreenshot(page, `attempt${attemptIndex}-after-click-claim3`);

    // 结果校验
    const resultText = (await page.textContent('body').catch(() => '')) || '';
    const afterRefill = resultText.match(/Claims refill in\s*(\d+:\d+)/i);

    if (/success|claimed|\+3/i.test(resultText) || afterRefill) {
      const bal = resultText.match(/(\d+)\s*credits?/i);
      return {
        ok: true,
        balance: bal ? bal[1] : 'updated',
        cooldown: afterRefill ? afterRefill[1] : undefined,
      };
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
      '--disable-setuid-sandbox',
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
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
    await sleep(8000);
  }

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
