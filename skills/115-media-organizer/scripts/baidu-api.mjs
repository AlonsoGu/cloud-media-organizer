import { setTimeout as sleep } from 'node:timers/promises';
import { BaseCloudDriveBridge, randomDelayMs } from './drive-base.mjs';

export function normalizeBaiduPath(rawPath = '/') {
  const cleaned = String(rawPath || '/')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/?(?:根目录|全部文件)(?:\/|$)/, '/')
    .replace(/\/+/g, '/');
  if (!cleaned || cleaned === '/') return '/';
  const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return withLead.endsWith('/') ? withLead.slice(0, -1) : withLead;
}

export function splitBaiduParentAndName(fullPath = '/') {
  const norm = normalizeBaiduPath(fullPath);
  if (norm === '/') {
    return { parentPath: '/', name: '' };
  }
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) {
    return { parentPath: '/', name: norm.slice(1) };
  }
  return {
    parentPath: norm.slice(0, idx),
    name: norm.slice(idx + 1),
  };
}

export function joinBaiduPath(parentPath = '/', childName = '') {
  const normParent = normalizeBaiduPath(parentPath);
  const cleanChild = String(childName || '').replace(/^[\/\\]+|[\/\\]+$/g, '');
  if (!cleanChild) return normParent;
  return normParent === '/' ? `/${cleanChild}` : `${normParent}/${cleanChild}`;
}

/**
 * 百度网盘 (pan.baidu.com) WebAPI 浏览器原位桥接层
 * 所有请求均在已登录的 pan.baidu.com 标签页沙箱内通过 credentials: 'include' 原位发送，
 * 严守零凭证泄露安全底线：绝不读取、导出、打印或落盘任何 BDUSS / STOKEN / Cookie。
 */
export class BaiduDriveBridge extends BaseCloudDriveBridge {
  constructor(pageSession) {
    super(pageSession, { driveType: 'baidu', driveLabel: '百度网盘' });
    this._cachedBdstoken = null;
    this._recentDirCache = new Map();
  }

  getRootDirId() {
    return '/';
  }

  /**
   * 在浏览器沙箱内获取页面上下文的 bdstoken（仅用于原位接口校验参数，绝不打印或外传）
   */
  async _ensureBdstoken() {
    if (this._cachedBdstoken) return this._cachedBdstoken;
    const token = await this.session.evaluate(`(async () => {
      try {
        if (window.locals) {
          if (typeof window.locals.get === 'function') {
            const t = window.locals.get('bdstoken');
            if (t) return String(t);
          }
          if (window.locals.bdstoken) return String(window.locals.bdstoken);
          if (window.locals.userInfo && window.locals.userInfo.bdstoken) {
            return String(window.locals.userInfo.bdstoken);
          }
        }
        if (window.yunData && (window.yunData.MYBDSTOKEN || window.yunData.bdstoken)) {
          return String(window.yunData.MYBDSTOKEN || window.yunData.bdstoken);
        }
      } catch {}

      try {
        const resp = await fetch(
          '/api/gettemplatevariable?fields=%5B%22bdstoken%22%5D&channel=chunlei&web=1&app_id=250528&clienttype=0',
          { credentials: 'include' }
        );
        const json = await resp.json();
        if (json && Number(json.errno) === 0 && json.result && json.result.bdstoken) {
          return String(json.result.bdstoken);
        }
      } catch {}
      return '';
    })()`);

    this._cachedBdstoken = token || '';
    return this._cachedBdstoken;
  }

