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
const DISCORD_COOKIES = process.env.DISCORD_COOKIES || '';
const DISCORD_LOCAL_STORAGE = process.env.DISCORD_LOCAL_STORAGE || '';

let freshAuthJson = null;
let reloginTried = false;
const CLAIM_URL = 'https://app.axenthost.com/claim';
const MAX_ATTEMPTS = 2;
let lastTurnstileInvisible = false;

const SCREENSHOT_DIR = 'screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 按出口 IP 的真实地理位置对齐浏览器时区
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

// 关闭 Google 插页广告（vignette）
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
        await loc.click({ timeout: 2000, force: true }).catch(() => {});
        console.log(`[ads] vignette closed via ${sel}`);
        await sleep(500);
        return true;
      }
    } catch {}
  }
  try {
    const loc = page.locator('text=/^Close$/').first();
    if ((await loc.count().catch(() => 0)) > 0 && await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 2000, force: true }).catch(() => {});
      console.log('[ads] vignette closed via Close text');
      await sleep(500);
      return true;
    }
  } catch {}
  return false;
}

// 清除全屏广告层
async function sweepFullscreenAds(page) {
  try {
    return await page.evaluate(() => {
      let n = 0;
      const vw = window.innerWidth, vh = window.innerHeight;
      for (const el of Array.from(document.querySelectorAll('iframe, div, ins.adsbygoogle'))) {
        const r = el.getBoundingClientRect();
        const id = el.id || '';
        const src = el.tagName === 'IFRAME' ? (el.getAttribute('src') || '') : '';
        const isAd = id.includes('aswift') || id.includes('google_ads') || src.includes('google') || src.includes('doubleclick') || el.classList.contains('adsbygoogle');
        if (isAd && (r.width >= vw * 0.8 || r.height >= vh * 0.8 || id.includes('vignette'))) {
          el.remove();
          n++;
        }
      }
      document.body.style.overflow = 'auto';
      return n;
    }).catch(() => 0);
  } catch {
    return 0;
  }
}

// 模拟 ESC，强力粉碎包括 Google Vignette 全屏遮罩在内的所有广告阻碍
async function dismissAdModals(page) {
  try {
    if (page.url().includes('#google_vignette')) {
      console.log('[ads] detected #google_vignette overlay, sweeping and recovering...');
      await closeVignette(page);
      await sweepFullscreenAds(page);
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        if (window.location.hash.includes('google_vignette')) {
          history.replaceState(null, '', window.location.pathname);
        }
      }).catch(() => {});
      await sleep(1000);
    }
    await closeVignette(page);
    await page.keyboard.press('Escape');
    const closeBtn = page.locator('button:has-text("Close"), text=/^Close$/i, [aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true, timeout: 1500 }).catch(() => {});
    }
    await sweepFullscreenAds(page);
  } catch {}
}

// 定位可见的 Turnstile 组件外框
async function getTurnstileWidget(page) {
  for (const frame of page.frames()) {
    if (frame.url().includes('challenges.cloudflare.com')) {
      const frameEl = await frame.frameElement().catch(() => null);
      if (frameEl) {
        const box = await frameEl.boundingBox().catch(() => null);
        if (box && box.width >= 150 && box.width <= 400 && box.height >= 40 && box.height <= 120) {
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
      if (box && box.width >= 150 && box.width <= 400 && box.height >= 40 && box.height <= 120) {
        return { frameEl: iframe, box };
      }
    }
  }

  return null;
}

// 解析当前 secret 里 Axent 令牌的到期时刻（毫秒）
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

// 提取清洗后的 Discord Token 字符串
function getCleanDiscordToken() {
  if (!DISCORD_LOCAL_STORAGE) return '';
  try {
    const storage = JSON.parse(unpackSecretValue(DISCORD_LOCAL_STORAGE));
    const tok = storage.token || storage.tokens || '';
    return String(tok).replace(/\\"/g, '"').replace(/^"+|"+$/g, '').trim();
  } catch {
    return '';
  }
}

// 注入 Discord 会话（基础 initScript）
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

// 显式激活 Discord 网页会话（绕过未登录态）
async function activateDiscordSession(page, cleanToken) {
  if (!cleanToken) return false;
  console.log('[relogin] pre-warming Discord session at discord.com/login...');
  try {
    await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2500);

    // 借助同源隐藏 iframe 注入 Token 到 LocalStorage 和 IndexedDB
    await page.evaluate((tok) => {
      try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        iframe.contentWindow.localStorage.setItem('token', `"${tok}"`);

        // 同步尝试注入到 IndexedDB
        const req = indexedDB.open('discord');
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            db.createObjectStore('keyvaluepairs');
          }
        };
        req.onsuccess = (e) => {
          try {
            const db = e.target.result;
            const tx = db.transaction('keyvaluepairs', 'readwrite');
            tx.objectStore('keyvaluepairs').put(tok, 'token');
          } catch {}
        };
        iframe.remove();
      } catch {}
    }, cleanToken);

    // 刷新页面让 Discord 前端加载并识别 session
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3500);

    const currentUrl = page.url();
    console.log(`[relogin] discord session warmed, url: ${currentUrl}`);
    return !currentUrl.includes('/login');
  } catch (e) {
    console.log(`[relogin] discord pre-warm notice: ${e.message}`);
    return false;
  }
}

