import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFile } from 'child_process';

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
// v22（2026-11-09）：自动重登。Axent 令牌 expiresAt 写死登录时刻 +24h、永不顺延、
// 无 refresh 接口（前端代码实证无任何续期调用），回写只能存同一枚倒计时令牌。
// 唯一续命 = 重走 Discord OAuth。DISCORD_COOKIES / DISCORD_LOCAL_STORAGE 存在时，
// 令牌剩余 <90 分钟或中途 401 就自动 OAuth 重登换新令牌；两个 secret 都缺失时
// 行为与 v21 逐字节一致。
const DISCORD_COOKIES = process.env.DISCORD_COOKIES || '';
const DISCORD_LOCAL_STORAGE = process.env.DISCORD_LOCAL_STORAGE || '';
// 本轮 OAuth 换到的新鲜 auth（原始 JSON 字符串）。上下文若被重建（验证失败重
// 启浏览器路径），env 里的旧 auth 会被重新注入——导出回写时用它覆盖，防旧令牌
// 反写覆盖新令牌。
let freshAuthJson = null;
let reloginTried = false;
const CLAIM_URL = 'https://app.axenthost.com/claim';
// v12（2026-11-06，#835–#838 原始日志复盘）：失败轮里同轮换新会话重试的实测通过率
// 为 0（#811/#814–#816/#835–#838 共十余次 attempt≥2 无一成功；所有成功轮都赢在
// 每轮第一个挑战实例上：#801/#809/#812/#822/#824）。高频撞挑战疑似只会喂高出口
// IP 的风控分。故每轮失败尝试上限 4→2，轮与轮之间交给整点节奏重试。
const MAX_ATTEMPTS = 2;
// v7：上一轮记录挑战是否处于“不可见”状态。#770/#771 实证：挑战帧连续 8 次
// 全程不可见时，换新会话重跑毫无意义，只会多送 3 次挑战交互、继续抬高风控评分。
let lastTurnstileInvisible = false;

