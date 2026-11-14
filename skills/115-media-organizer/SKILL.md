---
name: 115-media-organizer
description: >-
  Organizes TV/anime seasons, re-classifies mismatched local arc/split-cour folders (e.g. 承/转/结, Part 1/2, multi-arc seasons) to match TMDB's official season structure, semantically matches Special/SP/OVA episodes against TMDB Season 0 episode titles & overview descriptions, batch-renames media files (100% compatible with UGREEN 绿联影视中心, ZSpace 极空间极影视, and fnOS 飞牛影视), decompresses subtitle archives (.zip, .rar, .7z, nested packs; 115 Cloud Drive only), extracts subtitles from multi-layer nested folders, and aligns external subtitle filenames (.ass, .srt, .ssa, .sup, .vtt) to match video files inside 115 Cloud Drive (115网盘), Baidu Netdisk (百度网盘), and Quark Cloud Drive (夸克网盘) via Chrome Remote Debugging Protocol (CDP). Supports standalone subtitle-to-video matching (--match-subs, for movies and existing TV folders without changing video names) as well as automatic TMDB search by show/movie name (--tmdb-query) and direct TMDB URLs. Use this skill whenever the user asks to unpack/extract/match/rename subtitles to videos, re-classify mismatched season/arc folders or Special (SP/OVA) episodes according to TMDB, organize into season folders, or batch-rename media in 115 Cloud Drive, Baidu Netdisk, or Quark Cloud Drive.
---

# Multi-Cloud Media Season Organizer & Subtitle Aligner (115 / Baidu / Quark + TMDB + Chrome CDP)

Automates core media organization workflows across **115 Cloud Drive (`115`, 115网盘)**, **Baidu Netdisk (`baidu`, 百度网盘)**, and **Quark Cloud Drive (`quark`, 夸克网盘)** without extracting, reading, or logging user cookies/tokens, producing standard directory & file structures 100% compatible with **绿联影视中心 (UGREEN)**, **极空间极影视 (ZSpace)**, and **飞牛影视 (fnOS)**:

1. **Standalone Subtitle Unpacking, Multi-Layer Extraction & Alignment (`--match-subs`)**: Automatically decompresses `.zip`/`.rar`/`.7z` subtitle archives (on 115 cloud decompression, including 2-pass nested archives), penetrates up to 8+ layers of nested folders (`外挂字幕/第二季/简体/ASS/...`), extracts `.ass`/`.srt`/`.ssa`/`.sup`/`.idx`/`.sub`/`.vtt` subtitles out into the exact same directory as their paired videos, and renames them to match the video base name so built-in cloud players and NAS/local players (绿联, 极空间, 飞牛, Infuse, VidHub, Emby, PotPlayer) auto-load subtitles 100%.
2. **TMDB Season Organization, Re-Classification & Special (Season 0) Semantic Matching (`--tmdb-query` / `--tmdb-url`)**: Searches TMDB by show/movie name (or direct URL), detects when local subfolders disagree with TMDB's season structure (e.g. split-cour folders like `无头骑士异闻录` / `×承` / `×转` / `×结`, `Part 1` / `Part 2`, multi-arc folders like `无限列车篇` + `游郭篇`, or wrongly split `Season 01..04`), re-classifies episodes & nested subtitles with exact TMDB season/episode offsets into standardized `Season 01` / `Season 02` / `Specials` folders, matches `SP`/`OVA`/`OAD` files against TMDB Season 0 episode titles AND plot overviews (`overview`), and cleans emptied legacy folders bottom-up.

## Mandatory Safety, Privacy & Operating Rules

1. **Zero Credential Exposure & Runtime Isolation (Open-Source Safe)**:
   - Never inspect, export, print, or persist cloud drive cookies/tokens (`UID`/`CID`/`SEID` on 115, `BDUSS`/`STOKEN` on Baidu, `__pus` on Quark) or `--archive-password`. All API requests execute inside the authenticated browser tab sandbox via `fetch(..., { credentials: 'include' })`.
   - Browser profile (`chrome-profile`) and rollback/dry-run snapshots (`snapshots`) are strictly isolated in the OS local app data directory (`%LOCALAPPDATA%\cloud-media-organizer` on Windows, `~/.cache/cloud-media-organizer` on macOS/Linux), never inside the skill code repository.
2. **直启浏览器交互登录（严禁截图扫码）**:
   - 凡遇网盘（115 / 百度 / 夸克）登录态失效或需要用户扫码时，**严禁截图二维码或向用户发送二维码图片工件**；
   - 必须直接弹出并置顶桌面 Chrome 浏览器窗口（`115.com` / `pan.baidu.com` / `pan.quark.cn`），让用户直接在浏览器页面中完成登录；
   - 登录完成后后台自动探测并无缝继续后续任务。
