import { setTimeout as sleep } from 'node:timers/promises';
import { BaseCloudDriveBridge, randomDelayMs } from './drive-base.mjs';
import {
  ARCHIVE_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  getExtension,
  isSubtitleArchiveCandidate,
} from './matcher.mjs';

function buildArchiveStagingName(archiveFilename = '') {
  const stem = String(archiveFilename || 'subs')
    .replace(/\.(?:tar\.(?:gz|bz2|xz)|part0*1\.rar|[^.]+)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim()
    .slice(0, 80);
  return `_字幕解压_${stem || 'subs'}_`;
}

/**
 * 115 网盘 WebAPI 浏览器原位桥接层
 * 所有请求均在已登录的 115.com 标签页沙箱内通过 credentials: 'include' 原位发送
 * 严守安全红线：绝不导出、读取、打印或落盘任何 Cookie / Token 凭证
 */
export class Cloud115Bridge extends BaseCloudDriveBridge {
  constructor(pageSession) {
    super(pageSession, { driveType: '115', driveLabel: '115网盘' });
  }

  getRootDirId() {
    return '0';
  }

  /**
   * 自动探测当前用户在 115 页面中打开的文件夹 cid（穿透顶层窗口、wangpan iframe 及面包屑 DOM）
   */
  async detectActiveCid() {
    const info = await this.session.evaluate(`(() => {
      function extractCidFromUrl(urlStr) {
        if (!urlStr) return null;
        const m = String(urlStr).match(/[?&]cid=(\\d+)/);
        return m ? m[1] : null;
      }

      // 1. 优先检查 wangpan iframe 内部实时 URL 与面包屑末尾节点
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const frame of iframes) {
        try {
          const win = frame.contentWindow;
          const doc = frame.contentDocument;
          if (win && win.location) {
            const fCid = extractCidFromUrl(win.location.href);
            if (fCid && fCid !== '0') {
              return { cid: fCid, source: 'iframe_url' };
            }
          }
          if (doc) {
            const crumbs = doc.querySelectorAll('[cid], [cate_id]');
            for (let i = crumbs.length - 1; i >= 0; i--) {
              const el = crumbs[i];
              if (el.closest('#js_top_header_file_path_box, .list-top-path, [rel="top_path"]')) {
                const c = el.getAttribute('cid') || el.getAttribute('cate_id');
                if (c && /^\\d+$/.test(c)) {
                  return { cid: c, source: 'iframe_breadcrumb' };
                }
              }
            }
          }
        } catch {
          // 忽略跨域子框架
        }
      }

      // 2. 检查顶层窗口 URL
      const topCid = extractCidFromUrl(window.location.href);
      if (topCid) {
        return { cid: topCid, source: 'top_url' };
      }

      // 3. 检查顶层 DOM 面包屑
      const topCrumbs = document.querySelectorAll(
        '#js_top_header_file_path_box [cid], .list-top-path [cid], [rel="top_path"] [cid]'
      );
      if (topCrumbs.length > 0) {
        const last = topCrumbs[topCrumbs.length - 1];
        const c = last.getAttribute('cid');
        if (c && /^\\d+$/.test(c)) {
          return { cid: c, source: 'top_breadcrumb' };
        }
      }

      return { cid: null, source: 'none' };
    })()`);

    return info;
  }

  /**
   * 分页拉取指定 cid 目录下的全部直接子项（文件 + 子文件夹），并返回官方目录路径面包屑
   * 自动处理 errNo=20130827 自然排序分流（切换 aps.115.com/natsort/files.php 或时间序兜底）
   */
  async listDirectChildren(cid) {
    const pageLimit = 1150;
    let offset = 0;
    let folderPath = [];
    const items = [];

    while (true) {
      const pageRes = await this.session.evaluate(
        `(async () => {
          const cid = ${JSON.stringify(String(cid))};
          const offset = ${Number(offset)};
          const limit = ${Number(pageLimit)};

          const stdUrl = \`https://webapi.115.com/files?aid=1&cid=\${cid}&o=file_name&asc=1&offset=\${offset}&show_dir=1&limit=\${limit}&format=json\`;
          let resp = await fetch(stdUrl, { credentials: 'include' });
          let text = await resp.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            try {
              const natUrl = \`https://aps.115.com/natsort/files.php?aid=1&cid=\${cid}&o=file_name&asc=1&offset=\${offset}&show_dir=1&limit=\${limit}&format=json\`;
              const natResp = await fetch(natUrl, { credentials: 'include' });
              const natText = await natResp.text();
              json = JSON.parse(natText);
            } catch {
              return {
                state: false,
                errno: 990001,
                error: '115 网盘登录态失效或响应非 JSON（请在浏览器中重新登录 115 网盘）',
              };
            }
          }

          // 115 文件夹开启文件名自然排序时会返回 errNo: 20130827，指向 natsort 接口
          if (!json.state && Number(json.errNo || json.errno) === 20130827) {
            try {
              const natUrl = \`https://aps.115.com/natsort/files.php?aid=1&cid=\${cid}&o=file_name&asc=1&offset=\${offset}&show_dir=1&limit=\${limit}&format=json\`;
              const natResp = await fetch(natUrl, { credentials: 'include' });
              const natText = await natResp.text();
              json = JSON.parse(natText);
            } catch {
              try {
                const fallbackUrl = \`https://webapi.115.com/files?aid=1&cid=\${cid}&o=user_ptime&asc=1&offset=\${offset}&show_dir=1&limit=\${limit}&format=json\`;
                const fbResp = await fetch(fallbackUrl, { credentials: 'include' });
                const fbText = await fbResp.text();
                json = JSON.parse(fbText);
              } catch {}
            }
          }

          return {
            state: Boolean(json.state),
            error: json.error || json.msg || '',
            errno: json.errno || json.errNo || 0,
            count: Number(json.count || 0),
            path: Array.isArray(json.path)
              ? json.path.map((p) => ({ name: p.name, cid: String(p.cid ?? p.isp ?? '') }))
              : [],
            data: Array.isArray(json.data)
              ? json.data.map((d) => ({
                  isFile: Boolean(d.fid),
                  id: String(d.fid ? d.fid : d.cid),
                  parentId: String(d.fid ? d.cid : d.pid),
                  pickCode: String(d.pc || ''),
                  name: String(d.n || ''),
                  ico: String(d.ico || ''),
                  size: Number(d.s || 0),
                }))
              : [],
          };
        })()`
      );

      if (!pageRes.state) {
        throw new Error(
          `读取 115 目录 (cid=${cid}) 失败 [errno=${pageRes.errno}]: ${pageRes.error || '请确认已在浏览器登录 115 网盘'}`
        );
      }

      if (offset === 0 && pageRes.path.length > 0) {
        folderPath = pageRes.path;
      }

      items.push(...pageRes.data);
      offset += pageRes.data.length;

      if (pageRes.data.length === 0 || offset >= pageRes.count) {
        break;
      }
      await sleep(50);
    }

    return {
      cid: String(cid),
      folderPath,
      fullPathText: folderPath.map((p) => p.name).join(' / ') || `cid:${cid}`,
      folders: items.filter((x) => !x.isFile),
      files: items.filter((x) => x.isFile),
    };
  }

  /**
   * 按关键词搜索 115 内的相关文件夹路径与 cid（当用户只给出模糊文件夹名而非从根开始的完整路径时使用）
   * 优化：在页面沙箱内以 5 并发度批量拉取候选目录面包屑，大幅缩短搜索耗时
   */
  async searchFolders(keyword) {
    const res = await this.session.evaluate(
      `(async () => {
        const kw = ${JSON.stringify(String(keyword))};
        const r = await fetch(
          'https://webapi.115.com/files/search?offset=0&limit=100&aid=1&format=json&search_value=' +
            encodeURIComponent(kw),
          { credentials: 'include' }
        );
        const text = await r.text();
        let sj;
        try { sj = JSON.parse(text); } catch { return { state: false, error: '未登录或响应非 JSON' }; }
        if (!sj.state) return { state: false, error: sj.error || '搜索失败' };

        const candidateCids = new Set();
        for (const d of sj.data || []) {
          if (!d.fid && d.cid) candidateCids.add(String(d.cid));
          else if (d.fid && d.cid) candidateCids.add(String(d.cid));
        }

        const cids = [...candidateCids].filter((c) => c && c !== '0').slice(0, 15);
        const results = [];
        const concurrency = 5;
        for (let i = 0; i < cids.length; i += concurrency) {
          const wave = cids.slice(i, i + concurrency);
          const waveRes = await Promise.all(
            wave.map(async (cid) => {
              try {
                const pr = await fetch(
                  \`https://webapi.115.com/files?aid=1&cid=\${cid}&limit=3&offset=0&show_dir=1&o=user_ptime&format=json\`,
                  { credentials: 'include' }
                );
                const pj = await pr.json();
                if (pj && pj.state) {
                  return {
                    cid,
                    fullPath: Array.isArray(pj.path) ? pj.path.map((p) => p.name).join(' / ') : '',
                    totalItems: Number(pj.count || 0),
                    sampleItem: pj.data?.[0]?.n || '',
                  };
                }
              } catch {}
              return null;
            })
          );
          for (const item of waveRes) {
            if (item) results.push(item);
          }
        }
        return { state: true, results };
      })()`
    );

    if (!res.state) {
      throw new Error(`115 目录关键词搜索失败: ${res.error}`);
    }
    return res.results;
  }

  /**
   * 幂等在指定父目录下创建或复用单个子文件夹
   */
  async ensureFolder(parentCid, folderName) {
    const addRes = await this.session.evaluate(
      `(async () => {
        const body = new URLSearchParams();
        body.set('pid', ${JSON.stringify(String(parentCid))});
        body.set('cname', ${JSON.stringify(String(folderName))});
        const resp = await fetch('https://webapi.115.com/files/add', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString(),
        });
        return await resp.json();
      })()`
    );

    if (addRes.state) {
      return {
        cid: String(addRes.cid || addRes.file_id),
        created: true,
      };
    }

    if (Number(addRes.errno) === 20004) {
      const refreshed = await this.listDirectChildren(parentCid);
      const key = String(folderName).trim().toLowerCase();
      const found = refreshed.folders.find((f) => f.name.trim().toLowerCase() === key);
      if (found) {
        return { cid: found.id, created: false };
      }
    }

    throw new Error(
      `创建目录 "${folderName}" (pid=${parentCid}) 失败 [errno=${addRes.errno}]: ${addRes.error || '未知错误'}`
    );
  }

  /**
   * 将指定父目录下的若干文件/空目录移入 115 回收站（POST https://webapi.115.com/rb/delete）
   */
  async deleteItemsToRecycleBin(parentCid, itemIds = []) {
    if (!itemIds || itemIds.length === 0) return { state: true };
    let delRes = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      delRes = await this.session.evaluate(
        `(async () => {
          const pid = ${JSON.stringify(String(parentCid))};
          const fids = ${JSON.stringify(itemIds.map((x) => String(x)))};
          const body = new URLSearchParams();
          body.set('pid', pid);
          fids.forEach((fid, idx) => body.set(\`fid[\${idx}]\`, fid));
          body.set('ignore_warn', '1');
          const resp = await fetch('https://webapi.115.com/rb/delete', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString(),
          });
          return await resp.json();
        })()`
      );
      if (delRes?.state || Number(delRes?.errno) !== 990009) break;
      await sleep(1500 * attempt);
    }
    return delRes || { state: false, error: '请求未响应' };
  }

  /**
   * 拉取 115 云端压缩包内指定 paths 层级的目录项列表（自动处理 next_marker 分页）
   */
  async _fetchArchiveDirEntries(pickCode, pathsStr = '文件') {
    const allItems = [];
    let nextMarker = '';

    while (true) {
      const res = await this.session.evaluate(
        `(async () => {
          const pc = ${JSON.stringify(String(pickCode))};
          const pathsVal = ${JSON.stringify(String(pathsStr))};
          const marker = ${JSON.stringify(String(nextMarker))};
          let url =
            'https://webapi.115.com/files/extract_info?pick_code=' +
            encodeURIComponent(pc) +
            '&file_name=&paths=' +
            encodeURIComponent(pathsVal) +
            '&page_count=999&_=' +
            Date.now();
          if (marker) {
            url += '&next_marker=' + encodeURIComponent(marker);
          }
          const resp = await fetch(url, { credentials: 'include' });
          return await resp.json();
        })()`
      );

      const dataList = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.list)
        ? res.data.list
        : null;

      if (!res?.state || !dataList) {
        return {
          state: false,
          error: res?.error || res?.msg || '',
          errno: res?.errno || res?.errNo || 0,
          items: [],
        };
      }

      for (const it of dataList) {
        const rawName = String(it.file_name || it.dir_name || it.n || it.name || '').replace(
          /^[\/\\]+|[\/\\]+$/g,
          ''
        );
        if (!rawName) continue;
        const isDir =
          it.file_category === 0 ||
          it.file_category === '0' ||
          Boolean(it.dir_name && !it.file_name) ||
          it.ico === 'folder' ||
          it.is_dir === 1 ||
          it.is_dir === true ||
          /[\/\\]$/.test(String(it.file_name || ''));
        allItems.push({
          name: rawName,
          isDir,
          size: Number(it.size || it.s || 0),
          ico: String(it.ico || ''),
        });
      }

      const nm = String(res.next_marker || res.data?.next_marker || '');
      if (!nm || dataList.length === 0) break;
      nextMarker = nm;
    }

    return { state: true, items: allItems };
  }

  /**
   * 非破坏性检视压缩包内部的多层字幕文件与嵌套压缩包结构（Dry-Run 预览与解压前置过滤通用）
   * 调用 push_extract + extract_info，不在用户 115 目录内写入任何文件
   */
  async inspectArchiveSubtitles(archiveFile, { secret = '', maxDepth = 6 } = {}) {
    const pickCode = String(archiveFile?.pickCode || '');
    if (!pickCode) {
      return {
        ok: false,
        error: `压缩包 "${archiveFile?.name || ''}" 缺少 pick_code，无法调用云解压`,
        subtitleEntries: [],
        nestedArchiveEntries: [],
        relevantTopFiles: [],
        relevantTopDirs: [],
      };
    }

    // 1. 先尝试直接读取已缓存的 extract_info；若尚未云端索引则提交 push_extract 并轮询
    let rootRes = secret ? { state: false } : await this._fetchArchiveDirEntries(pickCode, '文件');

    if (!rootRes.state) {
      const pushRes = await this.session.evaluate(
        `(async () => {
          const body = new URLSearchParams();
          body.set('pick_code', ${JSON.stringify(pickCode)});
          const sec = ${JSON.stringify(String(secret || ''))};
          if (sec) body.set('secret', sec);
          const resp = await fetch('https://webapi.115.com/files/push_extract', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString(),
          });
          return await resp.json();
        })()`
      );

      if (!pushRes?.state) {
        const rawErr = pushRes?.error || pushRes?.msg || '云端解析压缩包失败';
        const hint = /密码|secret|password/i.test(rawErr)
          ? `${rawErr}（可通过 --archive-password "<密码>" 指定解压密码）`
          : rawErr;
        return {
          ok: false,
          error: hint,
          subtitleEntries: [],
          nestedArchiveEntries: [],
          relevantTopFiles: [],
          relevantTopDirs: [],
        };
      }

      for (let attempt = 1; attempt <= 25; attempt += 1) {
        await sleep(750);
        rootRes = await this._fetchArchiveDirEntries(pickCode, '文件');
        if (rootRes.state) break;

        const pollStatus = await this.session.evaluate(
          `(async () => {
            const pc = ${JSON.stringify(pickCode)};
            const resp = await fetch(
              'https://webapi.115.com/files/push_extract?pick_code=' + encodeURIComponent(pc) + '&_=' + Date.now(),
              { credentials: 'include' }
            );
            return await resp.json();
          })()`
        );

        const errMsg = pollStatus?.error || pollStatus?.msg || pollStatus?.data?.error || '';
        const unzipStatus = Number(
          pollStatus?.data?.unzip_status ?? pollStatus?.data?.extract_status ?? 0
        );
        if (!pollStatus?.state || /密码|损坏|失败|VIP|权限/i.test(errMsg) || unzipStatus < 0) {
          const finalErr =
            errMsg || `云端解析压缩包未就绪 (status=${unzipStatus})`;
          return {
            ok: false,
            error: /密码|secret|password/i.test(finalErr)
              ? `${finalErr}（可通过 --archive-password "<密码>" 指定解压密码）`
              : finalErr,
            subtitleEntries: [],
            nestedArchiveEntries: [],
            relevantTopFiles: [],
            relevantTopDirs: [],
          };
        }
      }
    }

    if (!rootRes.state) {
      return {
        ok: false,
        error: rootRes.error || '等待 115 云端解析压缩包目录超时',
        subtitleEntries: [],
        nestedArchiveEntries: [],
        relevantTopFiles: [],
        relevantTopDirs: [],
      };
    }

    const subtitleEntries = [];
    const nestedArchiveEntries = [];
    const relevantTopFiles = [];
    const relevantTopDirsSet = new Set();
    let hitMaxDepth = false;

    for (const topItem of rootRes.items) {
      if (!topItem.isDir) {
        const ext = getExtension(topItem.name);
        if (SUBTITLE_EXTENSIONS.has(ext)) {
          subtitleEntries.push({
            fileName: topItem.name,
            innerDir: '',
            parentFolderName: '',
            size: topItem.size,
          });
          relevantTopFiles.push(topItem.name);
        } else if (
          ARCHIVE_EXTENSIONS.has(ext) &&
          isSubtitleArchiveCandidate({ name: topItem.name, size: topItem.size })
        ) {
          nestedArchiveEntries.push({
            fileName: topItem.name,
            innerDir: '',
            size: topItem.size,
          });
          relevantTopFiles.push(topItem.name);
        }
      } else {
        // BFS 穿透检索该顶层目录下的多层子目录
        const dirQueue = [{ innerDir: topItem.name, depth: 1, folderName: topItem.name }];
        while (dirQueue.length > 0) {
          const cur = dirQueue.shift();
          await sleep(160);
          const subRes = await this._fetchArchiveDirEntries(pickCode, `文件/${cur.innerDir}`);
          if (!subRes.state) {
            relevantTopDirsSet.add(topItem.name);
            continue;
          }
          for (const child of subRes.items) {
            if (!child.isDir) {
              const ext = getExtension(child.name);
              if (SUBTITLE_EXTENSIONS.has(ext)) {
                subtitleEntries.push({
                  fileName: child.name,
                  innerDir: cur.innerDir,
                  parentFolderName: cur.folderName,
                  size: child.size,
                });
                relevantTopDirsSet.add(topItem.name);
              } else if (
                ARCHIVE_EXTENSIONS.has(ext) &&
                isSubtitleArchiveCandidate({ name: child.name, size: child.size })
              ) {
                nestedArchiveEntries.push({
                  fileName: child.name,
                  innerDir: cur.innerDir,
                  size: child.size,
                });
                relevantTopDirsSet.add(topItem.name);
              }
            } else if (cur.depth < maxDepth) {
              dirQueue.push({
                innerDir: `${cur.innerDir}/${child.name}`,
                depth: cur.depth + 1,
                folderName: child.name,
              });
            } else {
              hitMaxDepth = true;
              relevantTopDirsSet.add(topItem.name);
            }
          }
        }
      }
    }

    return {
      ok: true,
      error: '',
      hitMaxDepth,
      subtitleEntries,
      nestedArchiveEntries,
      relevantTopFiles,
      relevantTopDirs: [...relevantTopDirsSet],
    };
  }

  /**
   * 将单个字幕压缩包云端解压至其所在目录下的独立暂存文件夹 (_字幕解压_<包名>_)
   * 保留压缩包自身文件名中的季号上下文与电影合集父目录层级关系，且仅提取含字幕/内嵌压缩包的条目
   */
  async _unpackSingleSubtitleArchive(archiveFile, { secret = '', onProgress = null } = {}) {
    const inspectRes = await this.inspectArchiveSubtitles(archiveFile, { secret, maxDepth: 6 });
    if (!inspectRes.ok) {
      return {
        status: 'failed',
        archive: archiveFile,
        error: inspectRes.error,
      };
    }

    if (
      inspectRes.subtitleEntries.length === 0 &&
      inspectRes.nestedArchiveEntries.length === 0 &&
      !inspectRes.hitMaxDepth
    ) {
      return {
        status: 'skipped_no_subs',
        archive: archiveFile,
      };
    }

    const stagingName = buildArchiveStagingName(archiveFile.name);
    const stagingFolder = await this.ensureFolder(archiveFile.parentId, stagingName);

    const addRes = await this.session.evaluate(
      `(async () => {
        const pc = ${JSON.stringify(String(archiveFile.pickCode))};
        const toPid = ${JSON.stringify(String(stagingFolder.cid))};
        const sec = ${JSON.stringify(String(secret || ''))};
        const topFiles = ${JSON.stringify(inspectRes.relevantTopFiles)};
        const topDirs = ${JSON.stringify(inspectRes.relevantTopDirs)};

        const body = new URLSearchParams();
        body.set('pick_code', pc);
        body.set('to_pid', toPid);
        body.set('paths', '文件');
        if (sec) body.set('secret', sec);
        for (const f of topFiles) body.append('extract_file[]', f);
        for (const d of topDirs) body.append('extract_dir[]', d);

        const resp = await fetch('https://webapi.115.com/files/add_extract_file', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString(),
        });
        return await resp.json();
      })()`
    );

    if (!addRes?.state) {
      return {
        status: 'failed',
        archive: archiveFile,
        error: addRes?.error || addRes?.msg || '调用 115 add_extract_file 解压写入失败',
      };
    }

    const extractId = addRes?.data?.extract_id ?? addRes?.extract_id ?? null;
    let percent = Number(addRes?.data?.percent ?? addRes?.percent ?? (extractId ? 0 : 100));

    if (extractId && percent < 100) {
      for (let i = 0; i < 60; i += 1) {
        await sleep(900);
        const progRes = await this.session.evaluate(
          `(async () => {
            const eid = ${JSON.stringify(String(extractId))};
            const resp = await fetch(
              'https://webapi.115.com/files/add_extract_file?extract_id=' +
                encodeURIComponent(eid) +
                '&_=' +
                Date.now(),
              { credentials: 'include' }
            );
            return await resp.json();
          })()`
        );
        percent = Number(progRes?.data?.percent ?? progRes?.percent ?? percent);
        if (percent >= 100) break;
        if (progRes?.state === false) {
          return {
            status: 'failed',
            archive: archiveFile,
            error: progRes?.error || progRes?.msg || '云端解压进度异常中止',
          };
        }
      }
    }

    await sleep(500);
    onProgress?.(
      `已解压字幕包: "${archiveFile.name}" -> "${stagingName}" (内含字幕 ${inspectRes.subtitleEntries.length} 个` +
        (inspectRes.nestedArchiveEntries.length > 0
          ? `, 嵌套子压缩包 ${inspectRes.nestedArchiveEntries.length} 个`
          : '') +
        ')'
    );

    return {
      status: 'unpacked',
      archive: archiveFile,
      stagingCid: stagingFolder.cid,
      stagingName,
      inspectRes,
    };
  }

  /**
   * 顺序执行字幕压缩包云解压（支持套娃双层压缩包自动二次拆包，严守 115 串行解压约束）
   */
  async extractSubtitleArchives(
    archiveFiles = [],
    { secret = '', maxPasses = 2, deleteArchives = false, onProgress = null } = {}
  ) {
    let unpackedCount = 0;
    let skippedNonSubCount = 0;
    const failedArchives = [];
    const stagingCids = [];

    for (const arch of archiveFiles) {
      const res = await this._unpackSingleSubtitleArchive(arch, { secret, onProgress });
      if (res.status === 'skipped_no_subs') {
        skippedNonSubCount += 1;
        onProgress?.(`跳过非字幕压缩包: "${arch.name}" (内部未检测到字幕文件)`);
        continue;
      }
      if (res.status !== 'unpacked') {
        failedArchives.push({
          name: arch.name,
          relativeDir: arch.relativeDir || '',
          error: res.error,
        });
        onProgress?.(`解压压缩包失败: "${arch.name}" -> ${res.error}`);
        continue;
      }

      unpackedCount += 1;
      stagingCids.push(res.stagingCid);

      // Pass 2: 若第一层解压出了嵌套子压缩包（如 全季字幕包.zip 内含 S01.zip + S02.zip），继续拆包并清理临时中间压缩包
      if (maxPasses >= 2) {
        const innerTree = await this.scanTargetResourceTree(res.stagingCid, {
          maxSubfolderDepth: 6,
          includeSeasonFolders: true,
        });
        const nestedArchives = innerTree.files.filter((f) => isSubtitleArchiveCandidate(f));
        for (const innerArch of nestedArchives) {
          await sleep(450);
          const innerRes = await this._unpackSingleSubtitleArchive(innerArch, {
            secret,
            onProgress,
          });
          if (innerRes.status === 'unpacked') {
            unpackedCount += 1;
            if (deleteArchives) {
              await this.deleteItemsToRecycleBin(innerArch.parentId, [innerArch.id]);
            }
          } else if (innerRes.status !== 'skipped_no_subs') {
            failedArchives.push({
              name: `${arch.name} -> ${innerArch.name}`,
              relativeDir: innerArch.relativeDir || '',
              error: innerRes.error,
            });
          }
        }
      }

      if (deleteArchives) {
        await this.deleteItemsToRecycleBin(arch.parentId, [arch.id]);
        onProgress?.(`已按 --delete-archives 参数将原压缩包移入回收站: "${arch.name}"`);
      }

      await sleep(randomDelayMs(450, 750));
    }

    return {
      unpackedCount,
      skippedNonSubCount,
      failedArchives,
      stagingCids,
    };
  }

  /**
   * 幂等创建季度文件夹：已存在则直接返回现有 cid；不存在则调用 webapi.115.com/files/add 新建
   */
  async ensureSeasonFolders(rootCid, requiredSeasons, existingSeasonFoldersMap, onProgress = null) {
    const seasonCidMap = new Map();

    for (const s of requiredSeasons) {
      const key = s.folderName.toLowerCase();
      if (existingSeasonFoldersMap.has(key)) {
        const existing = existingSeasonFoldersMap.get(key);
        seasonCidMap.set(s.folderName, existing.id);
        onProgress?.(`复用已存在目录: ${s.folderName} (cid=${existing.id})`);
        continue;
      }

      const addRes = await this.session.evaluate(
        `(async () => {
          const body = new URLSearchParams();
          body.set('pid', ${JSON.stringify(String(rootCid))});
          body.set('cname', ${JSON.stringify(s.folderName)});
          const resp = await fetch('https://webapi.115.com/files/add', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString(),
          });
          return await resp.json();
        })()`
      );

      if (!addRes.state) {
        // 若并发或缓存导致报 20004 目录已存在，重新读取一次目录拿 cid
        if (Number(addRes.errno) === 20004) {
          const refreshed = await this.listDirectChildren(rootCid);
          const found = refreshed.folders.find(
            (f) => f.name.trim().toLowerCase() === key
          );
          if (found) {
            seasonCidMap.set(s.folderName, found.id);
            onProgress?.(`检测到同名目录已存在并复用: ${s.folderName} (cid=${found.id})`);
            continue;
          }
        }
        throw new Error(
          `创建季度文件夹 "${s.folderName}" 失败 [errno=${addRes.errno}]: ${addRes.error || '未知错误'}`
        );
      }

      const createdCid = String(addRes.cid || addRes.file_id);
      seasonCidMap.set(s.folderName, createdCid);
      onProgress?.(`新建季度目录成功: ${s.folderName} (cid=${createdCid})`);
      await sleep(randomDelayMs(150, 250));
    }

    return seasonCidMap;
  }

  /**
   * 分批执行批量重命名（POST https://webapi.115.com/files/batch_rename）
   */
  async batchRename(renameItems, { batchSize = 120, onProgress = null } = {}) {
    const actionable = renameItems.filter((item) => item.oldName !== item.newName);
    let completed = 0;

    for (let i = 0; i < actionable.length; i += batchSize) {
      const chunk = actionable.slice(i, i + batchSize);
      const payloadPairs = chunk.map((x) => [String(x.id), x.newName]);

      const res = await this.session.evaluate(
        `(async () => {
          const pairs = ${JSON.stringify(payloadPairs)};
          const body = new URLSearchParams();
          for (const [fid, newName] of pairs) {
            body.append(\`files_new_name[\${fid}]\`, newName);
          }
          const resp = await fetch('https://webapi.115.com/files/batch_rename', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString(),
          });
          return await resp.json();
        })()`
      );

      if (!res.state) {
        throw new Error(
          `批量重命名第 ${Math.floor(i / batchSize) + 1} 批失败 [errno=${res.errno}]: ${res.error || '未知错误'}`
        );
      }

      completed += chunk.length;
      onProgress?.(`批量重命名进度: ${completed}/${actionable.length}`);
      if (i + batchSize < actionable.length) {
        await sleep(randomDelayMs(200, 350));
      }
    }

    return { renamedCount: actionable.length, skippedSameNameCount: renameItems.length - actionable.length };
  }

  /**
   * 按目标目录分批移动文件（POST https://webapi.115.com/files/move）
   */
  async batchMoveToFolder(targetCid, items, { batchSize = 150, onProgress = null } = {}) {
    const actionable = items.filter((item) => String(item.parentId) !== String(targetCid));
    let moved = 0;

    for (let i = 0; i < actionable.length; i += batchSize) {
      const chunk = actionable.slice(i, i + batchSize);
      const fids = chunk.map((x) => String(x.id));

      const res = await this.session.evaluate(
        `(async () => {
          const targetCid = ${JSON.stringify(String(targetCid))};
          const fids = ${JSON.stringify(fids)};
          const body = new URLSearchParams();
          body.set('pid', targetCid);
          fids.forEach((fid, idx) => {
            body.set(\`fid[\${idx}]\`, fid);
          });
          const resp = await fetch('https://webapi.115.com/files/move', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString(),
          });
          return await resp.json();
        })()`
      );

      if (!res.state) {
        throw new Error(
          `批量移动至目录 cid=${targetCid} 失败 [errno=${res.errno}]: ${res.error || '未知错误'}`
        );
      }

      for (const item of chunk) {
        item.parentId = String(targetCid);
      }

      moved += chunk.length;
      onProgress?.(`目录 (cid=${targetCid}) 移动进度: ${moved}/${actionable.length}`);
      if (i + batchSize < actionable.length) {
        await sleep(randomDelayMs(150, 260));
      }
    }

    return { movedCount: actionable.length };
  }

  /**
   * 执行完毕后将浏览器网盘视图跳转/刷新至整理好的目标目录，方便直观查看 Season 01 ~ N
   */
  async reload115View(targetCid = null) {
    await this.session
      .evaluate(
        `(() => {
          const cid = ${JSON.stringify(targetCid ? String(targetCid) : null)};
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const frame of iframes) {
            try {
              if (frame.contentWindow && /115\\.com/.test(frame.contentWindow.location.hostname)) {
                if (cid) {
                  frame.contentWindow.location.href = \`https://115.com/?cid=\${cid}&offset=0&mode=wangpan\`;
                } else {
                  frame.contentWindow.location.reload();
                }
                return true;
              }
            } catch {}
          }
          if (cid) {
            window.location.href = \`https://115.com/?cid=\${cid}&offset=0&tab=&mode=wangpan\`;
          } else {
            window.location.reload();
          }
          return true;
        })()`
      )
      .catch(() => {});
  }

  async reloadView(targetCid = null) {
    return await this.reload115View(targetCid);
  }
}
