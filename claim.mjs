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

// 模拟 ESC，清理弹窗广告
async function dismissAdModals(page) {
  try {
    await page.keyboard.press('Escape');
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 1500 }).catch(() => {});
    }
  } catch {}
}

// 导出凭据：加入防毒保护，未处于登录态时绝不生成文件并清理脏文件
async function exportFreshState(context, page) {
  try {
    if (page) {
      const hasLogout = (await page.locator('text=/Log out/i').count().catch(() => 0)) > 0;
      const isLoginUrl = page.url().includes('/login');
      if (!hasLogout || isLoginUrl) {
        console.log('[auth] abort export: session not logged in');
        if (fs.existsSync('fresh-cookies.json')) fs.unlinkSync('fresh-cookies.json');
        if (fs.existsSync('fresh-localstorage.json')) fs.unlinkSync('fresh-localstorage.json');
        return false;
      }
    }

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
      const cookiesJson = JSON.stringify(freshCookies);
      fs.writeFileSync('fresh-cookies.json', cookiesJson);

      const storageJsonRaw = JSON.stringify(freshStorage);
      const storageJsonPacked = packSecretValue(storageJsonRaw);
      fs.writeFileSync('fresh-localstorage.json', storageJsonPacked.value);
      console.log(`[auth] fresh session state saved (storage: ${storageJsonPacked.bytes} bytes, cookies: ${Buffer.byteLength(cookiesJson)} bytes)`);
      return true;
    }
  } catch (e) {
    console.error('[auth] failed to export state:', e.message);
  }
  return false;
}

// 确保页面停留在真实的领取页
async function ensureOnClaimPage(page) {
  const isDirectlyReady = async () => {
    try {
      const btnCount = await page.locator('button:has-text("Claim 3 credits")').count();
      const textCount = await page.locator('text=/Claim 3 free credits/i').count();
      const statusCount = await page.locator('text=/\\d+\\s*\\/\\s*5\\s*claims?/i').count();
      return btnCount > 0 || textCount > 0 || statusCount > 0;
    } catch {
      return false;
    }
  };

  if (!page.url().includes('/claim')) {
    console.log('[nav] navigating directly to /claim...');
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    await dismissAdModals(page);
  }

  if (page.url().includes('/claim')) {
    for (let i = 0; i < 8; i++) {
      if (await isDirectlyReady()) {
        console.log('[nav] /claim elements loaded successfully');
        return true;
      }
      await sleep(1000);
    }
  }

  if (page.url().includes('/servers')) {
    console.log('[nav] redirected to /servers, clicking sidebar Credits...');
    const creditsSidebarBtn = page.locator('a[href*="credits"], a:has-text("Credits")').first();
    if (await creditsSidebarBtn.isVisible().catch(() => false)) {
      await creditsSidebarBtn.click({ force: true }).catch(() => {});
      await sleep(3500);
      await dismissAdModals(page);
    }
  }

  if (page.url().includes('/credits') && !page.url().includes('/claim')) {
    console.log('[nav] on /credits summary, clicking "Claim free credits" button...');
    const claimEntryBtn = page.locator('button:has-text("Claim free credits"), a:has-text("Claim free credits")').first();
    if (await claimEntryBtn.isVisible().catch(() => false)) {
      await claimEntryBtn.click({ force: true }).catch(() => {});
      await sleep(4000);
      await dismissAdModals(page);
    }
  }

  for (let i = 0; i < 5; i++) {
    if (await isDirectlyReady()) return true;
    await sleep(1000);
  }

  return await isDirectlyReady();
}

// 严谨校验 Turnstile 是否真正放行
async function checkTurnstilePassed(page) {
  try {
    return await page.evaluate(() => {
      // 1. 检查是否存在有效 Token
      const input = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile-response"]');
      const hasToken = !!(input && input.value && input.value.length > 20);

      // 2. 检查文本状态
      const text = document.body.innerText || '';
      const isVerifiedText = text.includes('Verified, you are human') || text.includes('成功！') || text.includes('Verification Success');
      const isSecuring = text.includes('Securing your claim');

      // 3. 严格核对按钮真实交互能力
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      let isBtnActionable = false;
      if (btn) {
        const style = window.getComputedStyle(btn);
        isBtnActionable = !btn.disabled &&
          btn.getAttribute('aria-disabled') !== 'true' &&
          style.pointerEvents !== 'none' &&
          style.cursor !== 'not-allowed' &&
          !btn.className.includes('disabled') &&
          !btn.className.includes('opacity-50');
      }

      return hasToken || isVerifiedText || (isBtnActionable && !isSecuring);
    }).catch(() => false);
  } catch {
    return false;
  }
}