const SCREENSHOT_DIR = 'screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// v8：按出口 IP 的真实地理位置对齐浏览器时区。旧版写死 America/New_York，
// 配新加坡/欧洲出口时与 IP 归属地严重不一致，是 Turnstile 评分的强扣分项。
let egressGeoCache = null;
async function detectEgressGeo() {
  if (egressGeoCache) return egressGeoCache;
  egressGeoCache = { timezone: null, country: null };
  if (!PROXY_SERVER) return egressGeoCache;
  const proxyArg = PROXY_SERVER.replace(/^socks5:/, 'socks5h:');
  const urls = ['http://ip-api.com/json/?fields=status,timezone,countryCode', 'https://ipapi.co/json/'];
  for (const u of urls) {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('curl', ['-s', '-m', '10', '--proxy', proxyArg, u], (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const j = JSON.parse(out);
      const tz = j.timezone || j.time_zone;
      if (tz) {
        egressGeoCache = { timezone: tz, country: j.countryCode || j.country_code || null };
        console.log(`[geo] egress timezone=${tz} country=${egressGeoCache.country || '?'}`);
        return egressGeoCache;
      }
    } catch {}
  }
  console.log('[geo] egress geo lookup failed, keeping default timezone');
  return egressGeoCache;
}

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
// v22：解析当前 secret 里 Axent 令牌的到期时刻（毫秒），解析失败返回 null
function storedAuthExpiresAt() {
  try {
    if (!AXENT_LOCAL_STORAGE) return null;
    const storage = JSON.parse(unpackSecretValue(AXENT_LOCAL_STORAGE));
    const auth = storage.auth ? JSON.parse(storage.auth) : null;
    const exp = auth?.token?.expiresAt ? Date.parse(auth.token.expiresAt) : NaN;
    return Number.isNaN(exp) ? null : exp;
  } catch {
    return null;
  }
}

// v22：把 Discord 会话注入上下文（localStorage 只在 discord.com 域生效，
// 以免 Discord 的 token 键污染 Axent 本源存储、被 Axent 导出误带出去）
async function injectDiscordSession(context) {
  if (DISCORD_LOCAL_STORAGE) {
    try {
      const storage = JSON.parse(unpackSecretValue(DISCORD_LOCAL_STORAGE));
      await context.addInitScript((items) => {
        if (!window.location.hostname.endsWith('discord.com')) return;
        for (const [k, v] of Object.entries(items)) {
          try { window.localStorage.setItem(k, v); } catch {}
        }
      }, storage);
      console.log('[relogin] discord localStorage injection armed');
    } catch (e) {
      console.error('[relogin] failed to parse DISCORD_LOCAL_STORAGE:', e.message);
    }
  }
  if (DISCORD_COOKIES) {
    try {
      const parsed = JSON.parse(DISCORD_COOKIES);
      const cookies = parsed
        .filter((item) => (item.domain || '').replace(/^\./, '').toLowerCase().endsWith('discord.com'))
        .map((item) => ({
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
      console.log(`[relogin] injected ${cookies.length} discord cookies`);
    } catch (e) {
      console.error('[relogin] failed to parse DISCORD_COOKIES:', e.message);
    }
  }
}

// v22：导出 Discord 会话（只留 token 类键 + discord.com 自家 cookie），供回写
// 让 Discord 会话跟着每轮滚动更新。Discord 本源没被访问过时直接跳过。
async function exportDiscordState(context) {
  try {
    const state = await context.storageState();
    const origin = (state.origins || []).find((o) => o.origin === 'https://discord.com');
    const items = origin?.localStorage || [];
    if (!items.some((i) => i.name === 'token' && i.value)) return false;
    const keep = {};
    for (const i of items) {
      if (i.name === 'token' || i.name === 'tokens') keep[i.name] = i.value;
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
    const discordCookies = mappedAll.filter((c) => {
      const host = (c.domain || '').replace(/^\./, '').toLowerCase();
      return host === 'discord.com' || host.endsWith('.discord.com');
    });
    fs.writeFileSync('fresh-discord-cookies.json', JSON.stringify(discordCookies));
    const packed = packSecretValue(JSON.stringify(keep));
    fs.writeFileSync('fresh-discord-localstorage.json', packed.value);
    console.log(`[relogin] discord session state saved (storage: ${packed.bytes} bytes, cookies: ${discordCookies.length})`);
    return true;
  } catch (e) {
    console.error('[relogin] failed to export discord state:', e.message);
  }
  return false;
}

// v22：走 Discord OAuth 给 Axent 换一枚新 24h 令牌。
// 云浏览器实测（2026-11-09）：已登录的 Discord 会话点 Login with Discord →
// 授权页点一次 Authorise → 跳回站内即完成；无密码、无验证码、无邮箱验证。
async function reloginViaDiscord(context) {
  const prevExp = storedAuthExpiresAt() || 0;
  const page = await context.newPage();
  try {
    await injectDiscordSession(context);
    await page.goto('https://app.axenthost.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const loginBtn = page.locator('button:has-text("Login with Discord"), a:has-text("Login with Discord")').first();
    if ((await loginBtn.count().catch(() => 0)) === 0) {
      await takeScreenshot(page, 'relogin-no-discord-button');
      return { ok: false, reason: 'relogin-button-not-found' };
    }
    await loginBtn.click();
    await page.waitForURL(/discord\.com/, { timeout: 45000 }).catch(() => {});
    await sleep(4000);
    if (page.url().includes('/oauth2/authorize')) {
      const hasLoginForm = (await page.locator('input[name="email"], input[type="email"]').count().catch(() => 0)) > 0;
      if (hasLoginForm) {
        await takeScreenshot(page, 'relogin-discord-session-dead');
        return { ok: false, reason: 'discord-session-expired' };
      }
      const authBtn = page.locator('button:has-text("Authorise"), button:has-text("Authorize")').last();
      if ((await authBtn.count().catch(() => 0)) === 0) {
        await takeScreenshot(page, 'relogin-no-authorize-button');
        return { ok: false, reason: 'authorize-button-not-found', url: page.url() };
      }
      await authBtn.click();
      console.log('[relogin] clicked Authorise on discord oauth page');
    }
    await page.waitForURL(/app\.axenthost\.com/, { timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      if (!/app\.axenthost\.com/.test(page.url())) {
        await page.goto('https://app.axenthost.com/claim', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      const authJson = await page.evaluate(() => window.localStorage.getItem('auth')).catch(() => null);
      if (authJson) {
        try {
          const a = JSON.parse(authJson);
          const exp = a?.token?.expiresAt ? Date.parse(a.token.expiresAt) : 0;
          // 必须是比旧令牌更新、且寿命充足的令牌，防把旧 auth 误判为重登成功
          if (exp > prevExp + 60000 && exp - Date.now() > 3 * 3600 * 1000) {
            freshAuthJson = authJson;
            console.log(`[relogin] fresh token minted, expiresAt=${a.token.expiresAt}, user=${a?.user?.pseudo || a?.user?.email || '?'}`);
            await exportFreshState(context, null).catch(() => {});
            return { ok: true, expiresAt: a.token.expiresAt };
          }
        } catch {}
      }
    }
    await takeScreenshot(page, 'relogin-no-new-auth');
    return { ok: false, reason: 'relogin-no-new-token' };
  } catch (e) {
    return { ok: false, reason: 'relogin-exception', error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function exportFreshState(context, page) {
  // v22：Discord 会话导出独立于 Axent 登录态，单独跑一份
  await exportDiscordState(context).catch(() => {});
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
      // v13（2026-11-06）：不再持久化 Cloudflare 域 cookie。__cf_bm / cf_clearance
      // 这类挑战 cookie 是按出口 IP + 会话签发的，一旦某轮会话被风控标记，它的
      // CF cookie 被每轮回写、每轮重放，就会形成"毒 cookie 死循环"——这与
      // #835–#842 的实测形态完全吻合：令牌有效、页面正常、换两个出口同一种
      // 死法、且成功轮（#801/#822/#824）的挑战都是在干净 CF 状态下被动通过的。
      // 只持久化 axenthost.com 自家 cookie，CF 状态每轮从零开始。
      return host === 'axenthost.com' || host.endsWith('.axenthost.com');
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

    // v22：本轮 OAuth 换过令牌时以新鲜 auth 为准，防止上下文里的旧值反写覆盖
    if (freshAuthJson) freshStorage['auth'] = freshAuthJson;

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
    const allFrames = page.frames();
    console.log(`[frames:${tag}] total=${allFrames.length} cf=${allFrames.filter((f) => f.url().includes('challenges.cloudflare.com')).length}`);
    for (const frame of page.frames()) {
      if (frame.url().includes('challenges.cloudflare.com')) {
        const el = await frame.frameElement().catch(() => null);
        if (!el) { console.log(`[frames:${tag}] frame without element`); continue; }
        const box = await el.boundingBox().catch(() => null);
        const style = await el.evaluate((n) => {
          const s = window.getComputedStyle(n);
          return { pe: s.pointerEvents, vis: s.visibility, op: s.opacity, disp: s.display };
        }).catch(() => null);
        const txt = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120)).catch(() => null);
        console.log(`[frames:${tag}] box=${JSON.stringify(box)} style=${JSON.stringify(style)} text=${JSON.stringify(txt)}`);
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

// 读挑战 iframe 内部文本（组件真实状态：未勾选 / 验证中 / 失败原因）
async function challengeFrameText(page) {
  for (const frame of page.frames()) {
    if (frame.url().includes('challenges.cloudflare.com')) {
      const t = await frame.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 140)).catch(() => null);
      if (t) return t;
    }
  }
  return null;
}

// 关闭 Google 插页广告（vignette）：优先点它自带的 Close/dismiss 控件，其次 Esc。
async function closeVignette(page) {
  const selectors = [
    '#dismiss-button',
    '[id*="dismiss-button"]',
    'div[aria-label="Close ad"]',
    '[aria-label="Close ad"]',
    '.google-ad-close',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0 && await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 3000 });
        console.log(`[ads] vignette closed via ${sel}`);
        await sleep(800);
        return true;
      }
    } catch {}
  }
  // 兜底：右上角区域的 "Close" 文本控件
  try {
    const loc = page.locator('text=/^Close$/').first();
    if ((await loc.count().catch(() => 0)) > 0 && await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 3000 });
      console.log('[ads] vignette closed via Close text');
      await sleep(800);
      return true;
    }
  } catch {}
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

// 清除全屏广告层（插页 iframe 及其遮罩容器），并检测页面是否已被广告带离站点
async function sweepFullscreenAds(page) {
  const removed = await page.evaluate(() => {
    let n = 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const el of Array.from(document.querySelectorAll('iframe, div'))) {
      const r = el.getBoundingClientRect();
      if (r.width >= vw * 0.95 && r.height >= vh * 0.95) {
        const id = el.id || '';
        const src = el.tagName === 'IFRAME' ? (el.getAttribute('src') || '') : '';
        const hasAdFrame = !!el.querySelector?.('iframe[id*="google_ads"], iframe[src*="googlesyndication"], iframe[src*="doubleclick"]');
        if (id.includes('google_ads') || src.includes('googlesyndication') || src.includes('doubleclick') || hasAdFrame) {
          el.remove();
          n++;
        }
      }
    }
    return n;
  }).catch(() => 0);
  if (removed > 0) console.log(`[ads] swept ${removed} fullscreen ad layer(s)`);
  return removed;
}

async function ensureOnSite(page) {
  if (!page.url().includes('axenthost.com')) {
    console.log(`[ads] page navigated away to ${page.url().slice(0, 80)}, returning to claim page...`);
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    await dismissAdModals(page);
    return false;
  }
  return true;
}

// Turnstile 求解 v18（2026-11-06）：
// 本地 A/B 实测（同会话、同出口、同浏览器）：
//   probeA（仅隐藏 webdriver，不动 DOM、不点）→ 43 秒隐形通过发 token；
//   probeB（probeA + 指纹补丁）→ 43 秒时框翻成 300×65 互动模式，90 秒无 token。
// 结论：指纹补丁本身就是触发互动模式的毒药（已在 buildContext 里删掉）。
// 求解按 Heisi 定的逻辑：先被动等 token；框真渲染出内容（复选框）才点，
// 点的是帧内元素本身；框是空的绝不盲点坐标——直接刷新换一个新挑战。
async function waitAndSolveTurnstile(page, attemptIndex) {
  lastTurnstileInvisible = false;
  console.log('[turnstile] waiting for verification (passive first)...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  // 阶段 1：被动等 token（最长 120 秒）。期间不改 DOM、不点、不清广告——
  // probeA 证明静等就能过；任何页面改动都可能抬高风控。
  for (let i = 0; i < 60; i++) {
    if (await checkTurnstilePassed(page)) {
      console.log(`[turnstile] passed passively (${waitedSec()}s)`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (await checkTurnstileFailed(page)) break;
    if (i % 5 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  // 阶段 2：框已渲染出内容（真复选框）→ 帧内元素点击，等绿勾。
  const frameText = await challengeFrameText(page);
  if (frameText) {
    console.log(`[turnstile] widget rendered (${JSON.stringify(frameText.slice(0, 80))}), clicking checkbox...`);
    await dumpChallengeFrames(page, `a${attemptIndex}`);
    const clicked = await tryInFrameClick(page);
    if (clicked) {
      for (let i = 0; i < 30; i++) {
        if (await checkTurnstilePassed(page)) {
          console.log(`[turnstile] passed after click (${waitedSec()}s)`);
          await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
          return true;
        }
        if (await checkTurnstileFailed(page)) break;
        await sleep(2000);
      }
    } else {
      console.log('[turnstile] no clickable checkbox element in frame');
    }
  } else {
    // 框是空的：刷新换一个新挑战，再被动等 60 秒，绝不盲点坐标。
    lastTurnstileInvisible = true;
    console.log('[turnstile] challenge frame empty, reloading for a fresh challenge (no blind click)...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(3500);
    for (let i = 0; i < 30; i++) {
      if (await checkTurnstilePassed(page)) {
        console.log(`[turnstile] passed after reload (${waitedSec()}s)`);
        await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
        return true;
      }
      if (await checkTurnstileFailed(page)) break;
      await sleep(2000);
    }
  }

  console.log(`[turnstile] timeout after ${waitedSec()}s`);
  await takeScreenshot(page, `attempt${attemptIndex}-turnstile-timeout`);
  return false;
}

// 拟人停留：随机轨迹移动鼠标 + 小幅滚动，产生真实会话的行为信号
async function humanDwell(page, totalMs) {
  const steps = Math.max(2, Math.floor(totalMs / 2500));
  for (let i = 0; i < steps; i++) {
    const x = 300 + Math.floor(Math.random() * 900);
    const y = 200 + Math.floor(Math.random() * 500);
    await page.mouse.move(x, y, { steps: 12 }).catch(() => {});
    if (i % 2 === 1) await page.mouse.wheel(0, 120 + Math.floor(Math.random() * 200)).catch(() => {});
    await sleep(2000 + Math.floor(Math.random() * 800));
  }
}

// v9：等领取页 UI 真正渲染出来（领取按钮 / 验证组件容器 / 挑战 iframe 任一出现）。
// #792 实证：页面正文一直停在 "Loading..."，验证组件根本没被创建——
// 旧流程在空白页上等 Turnstile 出现，等多久都不会有。
async function waitForClaimUi(page, timeoutSec, tag) {
  const start = Date.now();
  let poll = 0;
  while ((Date.now() - start) / 1000 < timeoutSec) {
    poll++;
    const st = await page.evaluate(() => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        loading: text.includes('Loading...'),
        hasClaimBtn: !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Claim 3 credits')),
        hasWidget: document.querySelectorAll('.cf-turnstile, [data-sitekey]').length > 0,
        hasCfFrame: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
        textLen: text.length,
      };
    }).catch(() => null);
    if (st && (st.hasClaimBtn || st.hasWidget || st.hasCfFrame)) {
      console.log(`[load:${tag}] claim UI ready ${JSON.stringify(st)}`);
      return true;
    }
    if (st && poll % 6 === 1) console.log(`[load:${tag}] waiting UI ${JSON.stringify(st)}`);
    await sleep(5000);
  }
  console.log(`[load:${tag}] claim UI not ready after ${timeoutSec}s`);
  return false;
}

// 单次执行领取
async function claimOnce(context, attemptIndex) {
  const page = await context.newPage();
  let api401Count = 0;

  page.on('requestfailed', (req) => {
    const u = req.url();
    console.log(`[net] requestfailed ${u.slice(0, 100)} ${req.failure()?.errorText || ''}`);
  });
  page.on('response', (res) => {
    if (res.status() === 401 && res.url().includes('api.axenthost.com')) api401Count++;
    if (res.status() >= 400) {
      console.log(`[net] response ${res.status()} ${res.url().slice(0, 100)}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[console] ${msg.text().slice(0, 160)}`);
  });
  page.on('pageerror', (err) => console.log(`[pageerror] ${String(err.message).slice(0, 160)}`));

  try {
    // v8 预热：先落站点首页拟人停留，再进领取页，而不是新会话第一跳直冲 /claim
    await page.goto('https://app.axenthost.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await humanDwell(page, 9000);
    await ensureOnClaimPage(page);
    await sleep(2000);
    await dismissAdModals(page);

    // v8 诊断：Turnstile 在页面上的真实存在形态（api 是否加载、容器、iframe 列表）
    const diag = await page.evaluate(() => ({
      turnstileApi: typeof window.turnstile,
      widgetDivs: document.querySelectorAll('.cf-turnstile, [data-sitekey]').length,
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => (f.getAttribute('src') || f.id || '').slice(0, 60)),
    })).catch(() => null);
    if (diag) console.log(`[diag] turnstileApi=${diag.turnstileApi} widgetDivs=${diag.widgetDivs} iframes=${JSON.stringify(diag.iframes)}`);

    // v14 诊断（2026-11-06）：把页面实际看到的浏览器环境一次性打全——UA、平台、
    // WebGL 渲染器（页面视角，已含 init script 补丁后的值）、时区、语言、存储键名。
    // #835 起在无任何代码变更下由全过变全挂，环境侧必须先有可比对的实测数据再动手。
    // 只打名称/公开属性，绝不打 cookie 值与存储值。
    const envDiag = await page.evaluate(() => {
      let gl = null;
      try {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (g) {
          const ext = g.getExtension('WEBGL_debug_renderer_info');
          gl = ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(g.getParameter(g.RENDERER));
        }
      } catch (e) { gl = 'err:' + e.message; }
      return {
        ua: navigator.userAgent,
        platform: navigator.platform,
        uaDataPlatform: (navigator.userAgentData && navigator.userAgentData.platform) || null,
        lang: navigator.language,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMin: new Date().getTimezoneOffset(),
        screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
        cores: navigator.hardwareConcurrency,
        gl,
        lsKeys: Object.keys(localStorage),
      };
    }).catch((e) => ({ err: e.message }));
    console.log(`[env] ${JSON.stringify(envDiag)}`);
    const cookieNames = (await context.cookies('https://app.axenthost.com').catch(() => []))
      .map((c) => `${c.name}@${c.domain}`);
    console.log(`[env] cookies(${cookieNames.length}): ${JSON.stringify(cookieNames)}`);

    // v9：先确认领取页 UI 真的渲染完，再进入验证码流程；在 "Loading..." 空白页上等组件是无用功。
    // 直连等 90s → 刷新再等 90s → 资源计时定因 + 改走 /servers 后 SPA 内导航到领取。
    let uiReady = await waitForClaimUi(page, 90, 'direct');
    if (!uiReady) {
      const resTail = await page.evaluate(() => performance.getEntriesByType('resource').slice(-25).map((e) => `${e.name.slice(0, 80)} dur=${Math.round(e.duration)} end=${Math.round(e.responseEnd)}`)).catch(() => []);
      console.log(`[load] resource timing tail: ${JSON.stringify(resTail)}`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await dismissAdModals(page);
      uiReady = await waitForClaimUi(page, 90, 'reload');
    }
    if (!uiReady) {
      console.log('[load] falling back to /servers then in-app navigation to claim...');
      await page.goto('https://app.axenthost.com/servers', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(5000);
      const creditsBtn = page.locator('a[href*="credits"], a:has-text("Credits")').first();
      if (await creditsBtn.isVisible().catch(() => false)) {
        await creditsBtn.click().catch(() => {});
        await sleep(4000);
      }
      const claimEntry = page.locator('button:has-text("Claim free credits"), a:has-text("Claim free credits")').first();
      if (await claimEntry.isVisible().catch(() => false)) {
        await claimEntry.click().catch(() => {});
        await sleep(4000);
      }
      uiReady = await waitForClaimUi(page, 60, 'spa-nav');
      console.log(`[load] spa-nav result: uiReady=${uiReady} url=${page.url()}`);
    }

    // v10：UI 始终不渲染且 API 连续 401 = 存储的会话令牌已失效（#793 实证：
    // /v5/users/infos、/v5/servers 等全部 401，页面永远停在 Loading）。
    // 这种情况继续等 Turnstile 毫无意义，立刻以明确原因失败，等 secrets 刷新。
    if (!uiReady && api401Count >= 3) {
      console.log(`[auth] claim UI never rendered and API returned 401 x${api401Count} — stored session token expired/invalid, secrets need a fresh login export`);
      await takeScreenshot(page, `attempt${attemptIndex}-session-expired`);
      return { ok: false, reason: 'session-expired-api-401' };
    }

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
    if (availability.remaining === null) {
      const sample = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260)).catch(() => '');
      console.log(`[claim] page text sample: ${sample}`);
    }

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
      return { ok: false, reason: 'button-disabled-verification-failed', invisibleChallenge: lastTurnstileInvisible };
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
  const geo = await detectEgressGeo();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: geo.timezone || 'America/New_York',
  });

  // 注意：本站有广告拦截墙——拦截广告请求会整页替换成 Ad Blocker 提示（#743 实证），
  // 因此绝不能在网络层拦广告；插页广告只能在页面内关闭/清扫（见 closeVignette）。

  // v18（2026-11-06）：只留 webdriver 隐藏，其他指纹补丁全删。
  // 本地 A/B 实测（同会话、同 hnhost 出口、同 bundled Chromium 158）：
  //   probeA（仅本行补丁，不动 DOM、不点击）→ 43 秒隐形通过，token 到手；
  //   probeB（probeA + 下面这批补丁）→ 43 秒时框翻成 300×65 互动模式，90 秒无 token。
  // window.chrome / languages / plugins / hardwareConcurrency / deviceMemory
  // 这些补丁就是把 CF 从隐形模式逼成互动模式的毒药——删掉，不要再加回来。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  console.log('[browser] fingerprint init script added');

  if (AXENT_LOCAL_STORAGE) {
    try {
      const storage = JSON.parse(unpackSecretValue(AXENT_LOCAL_STORAGE));
      await context.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) {
          // v22：auth 键只在缺失时注入。本轮内 OAuth 重登会把新鲜 auth 写进
          // 本源 localStorage，后续新页面若再用 secret 里的旧值覆盖，刚换的
          // 令牌立刻被打回过期状态。
          if (k === 'auth' && window.localStorage.getItem('auth')) continue;
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
      // v13: 注入侧同步过滤存量 CF cookie——当前 secret 里还存着旧逻辑回写的
      // cloudflare 域 cookie，不在注入侧拦掉的话，导出侧的修复要等一整轮才生效。
      const cfCookieName = /^(cf_clearance|__cf_bm|__cflb|__cfruid|cf_chl_|cf_ob_|cf_use_ob)/;
      const kept = parsed.filter((item) => {
        const host = (item.domain || '').replace(/^\./, '').toLowerCase();
        const isCfHost = host === 'cloudflare.com' || host.endsWith('.cloudflare.com');
        return !isCfHost && !cfCookieName.test(item.name || '');
      });
      const dropped = parsed.length - kept.length;
      if (dropped > 0) console.log(`[auth] dropped ${dropped} stored Cloudflare cookies at injection (v13)`);
      const cookies = kept.map((item) => ({
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
  const runStartedAt = Date.now();
  let claimedCount = 0;
  let failures = 0;
  let waitedShortCooldown = false;

  // v22：开跑前先看令牌余命。剩余 <90 分钟（或已过期/解析不出）且 Discord
  // 会话可用时，先 OAuth 重登换新令牌再领取——避免像 2026-11-08 22:00 那轮
  // 领到一半跨过到期点被 401 打断。Discord 未配置时完全跳过，行为同旧版。
  const discordConfigured = !!(DISCORD_COOKIES || DISCORD_LOCAL_STORAGE);
  if (discordConfigured) {
    const exp = storedAuthExpiresAt();
    const msLeft = exp ? exp - Date.now() : 0;
    console.log(`[relogin] stored token expiresAt=${exp ? new Date(exp).toISOString() : 'unknown'} (${Math.round(msLeft / 60000)} min left)`);
    if (!exp || msLeft < 90 * 60 * 1000) {
      console.log('[relogin] token expired or <90min left — attempting Discord OAuth relogin before claiming');
      reloginTried = true;
      const r = await reloginViaDiscord(context);
      console.log('[relogin] proactive relogin result:', JSON.stringify(r));
    } else {
      console.log('[relogin] token fresh enough, skipping proactive relogin');
    }
  }

  for (let attemptNo = 1; ; attemptNo++) {
    // v12: 预算检查前移到尝试开始之前。#838 实证：旧逻辑只在失败后查 22 分钟预算，
    // 第 4 次尝试在第 18 分钟启动、单次最长 ~6 分钟，叠加 job 前段 ~5 分钟开销后
    // 撞穿 30 分钟 job 上限被强杀，连 FINAL 都没打出来。预算 12 分钟 + 开始前检查，
    // 保证脚本永远在 job 上限内自己收尾。
    if (attemptNo > 1 && Date.now() - runStartedAt > 12 * 60 * 1000) {
      console.log('[run] time budget (12min) exhausted before new attempt, stopping cleanly');
      break;
    }
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
    // v11: 不可见挑战改为可重试（见下方 #809 实证说明）；401 过期仍立即停，
    // 因为换会话也救不了死令牌，必须等新导出。
    if (result.reason === 'session-expired-api-401') {
      // v22：Discord 会话可用且本轮还没试过重登时，先 OAuth 换新令牌再继续，
      // 救回这一整点轮；重登失败或未配置 Discord 时维持旧行为（停轮等处理）。
      if (discordConfigured && !reloginTried) {
        reloginTried = true;
        console.log('[relogin] 401 mid-run — attempting Discord OAuth relogin once');
        const r = await reloginViaDiscord(context);
        console.log('[relogin] mid-run relogin result:', JSON.stringify(r));
        if (r.ok) {
          failures = 0;
          result = { ok: false, reason: 'relogin-ok-retry' };
          await sleep(3000);
          continue;
        }
      }
      console.log('[run] stored session expired (API 401); retrying with the same secrets is pointless — needs a fresh login export');
      break;
    }
    if (result.invisibleChallenge) {
      // v11: 不再快速失败。#809 实证：同一轮里第 1 次领取点选后通过（175s）、
      // 第 2 次才撞上不可见挑战——不可见是按挑战实例随机的，换新会话/新页面
      // 重试有真实通过率。落入下方验证失败分支：重启浏览器换新会话再试，
      // 由 failures 上限和时间预算收口。
      console.log('[run] invisible challenge on this attempt; treating as retryable verification failure (fresh session, per #809 evidence)');
    }
    if (Date.now() - runStartedAt > 12 * 60 * 1000) {
      console.log('[run] time budget (12min) exhausted, stopping before job timeout');
      break;
    }
    if (failures >= MAX_ATTEMPTS) break;
    // 验证类失败说明当前会话已被风控标记，整浏览器重启换新会话再试，
    // 不要在同一个会话里反复撞墙
    if ((result.reason === 'button-disabled-verification-failed' || result.reason === 'unknown-result') && freshAuthJson) {
      // v22：本轮刚 OAuth 换过令牌时绝不重建上下文——重建会用 env 里的旧
      // auth 覆盖新令牌。同上下文稍等重试即可，收尾回写另有 freshAuthJson 兜底。
      console.log('[run] verification failed after relogin; keeping current context to protect the fresh token');
      await sleep(7000);
      continue;
    }
    if (result.reason === 'button-disabled-verification-failed' || result.reason === 'unknown-result') {
      console.log('[run] verification failed, relaunching browser with a fresh session...');
      await browser.close().catch(() => {});
      // v12: 重启前冷却 60s（旧 5s），避免同轮内高频连撞挑战继续喂高风控分
      await sleep(60000);
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
