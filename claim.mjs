import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/* localStorage 导出超 45000 字节自动 gzip+base64 打包，注入时自动解压 */
function packSecretValue(jsonStr) {
  const rawBytes = Buffer.byteLength(jsonStr);
  if (rawBytes <= 45000) return { value: jsonStr, compressed: false, bytes: rawBytes, rawBytes };
  const packed = 'GZIP1:' + zlib.gzipSync(Buffer.from(jsonStr, 'utf8')).toString('base64');
  return { value: packed, compressed: true, bytes: Buffer.byteLength(packed), rawBytes };
}

function unpackSecretValue(str) {
  if (typeof str === 'string' && str.startsWith('GZIP1:')) {
    return zlib.gunzipSync(Buffer.from(str.slice(6), 'base64')).toString('utf8');
  }
  return str;
}

// 基础配置
const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const AXENT_LOCAL_STORAGE = process.env.AXENT_LOCAL_STORAGE || '';
const CLAIM_URL = 'https://app.axenthost.com/claim';
const MAX_ATTEMPTS = 4;

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

// 模拟 ESC，清理遮挡弹窗/广告
async function dismissAdModals(page) {
  try {
    await page.keyboard.press('Escape');
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 1500 }).catch(() => {});
    }
  } catch {}
}

// 定位可见的 Turnstile 组件
async function getTurnstileWidget(page) {
  for (const frame of page.frames()) {
    if (frame.url().includes('challenges.cloudflare.com')) {
      const frameEl = await frame.frameElement().catch(() => null);
      if (frameEl) {
        const box = await frameEl.boundingBox().catch(() => null);
        if (box && box.width >= 200 && box.width <= 380 && box.height >= 40 && box.height <= 90) {
          return { frameEl, box };
        }
      }
    }
  }

  const iframes = await page.locator('iframe').all();
  for (const iframe of iframes) {
    const src = (await iframe.getAttribute('src').catch(() => '')) || '';
    if (src.includes('challenges.cloudflare.com') || src.includes('turnstile')) {
      const box = await iframe.boundingBox().catch(() => null);
      if (box && box.width >= 200 && box.width <= 380 && box.height >= 40 && box.height <= 90) {
        return { frameEl: iframe, box };
      }
    }
  }

  return null;
}

// 导出并清洗登录凭据（解耦回写机制）
async function exportFreshState(context) {
  try {
    const mappedAll = (await context.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expirationDate: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));

    const keepCookie = (item) => {
      const host = (item.domain || '').replace(/^\./, '').toLowerCase();
      return (
        host === 'axenthost.com' ||
        host.endsWith('.axenthost.com') ||
        host === 'challenges.cloudflare.com' ||
        host === 'cloudflare.com' ||
        host.endsWith('.cloudflare.com')
      );
    };

    const freshCookies = mappedAll.filter(keepCookie);
    const cookiesJson = JSON.stringify(freshCookies);
    fs.writeFileSync('fresh-cookies.json', cookiesJson);

    const state = await context.storageState();
    const axentOrigin = (state.origins || []).find((o) => o.origin === 'https://app.axenthost.com');
    const allStorageItems = axentOrigin?.localStorage || [];
    const freshStorage = {};

    for (const item of allStorageItems) {
      const k = item.name;
      const v = item.value || '';
      const isJunk = k !== 'auth' && (
        v.length > 5000 ||
        /^(_|id5|33across|arcspan|nitro|au\/|BT_|pbjs|cto_|apstag|aps:|captify|idl_env|panorama|ntv|bb_uuid)/.test(k) ||
        k.includes('criteo') || k.includes('liveramp') || k.includes('openx') || k.includes('history')
      );
      if (!isJunk) {
        freshStorage[k] = v;
      }
    }

    if (freshStorage['auth']) {
      const storageJsonRaw = JSON.stringify(freshStorage);
      const storageJsonPacked = packSecretValue(storageJsonRaw);
      fs.writeFileSync('fresh-localstorage.json', storageJsonPacked.value);
      return true;
    }
  } catch (e) {
    console.error('[auth] failed to export state:', e.message);
  }
  return false;
}