// 穿透 Shadow DOM 的高精度 Turnstile 求解核心
async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  await dismissAdModals(page);

  // 阶段 1：静默等待放行（最多等待 30 秒）
  for (let i = 0; i < 15; i++) {
    if (await checkTurnstilePassed(page)) {
      console.log(`[turnstile] passed passively (${waitedSec()}s)`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (i % 5 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  // 阶段 2：通过 frameLocator 穿透 Shadow DOM 直接提取复选框物理坐标
  const cfFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();

  for (let clickNo = 1; clickNo <= 2; clickNo++) {
    let clicked = false;

    try {
      // 匹配你在 DevTools 中查看到的真实元素结构：label.cb-lb 或 input[type="checkbox"]
      const targetElement = cfFrame.locator('label.cb-lb, input[type="checkbox"], label').first();
      await targetElement.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});

      // 提取元素穿透 Shadow DOM 后的绝对屏幕坐标
      const box = await targetElement.boundingBox().catch(() => null);

      if (box) {
        // 方块复选框通常位于 label 左侧，因此取其垂直中心偏左 14px 作为绝对靶心
        const cx = Math.round(box.x + Math.min(14, box.width / 4));
        const cy = Math.round(box.y + box.height / 2);

        console.log(`[turnstile] resolved shadow-dom element box: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`);
        console.log(`[turnstile] moving native mouse to exact checkbox cx=${cx} cy=${cy}...`);

        // 模拟真人鼠标平滑轨迹移动
        await page.mouse.move(cx - 40, cy - 20, { steps: 6 });
        await sleep(120);
        await page.mouse.move(cx, cy, { steps: 8 });
        await sleep(180);
        await page.mouse.down();
        await sleep(80 + Math.floor(Math.random() * 50));
        await page.mouse.up();
        console.log(`[turnstile] native mouse clicked (${clickNo}/2) at exact center cx=${cx} cy=${cy}`);

        // 同时派发一次元素级 click 双保险
        await targetElement.click({ force: true, timeout: 2000 }).catch(() => {});
        clicked = true;
      }
    } catch (err) {
      console.log('[turnstile] shadow DOM locator error:', err.message);
    }

    if (!clicked) {
      console.log('[turnstile] target element not ready, reloading page...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3500);
      await dismissAdModals(page);
    }

    await sleep(1000);

    // 点后等待放行（最多等待 24 秒）
    for (let i = 0; i < 12; i++) {
      if (await checkTurnstilePassed(page)) {
        console.log(`[turnstile] passed after click (${waitedSec()}s)`);
        await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
        return true;
      }
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
    await ensureOnClaimPage(page);
    await sleep(2000);
    await dismissAdModals(page);

    // 严谨登录校验
    const hasLogoutBtn = (await page.locator('text=/Log out/i').count()) > 0;
    const hasPasswordBox = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    const isLoginUrl = page.url().includes('/login');

    if (!hasLogoutBtn && (hasPasswordBox || isLoginUrl)) {
      await takeScreenshot(page, `attempt${attemptIndex}-login-failed`);
      return { ok: false, reason: 'cookies-expired-or-not-logged-in' };
    }

    // 登录有效，安全导出最新凭据
    await exportFreshState(context, page);

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

    // 执行验证码求解
    await waitAndSolveTurnstile(page, attemptIndex);

    // 严谨等待按钮就绪
    const isEnabled = await page.waitForFunction(() => {
      const isSecuring = document.body.innerText.includes('Securing your claim');
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Claim 3 credits')
      );
      if (!btn || isSecuring) return false;
      const style = window.getComputedStyle(btn);
      return !btn.disabled &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        style.pointerEvents !== 'none' &&
        style.cursor !== 'not-allowed';
    }, { timeout: 15000 }).catch(() => false);

    if (!isEnabled) {
      console.log('[claim] button still disabled or securing');
      await takeScreenshot(page, `attempt${attemptIndex}-btn-disabled`);
      return { ok: false, reason: 'button-disabled-verification-failed' };
    }

    const claim3Btn = page.locator('button:has-text("Claim 3 credits")').first();
    await claim3Btn.click({ timeout: 8000, force: true });
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
      await exportFreshState(context, page);
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

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