  /**
   * 自动探测当前用户在百度网盘页面中打开的文件夹路径
   * 兼容新版 #/index?category=all&path=%2F... 与旧版 #list/path=%2F...
   */
  async detectActiveCid() {
    const info = await this.session.evaluate(`(() => {
      const hash = String(window.location.hash || '');
      const search = String(window.location.search || '');
      const combined = hash + '&' + search;

      const m = combined.match(/[?&#/]path=([^&#]+)/);
      if (m && m[1]) {
        try {
          const decoded = decodeURIComponent(m[1]).trim();
          if (decoded && decoded !== '/') {
            return { cid: decoded, source: 'url_path' };
          }
          return { cid: null, source: 'root' };
        } catch {}
      }
      return { cid: null, source: 'none' };
    })()`);

    if (info?.cid) {
      return {
        cid: normalizeBaiduPath(info.cid),
        source: info.source,
      };
    }
    return { cid: null, source: info?.source || 'none' };
  }

  _buildFolderPathSegments(dirPath) {
    const norm = normalizeBaiduPath(dirPath);
    const breadcrumb = [{ name: '全部文件', cid: '/' }];
    if (norm === '/') return breadcrumb;
    const parts = norm.split('/').filter(Boolean);
    let accum = '';
    for (const seg of parts) {
      accum = `${accum}/${seg}`;
      breadcrumb.push({ name: seg, cid: accum });
    }
    return breadcrumb;
  }

  /**
   * 分页拉取指定目录路径下的全部直接子项（文件 + 子文件夹）
   * 注意：百度网盘以完整路径作为文件/目录的操作主键 (id = item.path, parentId = dirPath)
   */
  async listDirectChildren(dirPath) {
    const targetDir = normalizeBaiduPath(dirPath || '/');
    const cached = this._recentDirCache.get(targetDir);
    if (cached && Date.now() - cached.ts < 2500) {
      this._recentDirCache.delete(targetDir);
      return cached.data;
    }
    const bdstoken = await this._ensureBdstoken();
    const pageSize = 1000;
    let page = 1;
    const items = [];

    while (true) {
      const res = await this.session.evaluate(
        `(async () => {
          const dir = ${JSON.stringify(targetDir)};
          const page = ${Number(page)};
          const num = ${Number(pageSize)};
          const bdstoken = ${JSON.stringify(bdstoken)};
          const url =
            '/api/list?dir=' +
            encodeURIComponent(dir) +
            '&order=name&desc=0&num=' +
            num +
            '&page=' +
            page +
            '&showempty=1&web=1&channel=chunlei&clienttype=0&app_id=250528' +
            (bdstoken ? '&bdstoken=' + encodeURIComponent(bdstoken) : '');
          const resp = await fetch(url, { credentials: 'include' });
          const text = await resp.text();
          try {
            return JSON.parse(text);
          } catch {
            return { errno: -999, errmsg: '百度网盘响应非 JSON，请确认已在浏览器登录 pan.baidu.com' };
          }
        })()`
      );

      const errno = Number(res?.errno ?? -1);
      if (errno !== 0) {
        const msg =
          errno === -6
            ? '百度网盘尚未登录或登录态已过期，请在浏览器中登录 pan.baidu.com'
            : errno === -9
              ? `目录不存在: "${targetDir}"`
              : res?.errmsg || res?.show_msg || '未知错误';
        throw new Error(`读取百度网盘目录 (${targetDir}) 失败 [errno=${errno}]: ${msg}`);
      }

      const list = Array.isArray(res?.list) ? res.list : [];
      for (const d of list) {
        const isDir = Number(d.isdir) === 1;
        const itemPath = normalizeBaiduPath(
          d.path || joinBaiduPath(targetDir, d.server_filename || '')
        );
        const itemName = String(d.server_filename || splitBaiduParentAndName(itemPath).name);
        items.push({
          isFile: !isDir,
          id: itemPath,
          fsId: String(d.fs_id || ''),
          parentId: targetDir,
          path: itemPath,
          pickCode: '',
          name: itemName,
          ico: isDir ? 'folder' : '',
          size: Number(d.size || 0),
        });
      }

      if (list.length < pageSize) {
        break;
      }
      page += 1;
      await sleep(80);
    }

    const folderPath = this._buildFolderPathSegments(targetDir);
    return {
      cid: targetDir,
      folderPath,
      fullPathText: folderPath.map((p) => p.name).join(' / '),
      folders: items.filter((x) => !x.isFile),
      files: items.filter((x) => x.isFile),
    };
  }

