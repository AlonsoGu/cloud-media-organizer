import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_CHROME_CANDIDATES = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Google\\Chrome\\Application\\chrome.exe'
  ),
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

export function findChromeExecutable() {
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('未在本机标准路径找到 Google Chrome 可执行文件 (chrome.exe)');
}

const ALLOWED_INITIAL_URL_HOSTS = new Set([
  '115.com',
  'pan.baidu.com',
  'yun.baidu.com',
  'pan.quark.cn',
  'drive.quark.cn',
  'themoviedb.org',
  'www.themoviedb.org',
]);

export function validateCdpPort(portInput = 9222) {
  const port = Number(portInput);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`非法的 CDP 端口号 "${portInput}"，仅允许 1024~65535 范围内的整数`);
  }
  return port;
}

export function validateChromeInitialUrls(initialUrls = []) {
  if (!Array.isArray(initialUrls)) {
    throw new Error('initialUrls 必须为数组');
  }
  const validated = [];
  for (const raw of initialUrls) {
    const str = String(raw || '').trim();
    if (!str) continue;
    if (/[\r\n\0]/.test(str)) {
      throw new Error('初始 URL 包含非法控制字符');
    }
    let parsed;
    try {
      parsed = new URL(str);
    } catch {
      throw new Error(`非法的初始 URL: "${str}"`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`仅允许 https 协议初始 URL，已拦截: "${str}"`);
    }
    const host = parsed.hostname.toLowerCase();
    const isAllowed =
      ALLOWED_INITIAL_URL_HOSTS.has(host) || host.endsWith('.115.com');
    if (!isAllowed) {
      throw new Error(`初始 URL 主机名 "${host}" 不在白名单内，已拦截`);
    }
    validated.push(parsed.toString());
  }
  return validated;
}

export function buildWindowsStartChromeScript(chromeExe, args = []) {
  const quotePs = (val) => `'${String(val).replace(/'/g, "''")}'`;
  const argLiterals = args.map((a) => quotePs(a)).join(', ');
  return `Start-Process -FilePath ${quotePs(chromeExe)} -ArgumentList @(${argLiterals})`;
}

