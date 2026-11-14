import { setTimeout as sleep } from 'node:timers/promises';
import { BaseCloudDriveBridge, randomDelayMs } from './drive-base.mjs';

/**
 * 夸克网盘 (pan.quark.cn) WebAPI 浏览器原位桥接层
 * 所有请求均在已登录的 pan.quark.cn 标签页沙箱内通过 credentials: 'include' 原位发送，
 * 严守零凭证泄露安全底线：绝不读取、导出、打印或落盘任何 Cookie / Token。
 */
export class QuarkDriveBridge extends BaseCloudDriveBridge {
  constructor(pageSession) {
    super(pageSession, { driveType: 'quark', driveLabel: '夸克网盘' });
    this._folderMeta = new Map([
      ['0', { id: '0', name: '全部文件', parentId: null, fullPathText: '全部文件' }],
    ]);
  }

  getRootDirId() {
    return '0';
  }

  /**
   * 自动探测当前用户在夸克网盘页面中打开的文件夹 fid
   * 夸克网页端常见 URL Hash 格式: #/list/all/{fid1}-{name1}/{fid2}-{name2}
   */
  async detectActiveCid() {
    const info = await this.session.evaluate(`(() => {
      const href = String(window.location.href || '');
      const hash = String(window.location.hash || '');

      // 1. 解析 #/list/all/{fid}-{name}/... 中的最深层 32 位十六进制 fid
      const hashMatches = [...hash.matchAll(/\\/([0-9a-fA-F]{32})(?:-([^/?#]+))?/g)];
      if (hashMatches.length > 0) {
        const last = hashMatches[hashMatches.length - 1];
        return { cid: last[1], source: 'hash_url' };
      }

      // 2. 检查 URL 查询参数中的 fid / pdir_fid
      const queryMatch = href.match(/[?&](?:pdir_)?fid=([0-9a-fA-F]{32})/);
      if (queryMatch && queryMatch[1] !== '0') {
        return { cid: queryMatch[1], source: 'query_url' };
      }

      // 3. 检查 DOM 面包屑节点属性
      const crumbs = document.querySelectorAll('[data-fid], [fid]');
      for (let i = crumbs.length - 1; i >= 0; i--) {
        const fid = crumbs[i].getAttribute('data-fid') || crumbs[i].getAttribute('fid');
        if (fid && /^[0-9a-fA-F]{32}$/.test(fid)) {
          return { cid: fid, source: 'breadcrumb_dom' };
        }
      }

      return { cid: null, source: 'none' };
    })()`);

    return info;
  }

  /**
   * 内部通用请求：优先调用已验证可用的 origin（默认 drive-pc.quark.cn），若遇网络或跨域限制自动回退并记忆最佳端点
   */
  async _quarkFetchJson(pathWithQuery, { method = 'GET', bodyObj = null } = {}) {
    return await this.session.evaluate(
      `(async () => {
        const pathStr = ${JSON.stringify(pathWithQuery)};
        const method = ${JSON.stringify(method)};
        const bodyObj = ${JSON.stringify(bodyObj)};
        const baseOrigins = ['https://drive-pc.quark.cn', 'https://drive.quark.cn', ''];
        const preferred = typeof window.__quarkPreferredOrigin === 'string' ? window.__quarkPreferredOrigin : null;
        const origins = preferred !== null
          ? [preferred, ...baseOrigins.filter((o) => o !== preferred)]
          : baseOrigins;

        let lastErr = '';
        for (const origin of origins) {
          const url = origin + pathStr;
          try {
            const opts = {
              method,
              credentials: 'include',
              headers: {
                Accept: 'application/json, text/plain, */*',
              },
            };
            if (bodyObj !== null) {
              opts.headers['Content-Type'] = 'application/json;charset=UTF-8';
              opts.body = JSON.stringify(bodyObj);
            }
            const resp = await fetch(url, opts);
            const text = await resp.text();
            const json = JSON.parse(text);
            if (json && typeof json === 'object') {
              window.__quarkPreferredOrigin = origin;
              return json;
            }
          } catch (err) {
            lastErr = err?.message || String(err);
          }
        }
        return {
          status: 500,
          code: -1,
          message: lastErr || '夸克网盘接口响应异常，请确认已在浏览器登录 pan.quark.cn',
        };
      })()`
    );
  }

  /**
   * 轮询夸克网盘异步任务（移动 / 删除文件数量较多时会返回 task_id）
   */
  async _waitQuarkTask(taskId, maxRetries = 40) {
    if (!taskId) return { ok: true };
    for (let i = 0; i < maxRetries; i += 1) {
      await sleep(400);
      const res = await this._quarkFetchJson(
        `/1/clouddrive/task?pr=ucpro&fr=pc&task_id=${encodeURIComponent(String(taskId))}&retry_index=${i}`
      );
      const status = Number(res?.data?.status ?? 2);
      if (status === 2 || res?.data?.finish === true) {
        return { ok: true, data: res?.data };
      }
      if (res?.code && Number(res.code) !== 0) {
        return { ok: false, error: res.message || `任务执行异常 (code=${res.code})` };
      }
    }
    return { ok: true };
  }

