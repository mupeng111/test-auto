import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const AXENT_LOCAL_STORAGE = process.env.AXENT_LOCAL_STORAGE || '';
const CLAIM_URL = 'https://app.axenthost.com/claim';
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
  for (let i = 0; i < 10; i++) {
    const isCountingDown = await page.evaluate(() => {
      return document.body.innerText.includes("Verifying you're human in");
    }).catch(() => false);

    if (!isCountingDown) break;
    console.log('[turnstile] waiting for countdown timer to finish...');
    await sleep(2000);
  }

  let hasClicked = false;

  // 2. 轮询检测并通过模拟鼠标点击完成验证
  for (let i = 0; i < 15; i++) {
    await dismissAdModals(page);

    // 检查底层的 cf-turnstile-response 是否已经生成
    const hasToken = await page.evaluate(() => {
      const input = document.querySelector('input[name*="turnstile-response"]');
      return !!(input && input.value && input.value.length > 20);
    }).catch(() => false);

    // 检查前端提示与按钮状态
    const isVerifiedText = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('Verified, you are human') || text.includes('成功！');
    }).catch(() => false);

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

    // 遍历所有 iframe，寻找尺寸匹配的真实 Turnstile 区域
    let targetBox = null;
    for (const frame of page.frames()) {
      const url = frame.url();
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        const frameEl = await frame.frameElement().catch(() => null);
        if (frameEl) {
          const box = await frameEl.boundingBox().catch(() => null);
          if (box && box.width > 80 && box.height > 25) {
            targetBox = box;
            break;
          }
        }
      }
    }

    // 若通过 frames 没找到，备选使用页面 selector 查找
    if (!targetBox) {
      const iframes = await page.locator('iframe').all();
      for (const el of iframes) {
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width > 200 && box.height > 40 && box.height < 150) {
          targetBox = box;
          break;
        }
      }
    }

    // 找到目标并且未点击时触发点击
    if (targetBox && !hasClicked) {
      const clickX = targetBox.x + 35;
      const clickY = targetBox.y + targetBox.height / 2;
      console.log(`[turnstile] found widget (${Math.round(targetBox.width)}x${Math.round(targetBox.height)}), clicking checkbox at (${Math.round(clickX)}, ${Math.round(clickY)})`);

      // 拟真鼠标轨迹：平滑移入 -> 悬停 -> 点击
      await page.mouse.move(clickX - 40, clickY, { steps: 5 });
      await sleep(150);
      await page.mouse.move(clickX, clickY, { steps: 5 });
      await sleep(150);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();

      hasClicked = true;
      console.log('[turnstile] checkbox click dispatched');
    }

    await sleep(3000);
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

    // 检查登录态
    const isLoginPage = page.url().includes('login') || (await page.locator('button:has-text("Login")').count()) > 0;
    if (isLoginPage) {
      await takeScreenshot(page, `attempt${attemptIndex}-login-failed`);
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 检查冷却状态
    const isCooling = await page.evaluate(() => {
      const refillMatch = document.body.innerText.match(/Claims refill in\s*(\d+:\d+)/i);
      return refillMatch ? refillMatch[1] : null;
    });

    if (isCooling) {
      console.log(`[claim] currently in cooldown: ${isCooling}`);
      await takeScreenshot(page, `attempt${attemptIndex}-in-cooldown`);
      return { ok: false, reason: 'cooldown-or-already-claimed' };
    }

    // 处理 Turnstile 验证
    await waitAndSolveTurnstile(page, attemptIndex);

    // 轮询等待 Claim 3 credits 按钮解除 disabled
    const claim3Btn = page.locator('button:has-text("Claim 3 credits")').first();

    const isEnabled = await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      const isSecuring = document.body.innerText.includes('Securing your claim');
      return btn && !btn.disabled && !isSecuring;
    }, { timeout: 15000 }).catch(() => false);

    if (!isEnabled) {
      console.log('[claim] button still disabled or securing, cannot submit');
      await takeScreenshot(page, `attempt${attemptIndex}-btn-disabled`);
      return { ok: false, reason: 'button-disabled-verification-failed' };
    }

    // 点击领取
    await claim3Btn.click({ timeout: 5000 });
    console.log('[claim] successfully clicked Claim 3 credits button');
    await sleep(5000);
    await takeScreenshot(page, `attempt${attemptIndex}-after-click-claim3`);

    // 校验结果
    const resultText = (await page.textContent('body').catch(() => '')) || '';
    if (/success|claimed|\+3/i.test(resultText)) {
      const match = resultText.match(/(\d+)\s*credits?/i);
      return { ok: true, balance: match ? match[1] : 'unknown' };
    }

    const afterRefill = resultText.match(/Claims refill in\s*(\d+:\d+)/i);
    if (afterRefill) {
      return { ok: true, reason: 'claimed-now-cooling', cooldown: afterRefill[1] };
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

  // 注入反反爬特征伪装（Stealth）
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Google Inc. (NVIDIA)';
      if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameter.apply(this, [parameter]);
    };
  });

  // 注入 LocalStorage
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