  /**
   * 百度网盘路径解析：优先尝试直接按完整路径读取，若存在大小写或全半角括号差异则自动回退逐级模糊匹配
   */
  async resolvePathToCid(pathInput) {
    const norm = normalizeBaiduPath(pathInput);
    if (norm === '/') {
      throw new Error(`无效的百度网盘目标路径 "${pathInput}"（严禁直接指定根目录）`);
    }
    try {
      const check = await this.listDirectChildren(norm);
      this._recentDirCache.set(norm, { ts: Date.now(), data: check });
      const { name } = splitBaiduParentAndName(norm);
      return {
        cid: norm,
        name: name || norm,
        fullPathText: check.fullPathText,
      };
    } catch {
      return await super.resolvePathToCid(pathInput);
    }
  }

  /**
   * 按关键词搜索百度网盘内的相关文件夹路径
   */
  async searchFolders(keyword) {
    const bdstoken = await this._ensureBdstoken();
    const res = await this.session.evaluate(
      `(async () => {
        const kw = ${JSON.stringify(String(keyword))};
        const bdstoken = ${JSON.stringify(bdstoken)};
        const url =
          '/api/search?key=' +
          encodeURIComponent(kw) +
          '&recursion=1&order=time&desc=1&num=100&page=1&web=1&channel=chunlei&clienttype=0&app_id=250528' +
          (bdstoken ? '&bdstoken=' + encodeURIComponent(bdstoken) : '');
        const resp = await fetch(url, { credentials: 'include' });
        return await resp.json();
      })()`
    );

    if (Number(res?.errno) !== 0) {
      throw new Error(`百度网盘搜索失败 [errno=${res?.errno}]: ${res?.errmsg || '请确认已登录'}`);
    }

    const candidateDirs = new Set();
    for (const d of res.list || []) {
      const p = normalizeBaiduPath(d.path || '');
      if (!p || p === '/') continue;
      if (Number(d.isdir) === 1) {
        candidateDirs.add(p);
      } else {
        const { parentPath } = splitBaiduParentAndName(p);
        if (parentPath && parentPath !== '/') candidateDirs.add(parentPath);
      }
    }

    const topDirs = [...candidateDirs].slice(0, 12);
    const results = [];
    const concurrency = 4;
    for (let i = 0; i < topDirs.length; i += concurrency) {
      const batch = topDirs.slice(i, i + concurrency);
      const batchRes = await Promise.all(
        batch.map(async (dirPath) => {
          try {
            const listing = await this.listDirectChildren(dirPath);
            return {
              cid: dirPath,
              fullPath: listing.fullPathText,
              totalItems: listing.files.length + listing.folders.length,
              sampleItem: listing.files[0]?.name || listing.folders[0]?.name || '',
            };
          } catch {
            return null;
          }
        })
      );
      for (const r of batchRes) {
        if (r) results.push(r);
      }
    }
    return results;
  }

  /**
   * 幂等在指定父目录下创建或复用单个子文件夹
   */
  async ensureFolder(parentPath, folderName) {
    const normParent = normalizeBaiduPath(parentPath || '/');
    const targetPath = joinBaiduPath(normParent, folderName);

    const createRes = await this._createFolderRaw(targetPath);
    if (Number(createRes?.errno) === 0) {
      const actualPath = normalizeBaiduPath(createRes.path || targetPath);
      return {
        cid: actualPath,
        created: true,
      };
    }

    // 若报目录已存在 (errno=-8 等)，读取父目录匹配现有文件夹
    const refreshed = await this.listDirectChildren(normParent);
    const key = String(folderName).trim().toLowerCase();
    const found = refreshed.folders.find((f) => f.name.trim().toLowerCase() === key);
    if (found) {
      return { cid: found.id, created: false };
    }

    throw new Error(
      `百度网盘创建目录 "${targetPath}" 失败 [errno=${createRes?.errno}]: ${
        createRes?.errmsg || '未知错误'
      }`
    );
  }