  _buildBreadcrumbPath(fid) {
    const chain = [];
    let cur = String(fid);
    const visited = new Set();
    while (cur && this._folderMeta.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      const meta = this._folderMeta.get(cur);
      chain.unshift({ name: meta.name, cid: meta.id });
      cur = meta.parentId;
    }
    if (chain.length === 0) {
      return [{ name: `fid:${fid}`, cid: String(fid) }];
    }
    return chain;
  }

  /**
   * 分页拉取指定 fid 目录下的全部直接子项（文件 + 子文件夹）
   */
  async listDirectChildren(fid) {
    const pageSize = 100;
    let page = 1;
    const items = [];
    const targetFid = String(fid || '0');

    while (true) {
      const json = await this._quarkFetchJson(
        `/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=${encodeURIComponent(
          targetFid
        )}&_page=${page}&_size=${pageSize}&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,file_name:asc`
      );

      const isOk = Number(json?.status) === 200 && Number(json?.code || 0) === 0;
      if (!isOk) {
        throw new Error(
          `读取夸克网盘目录 (fid=${targetFid}) 失败 [code=${json?.code ?? json?.status}]: ${
            json?.message || '请确认已在浏览器登录夸克网盘 (pan.quark.cn)'
          }`
        );
      }

      const list = Array.isArray(json?.data?.list) ? json.data.list : [];
      const total = Number(json?.metadata?._total ?? list.length);

      for (const d of list) {
        const isDir = Boolean(d.dir === true || d.file === false || d.file_type === 0);
        const itemFid = String(d.fid || '');
        const itemName = String(d.file_name || '');
        const parentFid = String(d.pdir_fid ?? targetFid);

        if (isDir && itemFid) {
          this._folderMeta.set(itemFid, {
            id: itemFid,
            name: itemName,
            parentId: parentFid,
          });
        }

        items.push({
          isFile: !isDir,
          id: itemFid,
          parentId: parentFid,
          pickCode: '',
          name: itemName,
          ico: isDir ? 'folder' : String(d.format_type || ''),
          size: Number(d.size || 0),
        });
      }

      if (list.length < pageSize || items.length >= total) {
        break;
      }
      page += 1;
      await sleep(80);
    }

    const folderPath = this._buildBreadcrumbPath(targetFid);
    return {
      cid: targetFid,
      folderPath,
      fullPathText: folderPath.map((p) => p.name).join(' / ') || `fid:${targetFid}`,
      folders: items.filter((x) => !x.isFile),
      files: items.filter((x) => x.isFile),
    };
  }

