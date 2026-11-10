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
// v12（2026-11-06）：每轮失败尝试上限 2 次，轮与轮之间交给整点节奏重试。
const MAX_ATTEMPTS = 2;
// v7：记录挑战是否处于“不可见”状态。
let lastTurnstileInvisible = false;

const SCREENSHOT_DIR = 'screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// v8：按出口 IP 的真实地理位置对齐浏览器时区。
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

// 模拟 ESC，清理弹窗广告
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

// v22：解析当前 secret 里 Axent 令牌的到期时刻（毫秒）
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

// v22：把 Discord 会话注入上下文
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

// v22：导出 Discord 会话
async function exportDiscordState(context) {
  try {
    const state = await context.storageState();
    const origin = (state.origins || []).find((o) => o.origin === 'https://discord.com');
    const items = origin?.localStorage || [];
    if (!items.some((i) => (i.name === 'token' || i.name === 'tokens') && i.value)) return false;
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

// v22：走 Discord OAuth 换新 24h 令牌
async function reloginViaDiscord(context) {
  const prevExp = storedAuthExpiresAt() || 0;
  const page = await context.newPage();
  try {
    await injectDiscordSession(context);
    // v22.2：先以已登录态进站清掉旧 auth 并立标记，再进 /login。旧 auth 不清，
    // SPA 会把 /login 重定向回站内（#973 截图：落在 Servers 页、余额 0、Loading），
    // Discord 按钮永远不出现。标记只在重登页（本标签）生效，不影响后续领取页。
    await page.goto('https://app.axenthost.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    await page.evaluate(() => {
      try { window.sessionStorage.setItem('axent-relogin', '1'); } catch {}
      try { window.localStorage.removeItem('auth'); } catch {}
    }).catch(() => {});
    console.log('[relogin] cleared stored Axent auth for the login page');
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
          // v22.1（2026-11-09 晚）：账号身份校验。新令牌的账号必须与旧令牌一致，
          // 否则 DISCORD 会话若是另一个 Discord 号（如 slabykh.1982），重登会把
          // 主号的 secrets 覆盖成空号令牌，整点领取直接断供。身份不一致时拒绝
          // 换令牌、不回写，本轮继续用旧令牌领取，旧令牌在到期前仍有效。
          const idOf = (u) => (u ? (u.email || u.pseudo || u.username || null) : null);
          let oldId = null;
          try {
            const oldStorage = JSON.parse(unpackSecretValue(AXENT_LOCAL_STORAGE));
            oldId = idOf(oldStorage.auth ? JSON.parse(oldStorage.auth).user : null);
          } catch {}
          const newId = idOf(a?.user);
          if (oldId && newId && oldId !== newId) {
            console.log(`[relogin] ACCOUNT MISMATCH: new token user=${newId} != stored user=${oldId}; refusing to replace secrets`);
            await takeScreenshot(page, 'relogin-account-mismatch');
            return { ok: false, reason: 'relogin-account-mismatch', expected: oldId, got: newId };
          }
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

// 校验 Turnstile 是否真正放行（支持穿透 Shadow DOM 读取组件内成功提示）
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

// 检测 Turnstile 是否明确判定失败（穿透 Shadow DOM）
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

// 检查挑战组件是否已挂载到 DOM 中（穿透 Shadow DOM）
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

// 帧内元素精准点击（优先元素绝对位置，兜底组件物理坐标）
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

  // 备用：外框推算坐标点击
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

// 读挑战 iframe 内部文本（穿透 Shadow DOM）
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

// 关闭 Google 插页广告
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

// Turnstile 求解核心（修复 Shadow DOM 盲区与空组件死锁）
async function waitAndSolveTurnstile(page, attemptIndex) {
  lastTurnstileInvisible = false;
  console.log('[turnstile] waiting for verification (passive first)...');
  const startedAt = Date.now();
  const waitedSec = () => Math.round((Date.now() - startedAt) / 1000);

  // 阶段 1：被动等 token（最长等待 46 秒）
  for (let i = 0; i < 23; i++) {
    if (await checkTurnstilePassed(page)) {
      console.log(`[turnstile] passed passively (${waitedSec()}s)`);
      await takeScreenshot(page, `attempt${attemptIndex}-turnstile-passed`);
      return true;
    }
    if (await checkTurnstileFailed(page)) break;
    if (i % 4 === 0) console.log(`[turnstile] securing waited ${waitedSec()}s`);
    await sleep(2000);
  }

  // 阶段 2：直接探查复选框组件（穿透 Shadow DOM，废除脆弱的空文本拦截）
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
    // 只有在 iframe 与容器确实皆未渲染时才触发 reload
    lastTurnstileInvisible = true;
    console.log('[turnstile] challenge frame truly empty, reloading once...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(3500);
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

// 等待领取页 UI 真实渲染（优化超时，避免在卡死的骨架屏上等待耗满）
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
    if (st && poll % 4 === 1) console.log(`[load:${tag}] waiting UI ${JSON.stringify(st)}`);
    await sleep(4000);
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

    // UI 就绪性判断（由 90s 精简为 35s，避免卡死空耗预算）
    let uiReady = await waitForClaimUi(page, 35, 'direct');
    if (!uiReady) {
      const resTail = await page.evaluate(() => performance.getEntriesByType('resource').slice(-25).map((e) => `${e.name.slice(0, 80)} dur=${Math.round(e.duration)} end=${Math.round(e.responseEnd)}`)).catch(() => []);
      console.log(`[load] resource timing tail: ${JSON.stringify(resTail)}`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await dismissAdModals(page);
      uiReady = await waitForClaimUi(page, 35, 'reload');
    }
    if (!uiReady) {
      console.log('[load] falling back to /servers then in-app navigation to claim...');
      await page.goto('https://app.axenthost.com/servers', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(4000);
      const creditsBtn = page.locator('a[href*="credits"], a:has-text("Credits")').first();
      if (await creditsBtn.isVisible().catch(() => false)) {
        await creditsBtn.click().catch(() => {});
        await sleep(3500);
      }
      const claimEntry = page.locator('button:has-text("Claim free credits"), a:has-text("Claim free credits")').first();
      if (await claimEntry.isVisible().catch(() => false)) {
        await claimEntry.click().catch(() => {});
        await sleep(3500);
      }
      uiReady = await waitForClaimUi(page, 45, 'spa-nav');
      console.log(`[load] spa-nav result: uiReady=${uiReady} url=${page.url()}`);
    }

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
          // v22.2：重登页用 sessionStorage 标记跳过注入，否则 /login 会因旧 auth
          // 被 SPA 重定向回站内，Discord 按钮永远不出现（#973 截图实证）。
          if (k === 'auth') {
            try { if (window.sessionStorage.getItem('axent-relogin')) continue; } catch {}
          }
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
      console.log(`[relogin] token fresh enough, skipping proactive relogin (will trigger after ${new Date(exp - 90 * 60 * 1000).toISOString()})`);
    }
  } else {
    const exp = storedAuthExpiresAt();
    console.log(`[relogin] DISCORD_* secrets not configured — auto relogin disarmed (v21 behaviour); stored token expiresAt=${exp ? new Date(exp).toISOString() : 'unknown'}`);
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
    if (result.reason === 'session-expired-api-401') {
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

  await exportFreshState(context, null).catch(() => {});
  await browser.close();
  console.log('FINAL:', JSON.stringify(result));

  if (!result.ok && result.reason !== 'cooldown-or-already-claimed') {
    process.exitCode = 1;
  }
})();
