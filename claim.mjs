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

// 模拟 ESC，清理弹窗广告（领取页实测有固定广告横幅会盖住 Turnstile 组件，
// 需一并尝试关闭带关闭按钮的广告容器）
async function dismissAdModals(page) {
  try {
    await page.keyboard.press('Escape');
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 1500 }).catch(() => {});
    }
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('body *'));
      for (const el of all) {
        const s = window.getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'sticky') && parseInt(s.zIndex || '0', 10) >= 100) {
          const hasAdFrame = !!el.querySelector('iframe[src*="google"], iframe[id*="google_ads"], iframe[src*="ads"], iframe[src*="doubleclick"]');
          if (hasAdFrame) {
            const c = el.querySelector('[aria-label*="close" i], button[class*="close" i], [class*="close-btn" i]');
            if (c) c.click();
          }
        }
      }
    }).catch(() => {});
  } catch {}
}

// 定位可见的 Turnstile 组件（沿用实证有效的 iframe 外框定位法：
// 通过 frameElement 拿到组件在主页面中的真实外框与坐标）
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
    const srcAttr = (await iframe.getAttribute('src').catch(() => '')) || '';
    if (srcAttr.includes('challenges.cloudflare.com') || srcAttr.includes('turnstile')) {
      const box = await iframe.boundingBox().catch(() => null);
      if (box && box.width >= 200 && box.width <= 380 && box.height >= 40 && box.height <= 90) {
        return { frameEl: iframe, box };
      }
    }
  }

  return null;
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