  /**
   * 按关键词搜索夸克网盘内的相关文件夹路径与 fid
   */
  async searchFolders(keyword) {
    const json = await this._quarkFetchJson(
      `/1/clouddrive/file/search?pr=ucpro&fr=pc&q=${encodeURIComponent(
        String(keyword)
      )}&_page=1&_size=50&_fetch_total=1&_sort=file_type:asc,updated_at:desc`
    );

    if (Number(json?.status) !== 200 || Number(json?.code || 0) !== 0) {
      throw new Error(`夸克网盘目录搜索失败: ${json?.message || '未知错误'}`);
    }

    const list = Array.isArray(json?.data?.list) ? json.data.list : [];
    const candidateFids = new Set();
    const folderNames = new Map();

    for (const d of list) {
      const isDir = Boolean(d.dir === true || d.file === false || d.file_type === 0);
      if (isDir && d.fid) {
        candidateFids.add(String(d.fid));
        folderNames.set(String(d.fid), String(d.file_name || ''));
      } else if (d.pdir_fid && String(d.pdir_fid) !== '0') {
        candidateFids.add(String(d.pdir_fid));
      }
    }

    const topFids = [...candidateFids].slice(0, 12);
    const results = [];
    const concurrency = 4;
    for (let i = 0; i < topFids.length; i += concurrency) {
      const batch = topFids.slice(i, i + concurrency);
      const batchRes = await Promise.all(
        batch.map(async (fid) => {
          try {
            const listing = await this.listDirectChildren(fid);
            return {
              cid: fid,
              fullPath: folderNames.get(fid) || listing.fullPathText,
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
  async ensureFolder(parentFid, folderName) {
    const targetParent = String(parentFid || '0');
    const json = await this._quarkFetchJson('/1/clouddrive/file?pr=ucpro&fr=pc', {
      method: 'POST',
      bodyObj: {
        pdir_fid: targetParent,
        file_name: String(folderName),
        dir_path: '',
        dir_init_lock: false,
      },
    });

    if (Number(json?.status) === 200 && Number(json?.code || 0) === 0 && json?.data?.fid) {
      const createdFid = String(json.data.fid);
      if (json.data.task_id && !json.data.finish) {
        await this._waitQuarkTask(json.data.task_id);
      }
      this._folderMeta.set(createdFid, {
        id: createdFid,
        name: String(folderName),
        parentId: targetParent,
      });
      return { cid: createdFid, created: true };
    }

    // 若同名目录已存在，重新读取父目录匹配现有 fid
    const refreshed = await this.listDirectChildren(targetParent);
    const key = String(folderName).trim().toLowerCase();
    const found = refreshed.folders.find((f) => f.name.trim().toLowerCase() === key);
    if (found) {
      return { cid: found.id, created: false };
    }

    throw new Error(
      `夸克网盘创建目录 "${folderName}" (pdir_fid=${targetParent}) 失败 [code=${
        json?.code ?? json?.status
      }]: ${json?.message || '未知错误'}`
    );
  }

  /**
   * 执行夸克网盘批量重命名（分波并发调用 /1/clouddrive/file/rename，默认并发度 4，兼顾高吞吐与防风控）
   */
  async batchRename(renameItems, { concurrency = 4, onProgress = null } = {}) {
    const actionable = renameItems.filter((item) => item.oldName !== item.newName);
    let completed = 0;

    for (let i = 0; i < actionable.length; i += concurrency) {
      const wave = actionable.slice(i, i + concurrency);
      await Promise.all(
        wave.map(async (item) => {
          const json = await this._quarkFetchJson('/1/clouddrive/file/rename?pr=ucpro&fr=pc', {
            method: 'POST',
            bodyObj: {
              fid: String(item.id),
              file_name: String(item.newName),
            },
          });

          if (Number(json?.status) !== 200 || Number(json?.code || 0) !== 0) {
            throw new Error(
              `夸克网盘重命名 "${item.oldName}" -> "${item.newName}" 失败 [code=${
                json?.code ?? json?.status
              }]: ${json?.message || '未知错误'}`
            );
          }

          item.name = item.newName;
        })
      );

      completed += wave.length;
      if (completed % 12 === 0 || completed === actionable.length) {
        onProgress?.(`夸克网盘重命名进度: ${completed}/${actionable.length}`);
      }
      if (i + concurrency < actionable.length) {
        await sleep(randomDelayMs(60, 110));
      }
    }

    return {
      renamedCount: actionable.length,
      skippedSameNameCount: renameItems.length - actionable.length,
    };
  }

  /**
   * 按目标目录分批移动文件（POST /1/clouddrive/file/move）
   */
  async batchMoveToFolder(targetFid, items, { batchSize = 100, onProgress = null } = {}) {
    const actionable = items.filter((item) => String(item.parentId) !== String(targetFid));
    let moved = 0;

    for (let i = 0; i < actionable.length; i += batchSize) {
      const chunk = actionable.slice(i, i + batchSize);
      const fids = chunk.map((x) => String(x.id));

      const json = await this._quarkFetchJson('/1/clouddrive/file/move?pr=ucpro&fr=pc', {
        method: 'POST',
        bodyObj: {
          action_type: 1,
          to_pdir_fid: String(targetFid),
          filelist: fids,
          exclude_fids: [],
        },
      });

      if (Number(json?.status) !== 200 || Number(json?.code || 0) !== 0) {
        throw new Error(
          `夸克网盘批量移动至目录 fid=${targetFid} 失败 [code=${json?.code ?? json?.status}]: ${
            json?.message || '未知错误'
          }`
        );
      }

      if (json?.data?.task_id && !json?.data?.finish) {
        const taskRes = await this._waitQuarkTask(json.data.task_id);
        if (!taskRes.ok) {
          throw new Error(`夸克网盘移动任务执行失败: ${taskRes.error}`);
        }
      }

      for (const item of chunk) {
        item.parentId = String(targetFid);
      }

      moved += chunk.length;
      onProgress?.(`目录 (fid=${targetFid}) 移动进度: ${moved}/${actionable.length}`);
      if (i + batchSize < actionable.length) {
        await sleep(randomDelayMs(200, 350));
      }
    }

    return { movedCount: actionable.length };
  }

  /**
   * 将指定文件或空目录移入夸克网盘回收站（POST /1/clouddrive/file/delete）
   */
  async deleteItemsToRecycleBin(parentFid, itemIds = []) {
    if (!itemIds || itemIds.length === 0) return { state: true };
    const json = await this._quarkFetchJson('/1/clouddrive/file/delete?pr=ucpro&fr=pc', {
      method: 'POST',
      bodyObj: {
        action_type: 2,
        filelist: itemIds.map((x) => String(x)),
        exclude_fids: [],
      },
    });

    if (Number(json?.status) !== 200 || Number(json?.code || 0) !== 0) {
      return {
        state: false,
        error: json?.message || `删除失败 (code=${json?.code ?? json?.status})`,
      };
    }

    if (json?.data?.task_id && !json?.data?.finish) {
      await this._waitQuarkTask(json.data.task_id);
    }
    return { state: true };
  }

  /**
   * 刷新夸克网盘视图
   */
  async reloadView(targetFid = null) {
    await this.session
      .evaluate(
        `(() => {
          const fid = ${JSON.stringify(targetFid ? String(targetFid) : null)};
          if (fid && fid !== '0' && !window.location.hash.includes(fid)) {
            window.location.hash = \`#/list/all/\${fid}\`;
          } else {
            window.location.reload();
          }
          return true;
        })()`
      )
      .catch(() => {});
  }
}