  async _createFolderRaw(targetPath) {
    const bdstoken = await this._ensureBdstoken();
    return await this.session.evaluate(
      `(async () => {
        const targetPath = ${JSON.stringify(targetPath)};
        const bdstoken = ${JSON.stringify(bdstoken)};
        const body = new URLSearchParams();
        body.set('path', targetPath);
        body.set('isdir', '1');
        body.set('block_list', '[]');
        body.set('rtype', '0');

        const url =
          '/api/create?a=commit&channel=chunlei&web=1&app_id=250528&clienttype=0' +
          (bdstoken ? '&bdstoken=' + encodeURIComponent(bdstoken) : '');
        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString(),
        });
        return await resp.json();
      })()`
    );
  }

  /**
   * 调用百度网盘 /api/filemanager (rename / move / delete)，并自动轮询异步 taskid
   */
  async _executeFileManager(opera, filelist, { ondup = 'fail' } = {}) {
    const bdstoken = await this._ensureBdstoken();
    const res = await this.session.evaluate(
      `(async () => {
        const opera = ${JSON.stringify(opera)};
        const filelist = ${JSON.stringify(filelist)};
        const ondup = ${JSON.stringify(ondup)};
        const bdstoken = ${JSON.stringify(bdstoken)};

        const body = new URLSearchParams();
        body.set('filelist', JSON.stringify(filelist));

        const url =
          '/api/filemanager?opera=' +
          encodeURIComponent(opera) +
          '&async=2&onnest=fail&ondup=' +
          encodeURIComponent(ondup) +
          '&channel=chunlei&web=1&app_id=250528&clienttype=0' +
          (bdstoken ? '&bdstoken=' + encodeURIComponent(bdstoken) : '');
        const resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString(),
        });
        return await resp.json();
      })()`
    );

    if (Number(res?.errno) !== 0) {
      return {
        ok: false,
        errno: res?.errno,
        error: res?.errmsg || res?.show_msg || `filemanager(${opera}) 执行失败`,
        info: res?.info || [],
      };
    }

    if (res?.taskid) {
      const taskId = String(res.taskid);
      for (let i = 0; i < 45; i += 1) {
        await sleep(400);
        const poll = await this.session.evaluate(
          `(async () => {
            const taskId = ${JSON.stringify(taskId)};
            const bdstoken = ${JSON.stringify(bdstoken)};
            const url =
              '/share/taskquery?taskid=' +
              encodeURIComponent(taskId) +
              '&channel=chunlei&web=1&app_id=250528&clienttype=0' +
              (bdstoken ? '&bdstoken=' + encodeURIComponent(bdstoken) : '');
            const resp = await fetch(url, { credentials: 'include' });
            return await resp.json();
          })()`
        );
        if (poll?.status === 'success' || Number(poll?.errno) === 0 && poll?.status === ' finish') {
          break;
        }
        if (poll?.status === 'failed') {
          return {
            ok: false,
            errno: poll?.errno || -1,
            error: `百度网盘异步任务 (${opera}) 失败`,
          };
        }
        if (poll?.status === 'success') break;
      }
    }

    return { ok: true, errno: 0, info: res?.info || [] };
  }