// 校验 Turnstile 是否真正放行：主页面 token/按钮状态为主判据，
// 并穿透检查挑战 iframe 内部的成功文本（成功提示渲染在跨域 iframe 内，
// 只看主页面 innerText 永远读不到）
async function checkTurnstilePassed(page) {
  try {
    const main = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile-response"]');
      const hasToken = !!(input && input.value && input.value.length > 20);

      const text = document.body.innerText || '';
      const isVerifiedText = text.includes('Verified, you are human') || text.includes('成功！') || text.includes('Verification Success');
      const isSecuring = text.includes('Securing your claim');

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
    if (main) return true;

    const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    if (cfFrame) {
      const inFrame = await cfFrame.evaluate(() => {
        const t = document.body ? document.body.innerText : '';
        return t.includes('Success') || t.includes('成功') || t.includes('Verified');
      }).catch(() => false);
      if (inFrame) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 检测 Turnstile 是否已明确判定失败（组件会显示 Verification failed 并重置，
// 读到失败就立刻换新挑战，不要在已判死的挑战上继续等满超时）
async function checkTurnstileFailed(page) {
  try {
    const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    if (!cfFrame) return false;
    return await cfFrame.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return /verification failed|验证失败|驗證失敗/i.test(t);
    }).catch(() => false);
  } catch {
    return false;
  }
}

// 诊断：列出页面上所有挑战 iframe 的外框与样式（排查坐标点击为何不生效）
async function dumpChallengeFrames(page, tag) {
  try {
    for (const frame of page.frames()) {
      if (frame.url().includes('challenges.cloudflare.com')) {
        const el = await frame.frameElement().catch(() => null);
        if (!el) { console.log(`[frames:${tag}] frame without element`); continue; }
        const box = await el.boundingBox().catch(() => null);
        const style = await el.evaluate((n) => {
          const s = window.getComputedStyle(n);
          return { pe: s.pointerEvents, vis: s.visibility, op: s.opacity, disp: s.display };
        }).catch(() => null);
        console.log(`[frames:${tag}] box=${JSON.stringify(box)} style=${JSON.stringify(style)}`);
      }
    }
  } catch (e) {
    console.log(`[frames:${tag}] dump failed: ${e.message}`);
  }
}

// 帧内点击：直接对挑战 iframe 内部的复选框元素执行 Playwright 点击，
// 坐标由浏览器在帧内解析，绕开主页面 elementFromPoint 与外框坐标的偏差。
async function tryInFrameClick(page) {
  const fl = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
  const candidates = [
    fl.getByRole('checkbox'),
    fl.locator('input[type="checkbox"]'),
    fl.locator('label'),
  ];
  for (const loc of candidates) {
    try {
      const first = loc.first();
      if ((await first.count().catch(() => 0)) > 0) {
        await first.click({ timeout: 6000 });
        console.log('[turnstile] in-frame element click performed');
        return true;
      }
    } catch (e) {
      console.log(`[turnstile] in-frame click candidate failed: ${String(e.message).slice(0, 120)}`);
    }
  }
  return false;
}

// 在点击坐标处画一个红色标记点并截图（诊断点击到底落在哪）
async function markClickPoint(page, x, y, name) {
  await page.evaluate(({ x, y }) => {
    const d = document.createElement('div');
    d.id = '__click_marker';
    d.style.cssText = `position:fixed;left:${x - 9}px;top:${y - 9}px;width:18px;height:18px;border:3px solid red;border-radius:50%;z-index:2147483647;pointer-events:none;background:rgba(255,0,0,0.25)`;
    document.body.appendChild(d);
  }, { x, y }).catch(() => {});
  await takeScreenshot(page, name);
  await page.evaluate(() => document.getElementById('__click_marker')?.remove()).catch(() => {});
}

// Turnstile 求解：被动等待 → 组件卡死刷新 → iframe 外框坐标拟人点击。
// 点击点位于组件左侧约 26px 的复选框中心（实测结构），点前先做遮挡检测，
// 点后若组件明确判失败则刷新页面换一个全新挑战，而不是反复点击旧挑战。
async function waitAndSolveTurnstile(page, attemptIndex) {
  console.log('[turnstile] waiting for verification (passive first)...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  await dismissAdModals(page);

  // 阶段 1：静默等待自动放行（最多 46 秒）
  for (let i = 0; i < 23; i++) {
    if (await checkTurnstilePassed(page)) {
      console.log(`[turnstile] passed passively (${waitedSec()}s)`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (i % 5 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  // 组件缺失或卡死：刷新一次重置挑战环境
  let widget = await getTurnstileWidget(page);
  if (!widget) {
    console.log('[turnstile] component stalled, reloading page to refresh challenge...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(3500);
    await dismissAdModals(page);
    for (let i = 0; i < 8; i++) {
      if (await checkTurnstilePassed(page)) {
        console.log(`[turnstile] passed after reload (${waitedSec()}s)`);
        await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
        return true;
      }
      await sleep(2000);
    }
  }

  // 阶段 1.5：帧内元素点击（坐标由浏览器在帧内解析，最多 2 次）
  await dumpChallengeFrames(page, `a${attemptIndex}`);
  for (let t = 1; t <= 2; t++) {
    const clicked = await tryInFrameClick(page);
    if (!clicked) break;
    let failedSeen = false;
    for (let i = 0; i < 15; i++) {
      if (await checkTurnstilePassed(page)) {
        console.log(`[turnstile] passed after in-frame click (${waitedSec()}s)`);
        await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
        return true;
      }
      if (await checkTurnstileFailed(page)) { failedSeen = true; break; }
      await sleep(2000);
    }
    if (failedSeen) {
      console.log('[turnstile] in-frame click led to explicit failure, reloading for a fresh challenge...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3500);
      await dismissAdModals(page);
    }
  }

  // 阶段 2：坐标拟人点击（最多 3 次）
  for (let clickNo = 1; clickNo <= 3; clickNo++) {
    widget = await getTurnstileWidget(page);
    if (!widget) {
      console.log('[turnstile] checkbox not visible');
      break;
    }
    try { await widget.frameEl.scrollIntoViewIfNeeded(); } catch {}
    await sleep(800);

    widget = await getTurnstileWidget(page);
    if (!widget || !widget.box) break;

    const dx = 26 + Math.round(Math.random() * 6 - 3);
    const dy = Math.round(widget.box.height / 2 + (Math.random() * 6 - 3));
    let cx = Math.round(widget.box.x + dx);
    let cy = Math.round(widget.box.y + dy);

    // 遮挡检测：点击坐标最上层元素不是组件 iframe 时，记录遮挡者身份并清理后重新定位。
    // 清理只改遮挡元素自身的 pointer-events/visibility，绝不 display:none 祖先，避免页面布局位移让坐标失效。
    const coverInfo = await page.evaluate(({ el, x, y }) => {
      const top = document.elementFromPoint(x, y);
      if (!top || top === el) return null;
      const r = top.getBoundingClientRect();
      const s = window.getComputedStyle(top);
      return {
        tag: top.tagName,
        id: (top.id || '').slice(0, 40),
        cls: String(top.className || '').slice(0, 60),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        pos: s.position, z: s.zIndex, pe: s.pointerEvents, op: s.opacity,
      };
    }, { el: widget.frameEl, x: cx, y: cy }).catch(() => null);
    if (coverInfo) {
      console.log(`[turnstile] click point covered by ${JSON.stringify(coverInfo)}, neutralizing...`);
      await dismissAdModals(page);
      await page.evaluate(({ x, y }) => {
        const top = document.elementFromPoint(x, y);
        if (top && top.tagName !== 'IFRAME') {
          top.style.pointerEvents = 'none';
          top.style.visibility = 'hidden';
        }
      }, { x: cx, y: cy }).catch(() => {});
      await sleep(600);
      widget = await getTurnstileWidget(page);
      if (!widget || !widget.box) break;
      cx = Math.round(widget.box.x + dx);
      cy = Math.round(widget.box.y + Math.round(widget.box.height / 2));
      const stillCovered = await page.evaluate(({ el, x, y }) => {
        const top = document.elementFromPoint(x, y);
        return !!top && top !== el ? top.tagName : null;
      }, { el: widget.frameEl, x: cx, y: cy }).catch(() => null);
      console.log(`[turnstile] after neutralize, point top element: ${stillCovered || 'iframe (clear)'}`);
    }

    if (clickNo === 1) await markClickPoint(page, cx, cy, `attempt${attemptIndex}-click-marker`);
    await page.mouse.move(cx - 64, cy - 28, { steps: 9 });
    await sleep(220);
    await page.mouse.move(cx, cy, { steps: 13 });
    await sleep(300 + Math.floor(Math.random() * 300));
    await page.mouse.down();
    await sleep(80 + Math.floor(Math.random() * 80));
    await page.mouse.up();
    console.log(`[turnstile] checkbox clicked (${clickNo}/3) at dx=${dx} dy=${dy}`);
    await sleep(500);

    let failedSeen = false;
    for (let i = 0; i < 15; i++) {
      if (await checkTurnstilePassed(page)) {
        console.log(`[turnstile] passed after click (${waitedSec()}s)`);
        await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
        return true;
      }
      if (await checkTurnstileFailed(page)) { failedSeen = true; break; }
      await sleep(2000);
    }

    if (failedSeen) {
      console.log('[turnstile] verification failed explicitly, reloading for a fresh challenge...');
      await sleep(4000 + Math.floor(Math.random() * 3000));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3500);
      await dismissAdModals(page);
      for (let i = 0; i < 8; i++) {
        if (await checkTurnstilePassed(page)) {
          console.log(`[turnstile] passed after fresh challenge (${waitedSec()}s)`);
          await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
          return true;
        }
        await sleep(2000);
      }
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

// 浏览器启动（优先系统 Chrome，失败回退内置 Chromium）
async function launchBrowser() {
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
  return browser;
}

// 构建带指纹伪装与登录凭据注入的浏览器上下文
async function buildContext(browser) {
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
  return context;
}

// 主程序入口
(async () => {
  let browser = await launchBrowser();
  let context = await buildContext(browser);

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
    // 验证类失败说明当前会话已被风控标记，整浏览器重启换新会话再试，
    // 不要在同一个会话里反复撞墙
    if (result.reason === 'button-disabled-verification-failed' || result.reason === 'unknown-result') {
      console.log('[run] verification failed, relaunching browser with a fresh session...');
      await browser.close().catch(() => {});
      await sleep(5000);
      browser = await launchBrowser();
      context = await buildContext(browser);
    } else {
      await sleep(7000);
    }
  }

  console.log(`[claim] total claimed this run: ${claimedCount}`);

  // 收尾保底回写：只要会话里还有 auth 凭据就同步一次，避免 secret 断更
  await exportFreshState(context, null).catch(() => {});

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