// 导出 Discord 会话
async function exportDiscordState(context) {
  try {
    const state = await context.storageState();
    const origin = (state.origins || []).find((o) => o.origin === 'https://discord.com');
    const items = origin?.localStorage || [];
    const keep = {};
    for (const i of items) {
      if (i.name === 'token' || i.name === 'tokens') keep[i.name] = i.value;
    }
    const cleanTok = getCleanDiscordToken();
    if (!keep['token'] && cleanTok) {
      keep['token'] = `"${cleanTok}"`;
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

    if (keep['token']) {
      fs.writeFileSync('fresh-discord-cookies.json', JSON.stringify(discordCookies));
      const packed = packSecretValue(JSON.stringify(keep));
      fs.writeFileSync('fresh-discord-localstorage.json', packed.value);
      console.log(`[relogin] discord session state saved (storage: ${packed.bytes} bytes, cookies: ${discordCookies.length})`);
      return true;
    }
  } catch (e) {
    console.error('[relogin] failed to export discord state:', e.message);
  }
  return false;
}

// 走 Discord OAuth 换新 24h 令牌
async function reloginViaDiscord(context) {
  const prevExp = storedAuthExpiresAt() || 0;
  const page = await context.newPage();
  try {
    await injectDiscordSession(context);

    // 关键修正：在访问 Axent 授权前先将 Discord 会话预热激活
    const cleanToken = getCleanDiscordToken();
    if (cleanToken) {
      await activateDiscordSession(page, cleanToken);
    }

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

// 导出凭据：加入防毒保护，未处于登录态时绝不生成文件并清理脏文件
async function exportFreshState(context, page) {
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

  if (!page.url().includes('/claim') || page.url().includes('#google_vignette')) {
    console.log('[nav] navigating directly to /claim...');
    await page.goto(CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    await dismissAdModals(page);
  }

  if (page.url().includes('/claim')) {
    for (let i = 0; i < 10; i++) {
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

// 校验 Turnstile 是否真正放行
async function checkTurnstilePassed(page) {
  try {
    const main = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"], input[name*="turnstile-response"]'));
      const hasToken = inputs.some((i) => i.value && i.value.length > 20);

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
        const extractText = (root) => {
          if (!root) return '';
          let str = '';
          for (const node of root.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) str += ' ' + node.textContent;
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.shadowRoot) str += ' ' + extractText(node.shadowRoot);
              str += ' ' + extractText(node);
            }
          }
          return str;
        };
        const t = extractText(document.body);
        return t.includes('Success') || t.includes('成功') || t.includes('Verified');
      }).catch(() => false);
      if (inFrame) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 检测 Turnstile 是否明确判定失败
async function checkTurnstileFailed(page) {
  try {
    const cfFrame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    if (!cfFrame) return false;
    return await cfFrame.evaluate(() => {
      const extractText = (root) => {
        if (!root) return '';
        let str = '';
        for (const node of root.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) str += ' ' + node.textContent;
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.shadowRoot) str += ' ' + extractText(node.shadowRoot);
            str += ' ' + extractText(node);
          }
        }
        return str;
      };
      const t = extractText(document.body);
      return /verification failed|验证失败|驗證失敗/i.test(t);
    }).catch(() => false);
  } catch {
    return false;
  }
}

// 诊断挑战 Frame 状态
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
        const txt = await frame.evaluate(() => {
          const extractText = (root) => {
            if (!root) return '';
            let str = '';
            for (const node of root.childNodes) {
              if (node.nodeType === Node.TEXT_NODE) str += ' ' + node.textContent;
              if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.shadowRoot) str += ' ' + extractText(node.shadowRoot);
                str += ' ' + extractText(node);
              }
            }
            return str;
          };
          return extractText(document.body).replace(/\s+/g, ' ').slice(0, 120);
        }).catch(() => null);
        console.log(`[frames:${tag}] box=${JSON.stringify(box)} style=${JSON.stringify(style)} text=${JSON.stringify(txt)}`);
      }
    }
  } catch (e) {
    console.log(`[frames:${tag}] dump failed: ${e.message}`);
  }
}