3. **TMDB Season 0 (`Specials` / `SP` / `OVA`) 5-Tier Semantic & Overview Matching**:
   - **Never Blindly Map `SP01 -> S00E01`**: Many anime/TV releases include only BD OVAs while TMDB Season 0 lists Recaps (`总集篇`), TV Specials, and OVAs in chronological order.
   - Whenever any `SP`/`OVA`/`OAD`/`Special`/`特别篇`/`番外`/`.5`/`S00Exx` file is detected, the organizer automatically fetches TMDB Season 0 full episode titles and plot descriptions (`overview`, with automatic `en-US` fallback when `zh-CN` has placeholder titles like `第 X 集` or empty overviews) and executes a 5-tier matcher:
     1. **Tier 0**: Explicit `--sp-map "SP01=S00E04,SP02=S00E09"` user mapping.
     2. **Tier 1**: Fractional `.5` episode number matching (`12.5`, `13.5`) in TMDB Season 0 titles/overviews.
     3. **Tier 2**: Descriptive keyword & CJK bigram scoring against TMDB Season 0 `title` + `overview` (e.g. `SP01 箱根温泉合宿.mkv` matches `S00E03` via overview text even if TMDB's title is `第 3 集`).
     4. **Tier 3**: Sub-type (`OVA` / `OAD` / `总集篇` / `Recap`) ordinal alignment when counts match.
     5. **Tier 4**: Count-consistency gate — only falls back to sequential `SP01 -> S00E01` when local special count matches TMDB Season 0 episode count (or `--trust-sp-num` is explicitly passed). Otherwise, marks the unverified pure-number `SP` file as pending confirmation and prints the **`【TMDB Season 0 官方特别篇目录与简介对照表】`** in Dry-Run.
4. **Cross-NAS Naming Compatibility (绿联 / 极空间 / 飞牛)**:
   - **Root Show/Movie Folder**: `片名（年份）` (e.g. `流人（2022）`, `流浪地球2（2023）`).
   - **Season Folders**: Standardized by default to `Season 01`, `Season 02`, `Specials` even when local folders trigger arc/cour reclassification (unless `--tmdb-season-names` is explicitly passed), preventing ZSpace (极空间) and fnOS (飞牛影视) from misidentifying custom Chinese season folder names as separate shows.
   - **Episode/Movie Filenames**: `{SeriesTitle}.{Year}.{SxxExx}.{ReleaseInfo}.<ext>` (e.g. `死亡笔记.Death.Note.2006.S01E01.BDrip.1080p.x265.mkv`), isolating `SxxExx` with dots so all three NAS scrapers parse 100% accurately.
5. **Strict Two-Phase Gate (Dry-Run First)**:
   - **Phase 1**: Always run Dry-Run first (omit `--execute`) and show the user the target drive & path, folder reclassification table (if triggered), Season 0 special matching details (or TMDB Season 0 reference table if any special is unverified), archive inspection results, and sample mappings.
   - **Phase 2**: Only pass `--execute` after the user confirms the Dry-Run plan.
6. **Automatic Ad & Junk File Purge (`--clean-ads`)**:
   - Accurately detects website promotional graphics (`.png`/`.jpg`), spam documents (`.doc`/`.txt`), and fake advertising video samples (< 5MB without episode tokens).
   - Moves them directly to the cloud drive's Recycle Bin (safe, non-destructive, restorable) to avoid cluttering folders and disrupting NAS scrapers.

## Standard Execution Workflows

*(Agent note: Resolve `<path-to-skill>/scripts/organizer.mjs` relative to where this `SKILL.md` is loaded.)*

### Workflow A: Multi-Drive Selection (`--drive auto|115|baidu|quark`)

- By default (`--drive auto`), `organizer.mjs` automatically detects the active cloud drive tab (`115.com`, `pan.baidu.com`, or `pan.quark.cn`) in Chrome.
- Pass `--drive 115`, `--drive baidu`, or `--drive quark` to explicitly target a specific cloud drive:
  ```powershell
  # 115网盘
  node "<path-to-skill>/scripts/organizer.mjs" --drive 115 --tmdb-query "无头骑士异闻录" --path "根目录/云下载/无头骑士异闻录"

  # 百度网盘
  node "<path-to-skill>/scripts/organizer.mjs" --drive baidu --tmdb-query "庆余年" --path "/影视/剧集/庆余年"

  # 夸克网盘
  node "<path-to-skill>/scripts/organizer.mjs" --drive quark --tmdb-query "葬送的芙莉莲" --path "全部文件/动漫/葬送的芙莉莲"
  ```

### Workflow B: Standalone Subtitle Unpack, Multi-Layer Extract & Video Alignment (`--match-subs`)

1. **Dry-Run Preview**:
   ```powershell
   node "<path-to-skill>/scripts/organizer.mjs" `
     --drive "<auto|115|baidu|quark>" `
     --match-subs `
     --path "<CLOUD_FOLDER_PATH>"
   ```
2. **Execute after User Approval**:
   ```powershell
   node "<path-to-skill>/scripts/organizer.mjs" `
     --drive "<auto|115|baidu|quark>" `
     --match-subs `
     --execute `
     --clean-empty-dirs `
     --cid "<CONFIRMED_ID_OR_PATH>"
   ```

### Workflow C: TMDB Show Season Organization, Special Matching & Batch Rename

1. **Dry-Run Preview**:
   ```powershell
   node "<path-to-skill>/scripts/organizer.mjs" `
     --drive "<auto|115|baidu|quark>" `
     --tmdb-query "<SHOW_NAME_OR_NAME_WITH_YEAR>" `
     --path "<CLOUD_FOLDER_PATH>"
   ```
2. **Execute & Read-Back Audit after User Approval**:
   ```powershell
   node "<path-to-skill>/scripts/organizer.mjs" `
     --drive "<auto|115|baidu|quark>" `
     --execute `
     --clean-empty-dirs `
     --tmdb-url "<CONFIRMED_TMDB_SEASONS_URL>" `
     --cid "<CONFIRMED_ID_OR_PATH>"

   node "<path-to-skill>/scripts/verify-result.mjs" --drive "<115|baidu|quark>" --cid "<CONFIRMED_ID_OR_PATH>"
   ```

### Workflow D: TMDB Movie Organization & Subtitle Alignment (`--type movie`)

1. **Dry-Run Preview**:
   ```powershell
   node "<path-to-skill>/scripts/organizer.mjs" `
     --drive "<auto|115|baidu|quark>" `
     --type movie `
     --tmdb-query "<MOVIE_NAME>" `
     --path "<CLOUD_FOLDER_PATH>"
   ```
2. **Execute after User Approval**:
   ```powershell
   node "<path-to-skill>/scripts/organizer.mjs" `
     --drive "<auto|115|baidu|quark>" `
     --type movie `
     --execute `
     --clean-empty-dirs `
     --rename-folder `
     --tmdb-query "<MOVIE_NAME>" `
     --cid "<CONFIRMED_ID_OR_PATH>"
   ```

## CLI & Naming Pattern Reference

| Parameter | Default | Description & Examples |
| :--- | :--- | :--- |
| `--drive` | `"auto"` | Target cloud drive: `auto`, `115` (115网盘), `baidu` (百度网盘), or `quark` (夸克网盘). |
| `--match-subs` | `false` | Standalone subtitle mode: unpacks subtitle archives (115), extracts from multi-layer folders, moves into video folder & aligns names. |
| `--dry-run` | automatic | Explicit read-only preview; cannot be combined with `--execute`. Omitting `--execute` also selects preview mode. |
| `--sp-map` | `""` | Explicit Special episode mapping override, e.g., `--sp-map "SP01=S00E04,SP02=S00E09"`. |
| `--trust-sp-num` | `false` | Forces sequential `SP01 -> S00E01` mapping even when filenames lack descriptive keywords and local SP count differs from TMDB Season 0 count. |
| `--max-depth` | `8` | Subfolder traversal depth for penetrating deeply nested subtitle/video folder structures. |
| `--archive-password` | `""` | Password for encrypted `.zip`/`.rar`/`.7z` subtitle archives during 115 cloud decompression (prefer `CLOUD_MEDIA_ARCHIVE_PASSWORD` env var to avoid CLI history exposure). |
| `--delete-archives` | `false` | Moves successfully unpacked original and nested subtitle archives to Recycle Bin (default keeps all archives). |
| `--no-extract-archives` | `false` | Disables automatic subtitle archive detection and cloud decompression. |
| `--clean-empty-dirs` | `false` | Verifies & cleans emptied legacy split-cour/arc folders and multi-layer subtitle dirs bottom-up (active target season folders are always protected). |
| `--clean-snapshots` | `false` | Deletes all local preview and rollback snapshot JSON files from the runtime cache directory. |
| `--tmdb-query` / `--query` | — | Show or movie name (with optional year), e.g., `"无头骑士异闻录"`, `"凡人修仙传 2020"`. |
| `--tmdb-search` | — | Standalone TMDB search & candidate inspection without accessing cloud drives. |
| `--tmdb-url` / `--url` | — | Direct TMDB TV or Movie URL (e.g., `https://www.themoviedb.org/tv/31798/seasons`). |
| `--tmdb-season-names` | `false` | Uses TMDB official season folder names (`{TmdbSeason}`) instead of NAS-universal `Season 01` / `Specials`. |
| `--pattern` | `"{Standard}"` | Standard NAS format: `"{SeriesTitle}.{Year}.{SxxExx}.{ReleaseInfo}"` for TV, `"{MovieTitle}.{Year}.{ReleaseInfo}"` for Movie. |
| `--season-pattern` | `"Season {Season}"` | Default `"Season {Season}"` (`Specials` for Season 0), ensuring 100% compatibility across 绿联, 极空间, and 飞牛影视. |
| `--offset` | Auto-inferred | Explicit integer episode shift (e.g. `--offset -220` when files are numbered `221~720`). |
| `--rollback` | — | `--rollback "<SNAPSHOT_JSON>"` restores original filenames and parent folders across 115, Baidu, and Quark. |
| `--type` / `--media-type` | `auto` | `movie` or `tv`. |
| `--rename-folder` | `false` | Renames the resource root folder to standard format `片名（年份）`. |
| `--folder-pattern` | `"{Title}（{Year}）"` | Resource root folder naming template. |
