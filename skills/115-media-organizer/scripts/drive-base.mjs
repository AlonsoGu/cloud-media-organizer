import { setTimeout as sleep } from 'node:timers/promises';

export function randomDelayMs(min = 120, max = 260) {
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * 多网盘通用抽象桥接基类 (115网盘 / 百度网盘 / 夸克网盘)
 * 所有请求均在已登录的对应网盘浏览器标签页沙箱内通过 credentials: 'include' 原位发送，
 * 严守零凭证泄露安全底线：绝不读取、导出、打印或落盘任何 Cookie / BDUSS / Token。
 */
export class BaseCloudDriveBridge {
  constructor(pageSession, { driveType = '115', driveLabel = '网盘' } = {}) {
    this.session = pageSession;
    this.driveType = driveType;
    this.driveLabel = driveLabel;
  }

  /**
   * 穿透扫描目标资源目录（默认深度 8 层、并发度 4，支持多层嵌套外挂字幕文件夹、解压暂存目录及待重分类的季度/篇章子目录）
   */
  async scanTargetResourceTree(
    rootCid,
    { maxSubfolderDepth = 8, includeSeasonFolders = false, protectTopSeasonDirs = true, concurrency = 4 } = {}
  ) {
    const rootListing = await this.listDirectChildren(rootCid);
    const existingSeasonFolders = new Map();
    const collectedFiles = rootListing.files.map((f) => ({
      ...f,
      parentFolderName: '',
      relativeDir: '',
    }));

    const isSeasonDirName = (name = '') =>
      /^(?:Season\s+\d+|S\d{1,2}|Specials|第\s*[0-9一二两三四五六七八九十]+\s*季)$/i.test(
        name.trim()
      );

    const queue = [];
    const scannedSubfolders = [];
    for (const dir of rootListing.folders) {
      existingSeasonFolders.set(dir.name.trim().toLowerCase(), dir);
      const isStdSeason = /^(?:Season\s+\d+|Specials)$/i.test(dir.name.trim());
      if (!isStdSeason || includeSeasonFolders) {
        if (maxSubfolderDepth > 0) {
          queue.push({
            folder: dir,
            depth: 1,
            relPath: dir.name,
            isProtectedSeasonDir: protectTopSeasonDirs && isSeasonDirName(dir.name),
          });
        }
      }
    }

    while (queue.length > 0) {
      const currentBatch = queue.splice(0, concurrency);
      await Promise.all(
        currentBatch.map(async ({ folder, depth, relPath, isProtectedSeasonDir }) => {
          if (!isProtectedSeasonDir) {
            scannedSubfolders.push({
              id: folder.id,
              parentId: folder.parentId,
              path: folder.path || '',
              name: folder.name,
              depth,
              relPath,
            });
          }
          const subListing = await this.listDirectChildren(folder.id);
          for (const f of subListing.files) {
            collectedFiles.push({
              ...f,
              parentFolderName: folder.name,
              relativeDir: relPath,
            });
          }
          if (depth < maxSubfolderDepth) {
            for (const childDir of subListing.folders) {
              queue.push({
                folder: childDir,
                depth: depth + 1,
                relPath: `${relPath}/${childDir.name}`,
                isProtectedSeasonDir: false,
              });
            }
          }
        })
      );
      if (queue.length > 0) {
        await sleep(50);
      }
    }

    return {
      rootCid: String(rootListing.cid ?? rootCid),
      folderPath: rootListing.folderPath || [],
      fullPathText: rootListing.fullPathText || String(rootCid),
      existingSeasonFolders,
      scannedSubfolders,
      files: collectedFiles,
    };
  }

  /**
   * 根据用户给定的网盘目录路径（如 "根目录/云下载/火影忍者" 或 "/影视/剧集/庆余年"）逐级解析目标文件夹标识
   * 优化：在匹配到末级子目录后直接返回其 id 与组装好的完整路径，省去冗余的末级二次 listDirectChildren 请求
   */
  async resolvePathToCid(pathInput) {
    const rawSegments = String(pathInput || '')
      .split(/[\/\\]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const segments =
      rawSegments[0] === '根目录' || rawSegments[0] === '全部文件'
        ? rawSegments.slice(1)
        : rawSegments;

    if (segments.length === 0) {
      throw new Error(`无效的 ${this.driveLabel} 目标路径 "${pathInput}"（严禁直接指定根目录）`);
    }

    let currentCid = this.getRootDirId();
    let lastListing = null;
    let builtPathText = '';

    const normPunct = (s = '') =>
      s
        .trim()
        .toLowerCase()
        .replace(/（/g, '(')
        .replace(/）/g, ')')
        .replace(/：/g, ':')
        .replace(/\s+/g, ' ');

    for (const seg of segments) {
      const listing = await this.listDirectChildren(currentCid);
      const exact =
        listing.folders.find((f) => f.name === seg) ||
        listing.folders.find((f) => f.name.trim().toLowerCase() === seg.toLowerCase()) ||
        listing.folders.find((f) => normPunct(f.name) === normPunct(seg));

      if (!exact) {
        const fuzzy = listing.folders
          .filter((f) => f.name.toLowerCase().includes(seg.toLowerCase()))
          .map((f) => `${f.name} (id=${f.id})`);
        const hint =
          fuzzy.length > 0
            ? `相近候选目录: ${fuzzy.slice(0, 8).join(', ')}`
            : `当前层级可用子目录 (${listing.folders.length} 个): ${listing.folders
                .slice(0, 12)
                .map((f) => f.name)
                .join(', ')}`;
        throw new Error(
          `在 "${listing.fullPathText}" 下未找到精确匹配的子目录 "${seg}"。${hint}`
        );
      }

      currentCid = exact.id;
      lastListing = exact;
      builtPathText = listing.fullPathText
        ? `${listing.fullPathText} / ${exact.name}`
        : exact.name;
    }

    return {
      cid: currentCid,
      name: lastListing?.name || segments[segments.length - 1],
      fullPathText: builtPathText || lastListing?.name || String(currentCid),
    };
  }

  getRootDirId() {
    return '0';
  }

  /**
   * 幂等创建季度文件夹：已存在则直接返回现有 id；不存在则调用 ensureFolder 新建
   */
  async ensureSeasonFolders(rootCid, requiredSeasons, existingSeasonFoldersMap, onProgress = null) {
    const seasonCidMap = new Map();

    for (let i = 0; i < requiredSeasons.length; i += 1) {
      const s = requiredSeasons[i];
      const key = s.folderName.toLowerCase();
      if (existingSeasonFoldersMap && existingSeasonFoldersMap.has(key)) {
        const existing = existingSeasonFoldersMap.get(key);
        seasonCidMap.set(s.folderName, existing.id);
        onProgress?.(`复用已存在目录: ${s.folderName} (id=${existing.id})`);
        continue;
      }

      const res = await this.ensureFolder(rootCid, s.folderName);
      seasonCidMap.set(s.folderName, res.cid);
      onProgress?.(
        res.created
          ? `新建季度目录成功: ${s.folderName} (id=${res.cid})`
          : `检测到同名目录已存在并复用: ${s.folderName} (id=${res.cid})`
      );
      if (i + 1 < requiredSeasons.length) {
        await sleep(randomDelayMs(60, 120));
      }
    }

    return seasonCidMap;
  }

  /**
   * 自底向上按深度层级并发二次校验旧子文件夹是否 100% 为空，
   * 并将同父目录下的多个已验证空文件夹合并为单次批量回收站删除请求，大幅提升多子目录清理速率
   */
  async cleanVerifiedEmptySubfolders(scannedSubfolders = [], onProgress = null, { concurrency = 4 } = {}) {
    if (!scannedSubfolders || scannedSubfolders.length === 0) {
      return { deletedCount: 0, retainedNonEmptyCount: 0 };
    }

    const byDepth = new Map();
    for (const dir of scannedSubfolders) {
      const d = Number(dir.depth || 1);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(dir);
    }

    const depthsDesc = [...byDepth.keys()].sort((a, b) => b - a);
    let deletedCount = 0;
    let retainedNonEmptyCount = 0;

    for (const depth of depthsDesc) {
      const levelDirs = byDepth.get(depth);
      const verifiedEmptyDirs = [];

      // 同深度层级并发核验目录是否已完全腾空
      for (let i = 0; i < levelDirs.length; i += concurrency) {
        const batch = levelDirs.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (dir) => {
            let check = await this.listDirectChildren(dir.id);
            // 兼容夸克/百度等网盘批量移动后的短时最终一致性缓存延迟，若初次检测到非空则短暂等待后复检一次
            if (check.files.length > 0 || check.folders.length > 0) {
              await sleep(600);
              check = await this.listDirectChildren(dir.id);
            }
            if (check.files.length > 0 || check.folders.length > 0) {
              retainedNonEmptyCount += 1;
              onProgress?.(
                `保留非空旧目录: "${dir.relPath}" (剩余文件 ${check.files.length} 个, 子目录 ${check.folders.length} 个)`
              );
            } else {
              verifiedEmptyDirs.push(dir);
            }
          })
        );
      }

      if (verifiedEmptyDirs.length === 0) continue;

      // 按 parentId 聚合后一次性批量移入回收站
      const byParent = new Map();
      for (const dir of verifiedEmptyDirs) {
        const pid = String(dir.parentId ?? '');
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(dir);
      }

      for (const [parentId, siblingDirs] of byParent) {
        const ids = siblingDirs.map((d) => d.id);
        const delRes = await this.deleteItemsToRecycleBin(parentId, ids);
        if (!delRes?.state) {
          for (const d of siblingDirs) {
            onProgress?.(`清理空目录 "${d.relPath}" 未成功: ${delRes?.error || ''}`);
          }
        } else {
          deletedCount += siblingDirs.length;
          for (const d of siblingDirs) {
            onProgress?.(`已校验为空并清理旧目录: "${d.relPath}" (id=${d.id})`);
          }
        }
      }

      if (depthsDesc.length > 1) {
        await sleep(60);
      }
    }

    return { deletedCount, retainedNonEmptyCount };
  }

  /**
   * 默认压缩包云端检视（非 115 网盘若无原生无损云解压 API 则温和提示跳过，不中断整理流程）
   */
  async inspectArchiveSubtitles(archiveFile) {
    return {
      ok: false,
      error: `${this.driveLabel}暂不支持免下载云端预检压缩包 "${archiveFile?.name || ''}"，如需配对包内字幕请先在网盘内解压`,
      subtitleEntries: [],
      nestedArchiveEntries: [],
      relevantTopFiles: [],
      relevantTopDirs: [],
    };
  }

  async extractSubtitleArchives(archiveFiles = [], { onProgress = null } = {}) {
    const failedArchives = archiveFiles.map((arch) => ({
      name: arch.name,
      relativeDir: arch.relativeDir || '',
      error: `${this.driveLabel}暂不支持免会员自动云解压，请先在网盘内手动解压字幕包`,
    }));
    for (const f of failedArchives) {
      onProgress?.(`[提示] 跳过压缩包 "${f.name}": ${f.error}`);
    }
    return {
      unpackedCount: 0,
      skippedNonSubCount: 0,
      failedArchives,
      stagingCids: [],
    };
  }

  async reload115View(targetCid = null) {
    return await this.reloadView(targetCid);
  }

  resolveRenamedFolderId(oldId, _newFolderName) {
    return oldId;
  }
}