// 检查挑战组件是否已挂载到 DOM 中
async function checkChallengeRendered(page) {
  try {
    const fl = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
    const candidates = [
      fl.locator('label.cb-lb'),
      fl.locator('input[type="checkbox"]'),
      fl.locator('.ctp-checkbox-label'),
      fl.getByRole('checkbox'),
      fl.locator('label'),
      fl.locator('#challenge-stage')
    ];
    for (const target of candidates) {
      const count = await target.count().catch(() => 0);
      if (count > 0 && await target.first().isVisible().catch(() => false)) {
        return { rendered: true, target: target.first() };
      }
    }
  } catch {}

  const widget = await getTurnstileWidget(page);
  if (widget && widget.box) {
    return { rendered: true, target: null };
  }
  return { rendered: false, target: null };
}

// 帧内元素精准点击
async function tryInFrameClick(page) {
  const fl = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
  const candidates = [
    fl.locator('label.cb-lb'),
    fl.locator('input[type="checkbox"]'),
    fl.locator('.ctp-checkbox-label'),
    fl.getByRole('checkbox'),
    fl.locator('label'),
    fl.locator('#challenge-stage')
  ];

  for (const loc of candidates) {
    try {
      const first = loc.first();
      if ((await first.count().catch(() => 0)) > 0) {
        await first.scrollIntoViewIfNeeded().catch(() => {});
        const box = await first.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const cx = Math.round(box.x + Math.min(14, box.width / 4));
          const cy = Math.round(box.y + box.height / 2);
          await page.mouse.move(cx - 30, cy - 15, { steps: 6 });
          await sleep(100);
          await page.mouse.move(cx, cy, { steps: 8 });
          await sleep(150);
          await page.mouse.down();
          await sleep(80);
          await page.mouse.up();
          console.log(`[turnstile] native mouse click performed on element at cx=${cx} cy=${cy}`);
          await first.click({ timeout: 2000, force: true }).catch(() => {});
          return true;
        } else {
          await first.click({ timeout: 4000, force: true });
          console.log('[turnstile] in-frame element click performed');
          return true;
        }
      }
    } catch (e) {
      console.log(`[turnstile] in-frame click candidate failed: ${String(e.message).slice(0, 120)}`);
    }
  }

  const widget = await getTurnstileWidget(page);
  if (widget && widget.box) {
    const cx = Math.round(widget.box.x + 28);
    const cy = Math.round(widget.box.y + Math.min(32, widget.box.height / 2));
    await page.mouse.move(cx - 30, cy - 15, { steps: 6 });
    await sleep(100);
    await page.mouse.move(cx, cy, { steps: 8 });
    await sleep(150);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    console.log(`[turnstile] fallback widget coordinate click performed at cx=${cx} cy=${cy}`);
    return true;
  }

  return false;
}

// 读挑战 iframe 内部文本
async function challengeFrameText(page) {
  for (const frame of page.frames()) {
    if (frame.url().includes('challenges.cloudflare.com')) {
      const t = await frame.evaluate(() => {
        const extractText = (root) => {
          if (!root) return '';
          let str = '';
          for (const node of root.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) str += ' ' + node.textContent;
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.shadowRoot) str += ' ' + extractText(node.shadowRoot);
              str += ' ' + extractText(node);
            }
          }
          return str;
        };
        const res = extractText(document.body);
        return res.replace(/\s+/g, ' ').trim().slice(0, 140);
      }).catch(() => null);
      if (t && t.length > 0) return t;
    }
  }
  return null;
}

