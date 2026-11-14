import { parseArgs } from 'node:util';
import {
  CdpManager,
  CdpPageSession,
  normalizeDriveType,
  validateCdpPort,
} from './cdp-client.mjs';
import { Cloud115Bridge } from './115-api.mjs';
import { BaiduDriveBridge } from './baidu-api.mjs';
import { QuarkDriveBridge } from './quark-api.mjs';

function createDriveBridge(driveType, session) {
  if (driveType === 'baidu') return new BaiduDriveBridge(session);
  if (driveType === 'quark') return new QuarkDriveBridge(session);
  return new Cloud115Bridge(session);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      cid: { type: 'string' },
      drive: { type: 'string', default: 'auto' },
      port: { type: 'string', default: '9222' },
      'clean-empty-dirs': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const targetCid = values.cid || positionals[0];
  if (!targetCid) {
    throw new Error('请传入待核验的目标文件夹标识 (如: node verify-result.mjs --cid "<cid/fid/path>")');
  }
  const cleanEmptyDirs = Boolean(values['clean-empty-dirs']);
  const cdp = new CdpManager(validateCdpPort(values.port || 9222));
  const requestedDrive = normalizeDriveType(values.drive);
  const { driveType, tab } = await cdp.findOrOpenDriveTab(requestedDrive);
  const session = new CdpPageSession(tab.webSocketDebuggerUrl);

  try {
    await session.connect();
    const bridge = createDriveBridge(driveType, session);

    const initial = await bridge.listDirectChildren(targetCid);
    const nonSeasonDirs = initial.folders
      .filter((f) => !/^(?:Season\s+\d+|Specials)$/i.test(f.name.trim()))
      .map((f) => ({ id: f.id, parentId: f.parentId, name: f.name, depth: 1, relPath: f.name }));

    if (cleanEmptyDirs && nonSeasonDirs.length > 0) {
      await bridge.cleanVerifiedEmptySubfolders(nonSeasonDirs, (msg) => console.log('[补清理]', msg));
    }

    const finalRoot = await bridge.listDirectChildren(targetCid);
    const sortedFolders = [...finalRoot.folders].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );

    console.log(`\n=== 最终目录核验 (${bridge.driveLabel}): ${finalRoot.fullPathText} ===`);
    console.log(`顶层子文件夹数: ${sortedFolders.length} | 顶层散落文件数: ${finalRoot.files.length}`);

    let grandTotalFiles = 0;
    for (const dir of sortedFolders) {
      const sub = await bridge.listDirectChildren(dir.id);
      const names = sub.files
        .map((x) => x.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      grandTotalFiles += names.length;
      console.log(
        `  ${dir.name.padEnd(11)} | 共 ${String(names.length).padStart(2)} 个文件 | 首尾: ${names[0] || '-'} ~ ${names[names.length - 1] || '-'}`
      );
    }
    console.log(`=== 核验总文件数: ${grandTotalFiles} ===`);

    await bridge.reloadView(targetCid);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