// 确保页面正确抵达真实的 /claim 领取界面
async function ensureOnClaimPage(page) {
  const isDirectlyReady = async () => {
    const hasClaimBtn = (await page.locator('button:has-text("Claim 3 credits")').count()) > 0;
    const hasClaimText = (await page.locator('text=/Claim 3 free credits/i').count()) > 0;
    return hasClaimBtn || hasClaimText;
  };

  if (await isDirectlyReady()) return true;

  // 1. 如果不在领取页，先尝试直接访问 /claim
  if (!page.url().includes('/claim')) {
    console.log('[nav] navigating directly to /claim...');
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    await dismissAdModals(page);
    if (await isDirectlyReady()) return true;
  }

  // 2. 如果被重定向到了 /servers，点击侧边栏的 "Credits"
  if (page.url().includes('/servers') || (await page.locator('h1:has-text("Servers"), text=/^Servers$/i').count()) > 0) {
    console.log('[nav] redirected to /servers, clicking sidebar Credits...');
    const creditsSidebarBtn = page.locator('a:has-text("Credits"), button:has-text("Credits")').first();
    if (await creditsSidebarBtn.isVisible().catch(() => false)) {
      await creditsSidebarBtn.click({ force: true }).catch(() => {});
      await sleep(3500);
      await dismissAdModals(page);
    }
  }

  // 3. 如果停留在 /credits 汇总页，点击黄色的 "Claim free credits" 按钮进入领取页
  if (page.url().includes('/credits') || (await page.locator('button:has-text("Claim free credits")').count()) > 0) {
    console.log('[nav] on /credits summary, clicking "Claim free credits" button...');
    const claimEntryBtn = page.locator('button:has-text("Claim free credits"), a:has-text("Claim free credits")').first();
    if (await claimEntryBtn.isVisible().catch(() => false)) {
      await claimEntryBtn.click({ force: true }).catch(() => {});
      await sleep(4000);
      await dismissAdModals(page);
    }
  }

  return await isDirectlyReady();
}