// Turnstile 求解核心
async function waitAndSolveTurnstile(page, attemptIndex) {
  lastTurnstileInvisible = false;
  console.log('[turnstile] waiting for verification (passive first)...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  for (let i = 0; i < 23; i++) {
    if (i % 5 === 0) await dismissAdModals(page);

    if (await checkTurnstilePassed(page)) {
      console.log(`[turnstile] passed passively (${waitedSec()}s)`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (await checkTurnstileFailed(page)) break;
    if (i % 4 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  const { rendered } = await checkChallengeRendered(page);
  const frameText = await challengeFrameText(page);

  if (rendered || frameText) {
    console.log(`[turnstile] widget element confirmed (${JSON.stringify((frameText || 'rendered').slice(0, 60))}), clicking checkbox...`);
    await dumpChallengeFrames(page, `a${attemptIndex}`);
    const clicked = await tryInFrameClick(page);
    if (clicked) {
      for (let i = 0; i < 20; i++) {
        if (await checkTurnstilePassed(page)) {
          console.log(`[turnstile] passed after click (${waitedSec()}s)`);
          await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
          return true;
        }
        if (await checkTurnstileFailed(page)) break;
        await sleep(2000);
      }
    } else {
      console.log('[turnstile] click dispatch returned false');
    }
  } else {
    lastTurnstileInvisible = true;
    console.log('[turnstile] challenge frame truly empty, clearing overlays and reloading once...');
    await dismissAdModals(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(3500);
    await dismissAdModals(page);
    for (let i = 0; i < 15; i++) {
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

// 拟人停留
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

// 等待领取页 UI 真实渲染
async function waitForClaimUi(page, timeoutSec, tag) {
  const start = Date.now();
  let poll = 0;
  while ((Date.now() - start) / 1000 < timeoutSec) {
    poll++;
    const st = await page.evaluate(() => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ');
      const hasClaimText = text.includes('Claim 3') || text.includes('claims per hour') || /\d+\s*\/\s*5\s*claims?/i.test(text);
      const hasClaimBtn = !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Claim 3 credits'));
      const hasWidget = document.querySelectorAll('.cf-turnstile, [data-sitekey]').length > 0;
      const hasCfFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      return {
        loading: text.includes('Loading...'),
        hasClaimBtn,
        hasClaimText,
        hasWidget,
        hasCfFrame,
        textLen: text.length,
      };
    }).catch(() => null);

    if (st && (st.hasClaimBtn || st.hasClaimText || st.hasWidget || st.hasCfFrame)) {
      console.log(`[load:${tag}] claim UI ready ${JSON.stringify(st)}`);
      return true;
    }
    if (st && poll % 4 === 1) console.log(`[load:${tag}] waiting UI ${JSON.stringify(st)}`);
    await sleep(3000);
  }
  console.log(`[load:${tag}] claim UI not ready after ${timeoutSec}s`);
  return false;
}

// 单次执行领取
async function claimOnce(context, attemptIndex) {
  const page = await context.newPage();
  let api401Count = 0;

  if (freshAuthJson) {
    await page.addInitScript((token) => {
      window.localStorage.setItem('auth', token);
    }, freshAuthJson).catch(() => {});
  }

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
    await page.goto('https://app.axenthost.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await humanDwell(page, 7000);
    await ensureOnClaimPage(page);
    await sleep(2000);
    await dismissAdModals(page);

    const diag = await page.evaluate(() => ({
      turnstileApi: typeof window.turnstile,
      widgetDivs: document.querySelectorAll('.cf-turnstile, [data-sitekey]').length,
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => (f.getAttribute('src') || f.id || '').slice(0, 60)),
    })).catch(() => null);
    if (diag) console.log(`[diag] turnstileApi=${diag.turnstileApi} widgetDivs=${diag.widgetDivs} iframes=${JSON.stringify(diag.iframes)}`);

    let uiReady = await waitForClaimUi(page, 35, 'direct');
    if (!uiReady) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await dismissAdModals(page);
      uiReady = await waitForClaimUi(page, 35, 'reload');
    }
    if (!uiReady) {
      console.log('[load] falling back to /servers then in-app navigation to claim...');
      await page.goto('https://app.axenthost.com/servers', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(4000);
      await dismissAdModals(page);
      const creditsBtn = page.locator('a[href*="credits"], a:has-text("Credits")').first();
      if (await creditsBtn.isVisible().catch(() => false)) {
        await creditsBtn.click().catch(() => {});
        await sleep(3500);
        await dismissAdModals(page);
      }
      const claimEntry = page.locator('button:has-text("Claim free credits"), a:has-text("Claim free credits")').first();
      if (await claimEntry.isVisible().catch(() => false)) {
        await claimEntry.click().catch(() => {});
        await sleep(3500);
        await dismissAdModals(page);
      }
      uiReady = await waitForClaimUi(page, 45, 'spa-nav');
      console.log(`[load] spa-nav result: uiReady=${uiReady} url=${page.url()}`);
    }

    if (!uiReady && api401Count >= 3) {
      console.log(`[auth] claim UI never rendered and API returned 401 x${api401Count} — stored session token expired/invalid`);
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

    await exportFreshState(context, page);

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

    // 等待按钮解锁
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

async function buildContext(browser) {
  const geo = await detectEgressGeo();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: geo.timezone || 'America/New_York',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  console.log('[browser] fingerprint init script added');

  if (AXENT_LOCAL_STORAGE) {
    try {
      const storage = JSON.parse(unpackSecretValue(AXENT_LOCAL_STORAGE));
      await context.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) {
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
      const cfCookieName = /^(cf_clearance|__cf_bm|__cflb|__cfruid|cf_chl_|cf_ob_|cf_use_ob)/;
      const kept = parsed.filter((item) => {
        const host = (item.domain || '').replace(/^\./, '').toLowerCase();
        const isCfHost = host === 'cloudflare.com' || host.endsWith('.cloudflare.com');
        return !isCfHost && !cfCookieName.test(item.name || '');
      });
      const dropped = parsed.length - kept.length;
      if (dropped > 0) console.log(`[auth] dropped ${dropped} stored Cloudflare cookies at injection`);
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

    const isSessionDead = result.reason === 'session-expired-api-401' || result.reason === 'cookies-expired-or-not-logged-in';
    if (isSessionDead) {
      if (discordConfigured && !reloginTried) {
        reloginTried = true;
        console.log(`[relogin] session dead (${result.reason}) — triggering Discord OAuth relogin immediately`);
        const r = await reloginViaDiscord(context);
        console.log('[relogin] mid-run relogin result:', JSON.stringify(r));
        if (r.ok) {
          failures = 0;
          result = { ok: false, reason: 'relogin-ok-retry' };
          await sleep(3000);
          continue;
        }
      }
      console.log(`[run] stored session expired (${result.reason}); Discord relogin unavailable/failed — stopping`);
      break;
    }

    if (result.invisibleChallenge) {
      console.log('[run] invisible challenge on this attempt; treating as retryable verification failure');
    }
    if (Date.now() - runStartedAt > 12 * 60 * 1000) {
      console.log('[run] time budget (12min) exhausted, stopping before job timeout');
      break;
    }
    if (failures >= MAX_ATTEMPTS) break;

    if ((result.reason === 'button-disabled-verification-failed' || result.reason === 'unknown-result') && freshAuthJson) {
      console.log('[run] verification failed after relogin; keeping current context to protect the fresh token');
      await sleep(7000);
      continue;
    }
    if (result.reason === 'button-disabled-verification-failed' || result.reason === 'unknown-result') {
      console.log('[run] verification failed, relaunching browser with a fresh session...');
      await browser.close().catch(() => {});
      await sleep(60000);
      browser = await launchBrowser();
      context = await buildContext(browser);
    } else {
      await sleep(7000);
    }
  }

  console.log(`[claim] total claimed this run: ${claimedCount}`);

  if (result.ok || freshAuthJson) {
    await exportFreshState(context, null).catch(() => {});
  } else {
    console.log('[auth] run failed without fresh auth, aborting final secret export to prevent poisoning');
    if (fs.existsSync('fresh-cookies.json')) fs.unlinkSync('fresh-cookies.json');
    if (fs.existsSync('fresh-localstorage.json')) fs.unlinkSync('fresh-localstorage.json');
  }

  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