export async function checkCdpAlive(port = 9222) {
  const safePort = validateCdpPort(port);
  try {
    const res = await fetch(`http://127.0.0.1:${safePort}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 确保调试模式 Chrome 独立常驻运行：
 * 1. 适配 Chrome 136+ 强制自定义 --user-data-dir 安全限制；
 * 2. 在 Windows 下优先通过 schtasks.exe (/it 交互模式) 配合 PowerShell -EncodedCommand
 *    在用户真实可见桌面 (WinSta0\Default) 创建独立进程，避免动态拼接 .bat 引发命令注入与残留，
 *    同时防止 Agent 单次命令结束时连带回收浏览器导致登录态中断。
 */
export async function ensureDebugChrome({
  port = 9222,
  profileDir,
  initialUrls = ['https://115.com/'],
} = {}) {
  const safePort = validateCdpPort(port);
  const safeUrls = validateChromeInitialUrls(initialUrls);

  const existing = await checkCdpAlive(safePort);
  if (existing) {
    return { port: safePort, browser: existing.Browser, newlyLaunched: false };
  }

  const chromeExe = findChromeExecutable();
  fs.mkdirSync(profileDir, { recursive: true });
  // 清理历史版本遗留的临时批处理脚本
  fs.rmSync(path.join(profileDir, 'launch-chrome.bat'), { force: true });

  const args = [
    `--remote-debugging-port=${safePort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...safeUrls,
  ];

  let taskName = null;
  let launchedViaTask = false;
  if (process.platform === 'win32') {
    try {
      const psScript = buildWindowsStartChromeScript(chromeExe, args);
      const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
      taskName = `AGY_Chrome_${safePort}`;
      execFileSync(
        'schtasks.exe',
        [
          '/create',
          '/tn',
          taskName,
          '/tr',
          `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedCmd}`,
          '/sc',
          'once',
          '/st',
          '00:00',
          '/it',
          '/f',
        ],
        { stdio: 'ignore' }
      );
      execFileSync('schtasks.exe', ['/run', '/tn', taskName], { stdio: 'ignore' });
      launchedViaTask = true;
    } catch {
      launchedViaTask = false;
    }
  }

  try {
    if (!launchedViaTask) {
      const child = spawn(chromeExe, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }

    for (let i = 0; i < 30; i += 1) {
      await sleep(500);
      const info = await checkCdpAlive(safePort);
      if (info) {
        return { port: safePort, browser: info.Browser, newlyLaunched: true };
      }
    }
  } finally {
    if (taskName) {
      try {
        execFileSync('schtasks.exe', ['/delete', '/tn', taskName, '/f'], { stdio: 'ignore' });
      } catch {}
    }
  }

  throw new Error(`启动调试 Chrome 超时，端口 127.0.0.1:${safePort} 未就绪`);
}

export async function listCdpTargets(port = 9222) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`无法读取 CDP 标签页列表: HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * 轻量级单标签页 CDP 会话封装（基于 Node 22 原生 WebSocket）
 */
export class CdpPageSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`连接 CDP WebSocket 超时: ${this.wsUrl}`));
      }, 5000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 错误: ${err?.message || '连接失败'}`));
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: resFn, reject: rejFn, timeout } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(timeout);
            if (msg.error) {
              rejFn(new Error(`CDP 调用失败 [${msg.error.code}]: ${msg.error.message}`));
            } else {
              resFn(msg.result);
            }
          }
        } catch {
          // 忽略非预期帧
        }
      });

      ws.addEventListener('close', () => {
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timeout);
          entry.reject(new Error('CDP WebSocket 连接已关闭'));
        }
        this.pending.clear();
        this.ws = null;
      });
    });
  }

  async send(method, params = {}, timeoutMs = 30000) {
    await this.connect();
    const id = ++this.seq;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时 (${method})`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 30000) {
    const res = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs
    );

    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        '页面内脚本执行异常';
      throw new Error(desc);
    }

    return res.result?.value;
  }

  async close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const DRIVE_PROVIDERS = {
  '115': {
    id: '115',
    label: '115网盘',
    homeUrl: 'https://115.com/',
    matchHost: (hostname) =>
      (hostname === '115.com' || hostname.endsWith('.115.com')) &&
      !hostname.startsWith('passport') &&
      !hostname.startsWith('qrcodeapi'),
    preferActiveUrl: (url) => /[?&]cid=[1-9]\d*/.test(url),
  },
  baidu: {
    id: 'baidu',
    label: '百度网盘',
    homeUrl: 'https://pan.baidu.com/disk/main',
    matchHost: (hostname) => hostname === 'pan.baidu.com' || hostname === 'yun.baidu.com',
    preferActiveUrl: (url) => /path=/.test(url) || /\/disk\/(?:main|home)/i.test(url),
  },
  quark: {
    id: 'quark',
    label: '夸克网盘',
    homeUrl: 'https://pan.quark.cn/',
    matchHost: (hostname) => hostname === 'pan.quark.cn' || hostname === 'drive.quark.cn',
    preferActiveUrl: (url) => /#\/list\/all\//i.test(url),
  },
};

export function normalizeDriveType(input = 'auto') {
  const s = String(input || 'auto').trim().toLowerCase();
  if (!s || s === 'auto') return 'auto';
  if (s === '115' || s === '115pan' || s === '115网盘') return '115';
  if (s === 'baidu' || s === 'bd' || s === 'pan.baidu' || s === '百度' || s === '百度网盘') return 'baidu';
  if (s === 'quark' || s === 'qk' || s === '夸克' || s === '夸克网盘') return 'quark';
  throw new Error(`不支持的网盘类型 "${input}"，可选值: auto | 115 | baidu | quark`);
}

export class CdpManager {
  constructor(port = 9222) {
    this.port = port;
    this._tmdbTab = null;
    this._tmdbSession = null;
    this._createdTempTmdbTab = false;
  }

  /**
   * 自动根据指定网盘类型（或 auto 自动探测当前已打开的网盘标签页）定位或新建标签页
   */
  async findOrOpenDriveTab(driveType = 'auto') {
    const norm = normalizeDriveType(driveType);
    if (norm === 'auto') {
      const detected = await this.detectActiveDriveTab();
      if (detected) return detected;
      // 默认兜底打开 115 网盘
      const tab = await this.findOrOpenSingleDriveTab('115');
      return { driveType: '115', provider: DRIVE_PROVIDERS['115'], tab };
    }

    const tab = await this.findOrOpenSingleDriveTab(norm);
    return { driveType: norm, provider: DRIVE_PROVIDERS[norm], tab };
  }

  async detectActiveDriveTab() {
    const targets = await listCdpTargets(this.port);
    const pages = targets.filter((t) => t.type === 'page');

    // 优先匹配带有明确非根路径/活跃目录特征的网盘标签页
    for (const [key, provider] of Object.entries(DRIVE_PROVIDERS)) {
      const matched = pages.filter((t) => {
        try {
          const u = new URL(t.url);
          return provider.matchHost(u.hostname);
        } catch {
          return false;
        }
      });
      const active = matched.find((t) => provider.preferActiveUrl(t.url));
      if (active) {
        return { driveType: key, provider, tab: active };
      }
    }

    // 其次匹配任意已打开的网盘主站标签页
    for (const [key, provider] of Object.entries(DRIVE_PROVIDERS)) {
      const matched = pages.find((t) => {
        try {
          const u = new URL(t.url);
          return provider.matchHost(u.hostname);
        } catch {
          return false;
        }
      });
      if (matched) {
        return { driveType: key, provider, tab: matched };
      }
    }

    return null;
  }

  async findDriveTab(driveType = '115') {
    const norm = normalizeDriveType(driveType);
    const provider = DRIVE_PROVIDERS[norm] || DRIVE_PROVIDERS['115'];
    const targets = await listCdpTargets(this.port);
    const candidates = targets.filter((t) => {
      if (t.type !== 'page') return false;
      try {
        const u = new URL(t.url);
        return provider.matchHost(u.hostname);
      } catch {
        return false;
      }
    });

    if (candidates.length === 0) {
      return null;
    }

    const preferred = candidates.find((t) => provider.preferActiveUrl(t.url));
    return preferred || candidates[0];
  }

  async findOrOpenSingleDriveTab(driveType = '115') {
    const norm = normalizeDriveType(driveType);
    const provider = DRIVE_PROVIDERS[norm] || DRIVE_PROVIDERS['115'];
    let tab = await this.findDriveTab(norm);
    if (!tab) {
      const res = await fetch(
        `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(provider.homeUrl)}`,
        { method: 'PUT' }
      );
      if (!res.ok) {
        throw new Error(`无法通过 CDP 新建 ${provider.label} 标签页: HTTP ${res.status}`);
      }
      tab = await res.json();
      await sleep(2500);
    }
    return tab;
  }

  async findOrOpen115Tab() {
    return await this.findOrOpenSingleDriveTab('115');
  }

  /**
   * 定位已打开的 115 网盘主页面标签页
   */
  async find115Tab() {
    return await this.findDriveTab('115');
  }

  /**
   * 获取或复用常驻的 TMDB 浏览器会话（开启大文件/分析脚本屏蔽）
   */
  async getOrCreateTmdbSession() {
    if (this._tmdbSession && this._tmdbSession.ws) {
      return this._tmdbSession;
    }
    const targets = await listCdpTargets(this.port);
    let tab = targets.find((t) => t.type === 'page' && t.url.includes('themoviedb.org'));
    let isNew = false;
    if (!tab) {
      const res = await fetch(
        `http://127.0.0.1:${this.port}/json/new?https://www.themoviedb.org/`,
        { method: 'PUT' }
      );
      if (!res.ok) {
        throw new Error(`无法通过 CDP 打开 TMDB 标签页: HTTP ${res.status}`);
      }
      tab = await res.json();
      isNew = true;
      await sleep(1000);
    }
    this._tmdbTab = tab;
    this._createdTempTmdbTab = isNew;

    const session = new CdpPageSession(tab.webSocketDebuggerUrl);
    await session.connect();
    try {
      await session.send('Network.enable').catch(() => {});
      await session.send('Network.setBlockedURLs', {
        urls: [
          '*.png',
          '*.jpg',
          '*.jpeg',
          '*.gif',
          '*.webp',
          '*.woff*',
          '*.ttf',
          '*googletagmanager*',
          '*google-analytics*',
          '*sentry*',
        ],
      }).catch(() => {});
    } catch {}

    this._tmdbSession = session;
    return session;
  }

  /**
   * 当直连 TMDB 被 WAF / Challenge 拦截时，通过真实 Chrome 标签页快速提取 HTML：
   * 1. 优先通过常驻 TMDB 标签页的同源 window.fetch 快速读取（耗时仅 200~400ms，免 DOM 渲染与资源下载）；
   * 2. 若同源 fetch 返回异常则自动降级为真实标签页导航并等待目标选择器渲染。
   */
  async fetchHtmlViaBrowserTab(targetUrl, optionsOrTvId = {}) {
    const opts =
      typeof optionsOrTvId === 'object' && optionsOrTvId !== null
        ? optionsOrTvId
        : {
            urlMatch: optionsOrTvId ? `themoviedb.org/tv/${optionsOrTvId}/seasons` : targetUrl,
            readySelector: '.season_wrapper',
          };
    const readySelector = opts.readySelector || '.season_wrapper';

    // 优先：通过常驻 TMDB 标签页内的 window.fetch 快速拉取（同源自动附带 Cookies / Challenge token，免解析渲染）
    try {
      const session = await this.getOrCreateTmdbSession();
      const html = await session.evaluate(
        `(async () => {
          try {
            const resp = await window.fetch(${JSON.stringify(targetUrl)}, { credentials: 'include' });
            if (resp.ok) return await resp.text();
            return null;
          } catch {
            return null;
          }
        })()`,
        15000
      );

      if (html && html.length > 500) {
        return html;
      }
    } catch {
      if (this._tmdbSession) {
        await this._tmdbSession.close().catch(() => {});
        this._tmdbSession = null;
      }
    }

    // 降级兜底：标签页导航并等待目标元素 DOM 就绪
    const session = await this.getOrCreateTmdbSession();
    await session.send('Page.navigate', { url: targetUrl });
    const selectorLiteral = JSON.stringify(readySelector);
    for (let i = 0; i < 30; i += 1) {
      const readyHtml = await session.evaluate(`(() => {
        const el = document.querySelector(${selectorLiteral});
        return el ? document.documentElement.outerHTML : null;
      })()`);
      if (readyHtml) {
        return readyHtml;
      }
      await sleep(500);
    }
    throw new Error(`等待浏览器渲染 TMDB 页面元素 (${readySelector}) 超时`);
  }

  /**
   * 关闭释放临时 TMDB 会话与标签页
   */
  async close() {
    if (this._tmdbSession) {
      await this._tmdbSession.close().catch(() => {});
      this._tmdbSession = null;
    }
    if (this._createdTempTmdbTab && this._tmdbTab?.id) {
      await fetch(`http://127.0.0.1:${this.port}/json/close/${this._tmdbTab.id}`).catch(() => {});
      this._tmdbTab = null;
      this._createdTempTmdbTab = false;
    }
  }
}
