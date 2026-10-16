import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/* localStorage 导出超 45000 字节自动 gzip+base64 打包（'GZIP1:' 前缀），注入时自动识别解压；旧明文 JSON 照常解析 */
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

// 从环境变量读取配置
const PROXY_SERVER = process.env.PROXY_SERVER || '';
const AXENT_COOKIES = process.env.AXENT_COOKIES || '';
const AXENT_LOCAL_STORAGE = process.env.AXENT_LOCAL_STORAGE || '';
const CLAIM_URL = 'https://app.axenthost.com/claim';
const MAX_ATTEMPTS = 3;

// 截图输出目录初始化
const SCREENSHOT_DIR = 'screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 保存页面截图工具函数
async function takeScreenshot(page, name) {
  try {
    const filePath = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[screenshot] saved: ${filePath}`);
  } catch (err) {
    console.error(`[screenshot] failed to capture ${name}:`, err.message);
  }
}

// 模拟 ESC，安全关闭可能遮挡的模态弹窗/广告
async function dismissAdModals(page) {
  try {
    await page.keyboard.press('Escape');
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 1500 }).catch(() => {});
    }
  } catch {}
}

// 稳定获取可见的 Turnstile 真实组件
async function getTurnstileWidget(page) {
  // 方式 1：通过 frame 列表匹配
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

  // 方式 2：遍历页面 iframe 元素
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

// Cloudflare Turnstile 人机验证求解核心逻辑
async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification (passive first)...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  // 判定是否已通过验证
  const checkPassed = async () => {
    const hasToken = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile-response"]');
      return !!(input && input.value && input.value.length > 20);
    }).catch(() => false);
    if (hasToken) console.log('[turnstile] token seen');
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
    return hasToken || isVerifiedText || isBtnReady;
  };

  await dismissAdModals(page);

  // 阶段 1：被动等待组件自解，最长约 60 秒；Securing 期间不点击任何东西
  for (let i = 0; i < 30; i++) {
    if (await checkPassed()) {
      console.log(`[turnstile] passed without click, securing waited ${waitedSec()}s`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (i % 10 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  // 阶段 2：出现可见复选框时：现算坐标 + 单次慢点，本次尝试最多 2 次，点后各等最长 60 秒
  for (let clickNo = 1; clickNo <= 2; clickNo++) {
    let widget = await getTurnstileWidget(page);
    if (!widget) {
      console.log('[turnstile] checkbox not visible');
      break;
    }
    try {
      await widget.frameEl.scrollIntoViewIfNeeded();
    } catch (e) {}
    await sleep(1000);
    // 点击前重新读取组件位置，避免广告位移导致旧坐标失效
    widget = await getTurnstileWidget(page);
    if (!widget || !widget.box) {
      console.log('[turnstile] checkbox not visible after scroll');
      break;
    }
    const box = widget.box;
    const dx = 26 + Math.round(Math.random() * 6 - 3);
    const dy = Math.round(box.height / 2 + (Math.random() * 6 - 3));
    const cx = Math.round(box.x + dx);
    const cy = Math.round(box.y + dy);
    // 模拟平滑鼠标轨迹移动
    await page.mouse.move(cx - 64, cy - 28, { steps: 9 });
    await sleep(220);
    await page.mouse.move(cx, cy, { steps: 13 });
    await sleep(300 + Math.floor(Math.random() * 300));
    await page.mouse.down();
    await sleep(80 + Math.floor(Math.random() * 80));
    await page.mouse.up();
    console.log(
      `[turnstile] checkbox clicked (${clickNo}/2) at widget offset dx=${dx} dy=${dy}`
    );
    await sleep(500);
    let passedAfterClick = false;
    for (let i = 0; i < 20; i++) {
      if (await checkPassed()) {
        passedAfterClick = true;
        break;
      }
      if (i === 19) console.log('[turnstile] still no token after click');
      await sleep(3000);
    }
    if (passedAfterClick) return true;
  }

  console.log(`[turnstile] timeout waiting for pass after ${waitedSec()}s`);
  await takeScreenshot(page, `attempt${attemptIndex}-turnstile-timeout`);
  return false;
}

// 单次尝试领取操作
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

    // 按剩余次数判定可用性：X/5 claims 是剩余可领次数，领完时显示 All 5 hourly claims used（剩余 >0 时也会同时显示回填倒计时，不能据此判定冷却）
    const availability = await page.evaluate(() => {
      const text = document.body.innerText;
      const usedAll = /All 5 hourly claims used/i.test(text);
      const remMatch = text.match(/(\d+)\s*\/\s*5\s*claims?/i);
      const refillMatch = text.match(/Claims refill in\s*(\d+:\d+(?::\d+)?)/i);
      return {
        remaining: usedAll ? 0 : remMatch ? parseInt(remMatch[1], 10) : null,
        refill: refillMatch ? refillMatch[1] : null,
      };
    });
    console.log(`[claim] remaining claims: ${availability.remaining === null ? 'unknown' : availability.remaining}`);

    if (availability.remaining === 0 || (availability.remaining === null && availability.refill)) {
      console.log(`[claim] currently in cooldown: ${availability.refill || 'unknown'}`);
      await takeScreenshot(page, `attempt${attemptIndex}-in-cooldown`);
      return { ok: true, reason: 'cooldown-or-already-claimed', cooldown: availability.refill || undefined, remaining: availability.remaining };
    }

    // 处理 Turnstile 验证
    await waitAndSolveTurnstile(page, attemptIndex);

    // 等待按钮解除禁用
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

    // 结果校验：领取后重新读取剩余次数，剩余减少即视为本次领到
    const resultText = (await page.textContent('body').catch(() => '')) || '';
    const afterRefill = resultText.match(/Claims refill in\s*(\d+:\d+(?::\d+)?)/i);
    const usedAllAfter = /All 5 hourly claims used/i.test(resultText);
    const remAfterMatch = resultText.match(/(\d+)\s*\/\s*5\s*claims?/i);
    const remainingAfter = usedAllAfter ? 0 : remAfterMatch ? parseInt(remAfterMatch[1], 10) : null;
    console.log(`[claim] remaining after claim: ${remainingAfter === null ? 'unknown' : remainingAfter}`);

    const claimedOnce = (remainingAfter !== null && availability.remaining !== null && remainingAfter < availability.remaining) || /success|\+3/i.test(resultText);
    if (claimedOnce || (availability.remaining === null && !!afterRefill)) {
      const bal = resultText.match(/(\d+)\s*credits?/i);
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
    await page.close().catch(() => {});
  }
}

// 主执行程序入口
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

  // 指纹补齐（低调）：隐藏自动化标记并补齐常见浏览器特征
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

  // 1. 注入 LocalStorage
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

  // 冷却时间字符串转秒数辅助函数
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

  // 尝试循环领取，上限打满 5 次或遇冷却中断
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
      continue;
    }

    failures++;
    if (failures >= MAX_ATTEMPTS) break;
    await sleep(8000);
  }
  console.log(`[claim] total claimed this run: ${claimedCount}`);

  // 运行成功后，过滤并导出最新登录态文件供 Actions 写入 Secrets
  if (result.ok || result.reason === 'cooldown-or-already-claimed') {
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
      const droppedStorageKeys = [];

      for (const item of allStorageItems) {
        const k = item.name;
        const v = item.value || '';
        // 过滤掉广告商前缀与超过 5000 字节的垃圾追踪数据，但强制保留 auth 核心凭据
        const isJunk = k !== 'auth' && (
          v.length > 5000 ||
          /^(_|id5|33across|arcspan|nitro|au\/|BT_|pbjs|cto_|apstag|aps:|captify|idl_env|panorama|ntv|bb_uuid)/.test(k) ||
          k.includes('criteo') || k.includes('liveramp') || k.includes('openx') || k.includes('history')
        );
        if (isJunk) {
          droppedStorageKeys.push(k);
        } else {
          freshStorage[k] = v;
        }
      }

      const storageJsonRaw = JSON.stringify(freshStorage);
      const storageJsonPacked = packSecretValue(storageJsonRaw);
      fs.writeFileSync('fresh-localstorage.json', storageJsonPacked.value);

      if (droppedStorageKeys.length > 0) {
        console.log(`[auth] localStorage dropped ${droppedStorageKeys.length} ad/tracker junk keys: ${droppedStorageKeys.join(', ')}`);
      }

      /* 按字节数打印体积最大的前 8 个 key（仅名称+字节数，不打印值），方便核对误杀/漏杀 */
      const storageKeySizes = Object.entries(freshStorage)
        .map(([k, v]) => ({ key: k, bytes: Buffer.byteLength(String(v)) }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8);
      for (const { key, bytes } of storageKeySizes) {
        console.log(`[auth] localStorage key size: ${key} (${bytes} bytes)`);
      }

      console.log(
        `[auth] exported fresh login state: cookies ${freshCookies.length}/${mappedAll.length} kept (${Buffer.byteLength(cookiesJson)} bytes), localStorage ${Object.keys(freshStorage).length}/${allStorageItems.length} kept (raw ${storageJsonPacked.rawBytes} bytes, ${storageJsonPacked.compressed ? 'gzip' : 'plain'}, final ${storageJsonPacked.bytes} bytes)`
      );
    } catch (e) {
      console.log('[auth] failed to export fresh login state:', e.message);
    }
  }

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