  /**
   * 分批执行百度网盘批量重命名
   * 重命名成功后原地同步更新 item.id (完整路径) 与 item.name，确保后续移动阶段无缝衔接最新路径
   */
  async batchRename(renameItems, { batchSize = 80, onProgress = null } = {}) {
    const actionable = renameItems.filter((item) => item.oldName !== item.newName);
    let completed = 0;

    for (let i = 0; i < actionable.length; i += batchSize) {
      const chunk = actionable.slice(i, i + batchSize);
      const filelist = chunk.map((item) => ({
        path: normalizeBaiduPath(item.id),
        newname: item.newName,
      }));

      const res = await this._executeFileManager('rename', filelist, { ondup: 'fail' });
      if (!res.ok) {
        throw new Error(
          `百度网盘批量重命名第 ${Math.floor(i / batchSize) + 1} 批失败 [errno=${res.errno}]: ${res.error}`
        );
      }

      for (const item of chunk) {
        const { parentPath } = splitBaiduParentAndName(item.id);
        item.id = joinBaiduPath(parentPath, item.newName);
        item.path = item.id;
        item.name = item.newName;
      }

      completed += chunk.length;
      onProgress?.(`百度网盘批量重命名进度: ${completed}/${actionable.length}`);
      if (i + batchSize < actionable.length) {
        await sleep(randomDelayMs(250, 450));
      }
    }

    return {
      renamedCount: actionable.length,
      skippedSameNameCount: renameItems.length - actionable.length,
    };
  }

  /**
   * 按目标目录路径分批移动文件
   * 移动成功后原地同步更新 item.id 与 item.parentId，确保先移动后改名或先改名后移动均精确寻址
   */
  async batchMoveToFolder(targetDir, items, { batchSize = 100, onProgress = null } = {}) {
    const normDest = normalizeBaiduPath(targetDir);
    const actionable = items.filter((item) => {
      const curParent = item.parentId
        ? normalizeBaiduPath(item.parentId)
        : splitBaiduParentAndName(item.id).parentPath;
      return curParent !== normDest;
    });
    let moved = 0;

    for (let i = 0; i < actionable.length; i += batchSize) {
      const chunk = actionable.slice(i, i + batchSize);
      const filelist = chunk.map((item) => {
        const currentPath = normalizeBaiduPath(item.id);
        const currentFileName = splitBaiduParentAndName(currentPath).name || item.name || item.oldName;
        return {
          path: currentPath,
          dest: normDest,
          newname: currentFileName,
        };
      });

      const res = await this._executeFileManager('move', filelist, { ondup: 'fail' });
      if (!res.ok) {
        throw new Error(
          `百度网盘批量移动至目录 "${normDest}" 失败 [errno=${res.errno}]: ${res.error}`
        );
      }

      for (const item of chunk) {
        const currentFileName = splitBaiduParentAndName(item.id).name || item.name || item.oldName;
        item.id = joinBaiduPath(normDest, currentFileName);
        item.path = item.id;
        item.parentId = normDest;
      }

      moved += chunk.length;
      onProgress?.(`目录 (${normDest}) 移动进度: ${moved}/${actionable.length}`);
      if (i + batchSize < actionable.length) {
        await sleep(randomDelayMs(250, 450));
      }
    }

    return { movedCount: actionable.length };
  }

  /**
   * 将指定文件或空目录移入百度网盘回收站
   */
  async deleteItemsToRecycleBin(parentPath, itemIds = []) {
    if (!itemIds || itemIds.length === 0) return { state: true };
    const filelist = itemIds.map((p) => normalizeBaiduPath(p));
    const res = await this._executeFileManager('delete', filelist);
    return {
      state: res.ok,
      errno: res.errno,
      error: res.error || '',
    };
  }

  resolveRenamedFolderId(oldPath, newFolderName) {
    const { parentPath } = splitBaiduParentAndName(oldPath);
    return joinBaiduPath(parentPath, newFolderName);
  }

  /**
   * 刷新百度网盘视图至整理后的目录
   */
  async reloadView(targetDir = null) {
    await this.session
      .evaluate(
        `(() => {
          const dir = ${JSON.stringify(targetDir ? normalizeBaiduPath(targetDir) : null)};
          if (dir) {
            const encoded = encodeURIComponent(dir);
            if (window.location.pathname.includes('/disk/main')) {
              window.location.hash = \`#/index?category=all&path=\${encoded}\`;
            } else {
              window.location.reload();
            }
          } else {
            window.location.reload();
          }
          return true;
        })()`
      )
      .catch(() => {});
  }
}