// Turnstile 求解与防卡死自愈
async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification (passive first)...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  const checkPassed = async () => {
    try {
      const hasToken = await page.evaluate(() => {
        const input = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile-response"]');
        return !!(input && input.value && input.value.length > 20);
      }).catch(() => false);
      if (hasToken) console.log('[turnstile] token seen');

      const isVerifiedText = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('Verified, you are human') || text.includes('成功！') || text.includes('Verification Success');
      }).catch(() => false);

      const isBtnReady = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          b.textContent.includes('Claim 3 credits')
        );
        const isSecuring = document.body.innerText.includes('Securing your claim');
        return btn && !btn.disabled && !isSecuring;
      }).catch(() => false);

      return hasToken || isVerifiedText || isBtnReady;
    } catch {
      return false;
    }
  };

  await dismissAdModals(page);

  // 阶段 1：静默等待放行
  for (let i = 0; i < 15; i++) {
    if (await checkPassed()) {
      console.log(`[turnstile] passed without click, securing waited ${waitedSec()}s`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (i % 5 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  // 超过 30 秒卡死且无组件时，刷新重载挑战
  let initialWidget = await getTurnstileWidget(page);
  if (!initialWidget) {
    console.log('[turnstile] component stalled, reloading page to refresh challenge...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(3000);
    await dismissAdModals(page);
    if (await checkPassed()) return true;
  }

  // 阶段 2：模拟点击复选框
  for (let clickNo = 1; clickNo <= 2; clickNo++) {
    let widget = await getTurnstileWidget(page);
    if (!widget) {
      console.log('[turnstile] checkbox not visible');
      break;
    }
    try {
      await widget.frameEl.scrollIntoViewIfNeeded();
    } catch (e) {}
    await sleep(800);

    widget = await getTurnstileWidget(page);
    if (!widget || !widget.box) break;

    const box = widget.box;
    const dx = 26 + Math.round(Math.random() * 6 - 3);
    const dy = Math.round(box.height / 2 + (Math.random() * 6 - 3));
    const cx = Math.round(box.x + dx);
    const cy = Math.round(box.y + dy);

    await page.mouse.move(cx - 64, cy - 28, { steps: 9 });
    await sleep(220);
    await page.mouse.move(cx, cy, { steps: 13 });
    await sleep(300 + Math.floor(Math.random() * 300));
    await page.mouse.down();
    await sleep(80 + Math.floor(Math.random() * 80));
    await page.mouse.up();
    console.log(`[turnstile] checkbox clicked (${clickNo}/2) at dx=${dx} dy=${dy}`);
    await sleep(500);

    for (let i = 0; i < 15; i++) {
      if (await checkPassed()) return true;
      await sleep(2000);
    }
  }

  console.log(`[turnstile] timeout after ${waitedSec()}s`);
  await takeScreenshot(page, `attempt${attemptIndex}-turnstile-timeout`);
  return false;
}

// 单次执行领取
async function claimOnce(context, attemptIndex) {
  const page = await context.newPage();

  try {
    // 自动纠偏并导航至领取页面
    await ensureOnClaimPage(page);
    await sleep(2500);
    await dismissAdModals(page);

    // 检查登录态
    const currentUrl = page.url();
    const isLoginPage = currentUrl.includes('login') || (await page.locator('button:has-text("Login")').count()) > 0;
    if (isLoginPage) {
      await takeScreenshot(page, `attempt${attemptIndex}-login-failed`);
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 只要成功进入控制台且未处于登录页，立刻更新保存基础会话
    await exportFreshState(context);

    // 读取可用状态与冷却时间
    const availability = await page.evaluate(() => {
      try {
        const text = document.body.innerText;
        const usedAll = /All 5 hourly claims used/i.test(text);
        const remMatch = text.match(/(\d+)\s*\/\s*5\s*claims?/i);
        const refillMatch = text.match(/Claims refill in\s*(\d+:\d+(?::\d+)?)/i);
        return {
          remaining: usedAll ? 0 : remMatch ? parseInt(remMatch[1], 10) : null,
          refill: refillMatch ? refillMatch[1] : null,
        };
      } catch {
        return { remaining: null, refill: null };
      }
    });

    console.log(`[claim] remaining claims: ${availability.remaining === null ? 'unknown' : availability.remaining}`);

    if (availability.remaining === 0 || (availability.remaining === null && availability.refill && !/Ready/i.test(availability.refill))) {
      console.log(`[claim] currently in cooldown: ${availability.refill || 'unknown'}`);
      await takeScreenshot(page, `attempt${attemptIndex}-in-cooldown`);
      return { ok: true, reason: 'cooldown-or-already-claimed', cooldown: availability.refill || undefined, remaining: availability.remaining };
    }

    // 处理 Turnstile
    await waitAndSolveTurnstile(page, attemptIndex);

    // 等待领取按钮激活
    const isEnabled = await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      const isSecuring = document.body.innerText.includes('Securing your claim');
      return btn && !btn.disabled && !isSecuring;
    }, { timeout: 15000 }).catch(() => false);

    if (!isEnabled) {
      console.log('[claim] button still disabled or securing');
      await takeScreenshot(page, `attempt${attemptIndex}-btn-disabled`);
      return { ok: false, reason: 'button-disabled-verification-failed' };
    }

    const claim3Btn = page.locator('button:has-text("Claim 3 credits")').first();
    await claim3Btn.click({ timeout: 5000 });
    console.log('[claim] successfully clicked Claim 3 credits button');
    await sleep(4000);
    await takeScreenshot(page, `attempt${attemptIndex}-after-click-claim3`);

    const resultText = (await page.textContent('body').catch(() => '')) || '';
    const afterRefill = resultText.match(/Claims refill in\s*(\d+:\d+(?::\d+)?)/i);
    const usedAllAfter = /All 5 hourly claims used/i.test(resultText);
    const remAfterMatch = resultText.match(/(\d+)\s*\/\s*5\s*claims?/i);
    const remainingAfter = usedAllAfter ? 0 : remAfterMatch ? parseInt(remAfterMatch[1], 10) : null;
    console.log(`[claim] remaining after claim: ${remainingAfter === null ? 'unknown' : remainingAfter}`);

    const claimedOnce = (remainingAfter !== null && availability.remaining !== null && remainingAfter < availability.remaining) || /success|\+3/i.test(resultText);
    if (claimedOnce || (availability.remaining === null && !!afterRefill)) {
      const bal = resultText.match(/(\d+)\s*credits?/i);
      await exportFreshState(context);
      return {
        ok: true,
        balance: bal ? bal[1] : 'updated',
        remaining: remainingAfter,
        cooldown: afterRefill ? afterRefill[1] : undefined,
      };
    }

    await takeScreenshot(page, `attempt${attemptIndex}-unknown-result`);
    return { ok: false, reason: 'unknown-result' };
  } catch (err) {
    await takeScreenshot(page, `attempt${attemptIndex}-exception`);
    return { ok: false, reason: `exception: ${err.message.slice(0, 120)}` };
  } finally {
    // 增加 3 秒超时竞争，防止 Chromium 异常时无限挂起
    try {
      await Promise.race([
        page.close({ runBeforeUnload: false }),
        sleep(3000),
      ]);
    } catch {}
  }
}

// 主程序入口
(async () => {
  const launchOpts = {
    headless: false,
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

  let browser;
  let browserKind = 'chromium (bundled)';
  try {
    browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    browserKind = 'chrome (system)';
  } catch (e) {
    console.log('[browser] chrome channel failed, falling back to bundled chromium');
    browser = await chromium.launch(launchOpts);
  }
  console.log(`[browser] launched with ${browserKind}`);

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ],
    });
  });
  console.log('[browser] fingerprint init script added');

  if (AXENT_LOCAL_STORAGE) {
    try {
      const storage = JSON.parse(unpackSecretValue(AXENT_LOCAL_STORAGE));
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

  const cooldownToSeconds = (value) => {
    if (!value) return null;
    const parts = String(value).split(':').map(Number);
    if (parts.some(Number.isNaN)) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
  };

  let result = { ok: false, reason: 'not-run' };
  let claimedCount = 0;
  let failures = 0;
  let waitedShortCooldown = false;

  for (let attemptNo = 1; ; attemptNo++) {
    console.log(`[run] attempt ${attemptNo}`);
    result = await claimOnce(context, attemptNo);
    console.log('[run] result:', JSON.stringify(result));

    if (result.reason === 'cooldown-or-already-claimed') {
      const cooldownSec = cooldownToSeconds(result.cooldown);
      if (claimedCount === 0 && !waitedShortCooldown && cooldownSec !== null && cooldownSec <= 12 * 60) {
        waitedShortCooldown = true;
        console.log(`[claim] short cooldown ${result.cooldown}, waiting ${cooldownSec + 15}s`);
        await sleep((cooldownSec + 15) * 1000);
        continue;
      }
      break;
    }

    if (result.ok) {
      claimedCount++;
      console.log(`[claim] claimed this run: ${claimedCount}`);
      if (claimedCount >= 5) break;

      const pacingDelay = 9000 + Math.floor(Math.random() * 6000);
      console.log(`[pacing] waiting ${(pacingDelay / 1000).toFixed(1)}s before next claim...`);
      await sleep(pacingDelay);
      continue;
    }

    failures++;
    if (failures >= MAX_ATTEMPTS) break;
    await sleep(7000);
  }

  console.log(`[claim] total claimed this run: ${claimedCount}`);

  // 退出前保底更新凭据
  await exportFreshState(context);

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
