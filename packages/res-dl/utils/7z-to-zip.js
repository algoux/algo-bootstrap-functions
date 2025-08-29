'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const execa = require('execa');
const builtin7za = require('../lib/7zip-bin').path7za;
const { logger } = require('./logger');

const DEBUG = process.env.CONVERT_7Z_ZIP_DEBUG === '1';
// const DEBUG = true;
const log = (...a) => {
  if (DEBUG) console.error('[convert7zToZip]', ...a);
};

const platformArch = `${process.platform}-${process.arch}`;
const coreNum = os.cpus().length;
logger.info(`coreNum: ${coreNum}, platformArch: ${platformArch}`);

const CANDIDATE_DIRS = [
  process.env.CONVERT_7Z_BIN_DIR,
  path.join(process.cwd(), 'bin'),
  path.join(process.cwd(), 'vendors'),
].filter(Boolean);

const CANDIDATE_NAMES = [
  `7zzs-${platformArch}`,
  '7zzs',
  `7zz-${platformArch}`,
  '7zz',
  `7z-${platformArch}`,
  '7z',
  `7za-${platformArch}`,
  '7za',
];

const toPosix = (p) => p.split(path.sep).join('/');

async function ensureExecutable(file) {
  try {
    await fsp.chmod(file, 0o755);
  } catch {}
}

function isP7zip16(out) {
  return /p7zip Version 16\.02/i.test(out || '');
}

async function tryCmd(bin, args = ['-version']) {
  try {
    const r = await execa(bin, args, { reject: false, all: true });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const ok = /(7-?Zip|p7zip)/i.test(out);
    return { ok, exitCode: r.exitCode, out };
  } catch (e) {
    // ENOENT: 文件不存在；ENOEXEC/Exec format error：架构或 C 库不兼容
    return { ok: false, error: e, code: e && e.code };
  }
}

async function resolveFromDirs() {
  for (const dir of CANDIDATE_DIRS) {
    for (const name of CANDIDATE_NAMES) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) {
        await ensureExecutable(full);
        const t = await tryCmd(full, ['-version']);
        if (t.ok) return { bin: full, version: t.out };
        log(`候选 ${full} 不可用：${(t.out || t.error || '').toString().slice(0, 120)}`);
      }
    }
  }
  return null;
}

async function resolveFromPath() {
  // 再尝试 PATH（某些运行环境仍会提供 7zz/7z/7za）
  for (const name of CANDIDATE_NAMES) {
    const t = await tryCmd(name, ['-version']);
    if (t.ok) return { bin: name, version: t.out };
  }
  return null;
}

async function pick7zBinary() {
  // 1) 精确路径优先
  if (process.env.CONVERT_7Z_BIN) {
    const p = process.env.CONVERT_7Z_BIN;
    await ensureExecutable(p);
    const t = await tryCmd(p, ['-version']);
    if (t.ok) return { bin: p, version: t.out };
    log(`CONVERT_7Z_BIN 指向的二进制不可用：${p}`);
  }

  // 2) 在自带目录查找（返回**完整路径**）
  const fromDirs = await resolveFromDirs();
  if (fromDirs) return fromDirs;

  // 3) 尝试 PATH
  const fromPath = await resolveFromPath();
  if (fromPath) return fromPath;

  // 4) 兜底用 7zip-bin 的 7za
  const t = await tryCmd(builtin7za, ['-version']);
  return { bin: builtin7za, version: t.out || '' };
}

async function run(bin, args, opts = {}) {
  logger.info('RUN>', bin, args.join(' '), opts.cwd ? `(cwd=${opts.cwd})` : '');
  const r = await execa(bin, args, { reject: false, all: true, ...opts });
  const all = `${r.stdout || ''}\n${r.stderr || ''}`;
  logger.info('exitCode=', r.exitCode);
  if (all.trim()) log('output>\n' + all.trim());
  return { ...r, all };
}

function detectPassword(all) {
  const s = (all || '').toString();
  return (
    /Wrong password|Enter password|Encrypted\s*=\s*\+/i.test(s) ||
    (/Headers Error/i.test(s) && /password|encrypt/i.test(s)) ||
    (/Data Error/i.test(s) && /password/i.test(s)) ||
    /Can not open encrypted archive/i.test(s)
  );
}

async function probe(sevenZipBin, filePath) {
  const { exitCode, all } = await run(sevenZipBin, ['l', '-slt', filePath]);
  const looksInvalid =
    /Can not open file as archive/i.test(all) ||
    ((/Errors:\s*\d+/i.test(all) || /Warnings:\s*\d+/i.test(all)) && exitCode !== 0);
  const isType7z = /Type\s*=\s*7z/i.test(all);
  const isEncrypted = detectPassword(all);
  const mFiles = all.match(/^\s*Files\s*=\s*(\d+)/im);
  const mFolders = all.match(/^\s*Folders\s*=\s*(\d+)/im);
  const fileCount = mFiles ? parseInt(mFiles[1], 10) : undefined;
  const folderCount = mFolders ? parseInt(mFolders[1], 10) : undefined;
  log('--- PROBE ---');
  log(
    'isType7z=',
    isType7z,
    'isEncrypted=',
    isEncrypted,
    'looksInvalid=',
    looksInvalid,
    'files=',
    fileCount,
    'folders=',
    folderCount,
  );
  return { exitCode, all, isType7z, looksInvalid, isEncrypted, fileCount, folderCount };
}

async function listAllRelativeEntries(rootDir) {
  const entries = [];
  async function walk(rel) {
    const abs = path.join(rootDir, rel);
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) {
      if (rel !== '') entries.push(toPosix(rel) + '/'); // 保留空目录
      const names = await fsp.readdir(abs);
      for (const n of names) await walk(path.join(rel, n));
    } else {
      entries.push(toPosix(rel));
    }
  }
  await walk('');
  return entries;
}

async function addZipWith7z(sevenZipBin, outZip, entries, cwd) {
  logger.info('addZipWith7z to:', outZip);
  const mmtArg = `-mmt=${coreNum}`; // 多线程：按逻辑核数
  let base = ['a', '-tzip', '-mx=7', mmtArg]; // 先用并行
  const timeArgs = ['-mtm=on', '-mtc=on', '-mta=on']; // 时间戳参数（老版本可能不支持）

  // 1) 带时间戳 + 多线程
  let args = [...base, ...timeArgs, outZip, ...entries];
  let r = await run(sevenZipBin, args, { cwd });

  // 2) 老 7z 不支持时间戳参数：去掉时间戳，仍保留多线程
  if (r.exitCode !== 0 && /E_INVALIDARG|Unsupported switch|Incorrect command line/i.test(r.all)) {
    args = [...base, outZip, ...entries];
    r = await run(sevenZipBin, args, { cwd });
  }

  // 3) 极旧 7z 不支持 -mmt：去掉并行参数再试
  if (r.exitCode !== 0 && /Unsupported switch/i.test(r.all) && /-mmt/i.test(r.all)) {
    base = ['a', '-tzip', '-mx=9']; // 无 -mmt
    args = [...base, outZip, ...entries];
    r = await run(sevenZipBin, args, { cwd });
  }

  if (r.exitCode !== 0) {
    throw new Error(`打包 zip 失败（exitCode=${r.exitCode}）\n${r.all}`);
  }
}

async function verifyZip(sevenZipBin, outZip) {
  const { all } = await run(sevenZipBin, ['l', '-slt', outZip]);
  const mFiles = all.match(/^\s*Files\s*=\s*(\d+)/im);
  const mFolders = all.match(/^\s*Folders\s*=\s*(\d+)/im);
  const files = mFiles ? parseInt(mFiles[1], 10) : 0;
  const folders = mFolders ? parseInt(mFolders[1], 10) : 0;
  log('--- VERIFY ZIP --- files=', files, 'folders=', folders);
  return { files, folders };
}

async function extractWith7z(sevenZipBin, filePath, outDir, versionOut) {
  logger.info('extracting 7z to workDir:', outDir);
  const r = await run(sevenZipBin, ['x', filePath, `-o${outDir}`, '-y', '-bd']);
  if (r.exitCode !== 0) {
    if (/E_FAIL/i.test(r.all) && isP7zip16(versionOut)) {
      throw new Error(
        `检测到 p7zip 16.02 在解压阶段 E_FAIL。请提供官方 7-Zip 的 7zz（如 7zz-${platformArch}），` +
          `放入脚本目录的 .bin/vendor/vendors 等候选目录，或用 CONVERT_7Z_BIN 指定。\n` +
          `原始输出：\n${r.all}`,
      );
    }
    throw new Error(r.all || `7z 解压失败 exitCode=${r.exitCode}`);
  }
}

/**
 * 将 .7z 转为 .zip
 * @param {string} filePath 输入 7z 路径
 * @param {string} [outputPath] 输出 zip 路径（未给则同名同目录）
 * @returns {Promise<string>} 生成的 zip 路径
 */
async function convert7zToZip(filePath, outputPath) {
  const _start = Date.now();
  log('Node', process.version, process.platform, process.arch);

  // 选择 7z 可执行文件（返回**完整路径**或 PATH 命令名）
  let { bin: sevenZipBin, version } = await pick7zBinary();
  logger.info('using 7z candidate:', sevenZipBin);
  if (version) logger.info('7z version>\n' + version.trim());

  // 1) 基础校验
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('filePath 不能为空');
  const st = await fsp.stat(filePath).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`找不到文件：${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.7z') throw new Error('仅支持 .7z 文件');

  // 2) 探测有效性/加密
  const pr = await probe(sevenZipBin, filePath);
  log('probe result:', pr);
  if (pr.isEncrypted) throw new Error('该 7z 压缩包已加密或需要密码，当前不支持处理。');
  if (!pr.isType7z || pr.looksInvalid || pr.exitCode !== 0) {
    throw new Error('不是有效的 7z 文件或已损坏。');
  }

  // 3) 输出路径
  let outZip = outputPath;
  if (!outZip) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ext);
    outZip = path.join(dir, `${base}.zip`);
  } else if (path.extname(outZip).toLowerCase() !== '.zip') {
    outZip = outZip + '.zip';
  }
  logger.info('output zip:', outZip);

  // 4) 临时目录
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'conv-7z-zip-'));
  const workDir = path.join(tmpRoot, 'w');
  await fsp.mkdir(workDir, { recursive: true });
  logger.info('workDir:', workDir);

  try {
    // 5) 解压（仅用 7z；若是 p7zip 16.02 可能 E_FAIL，会提示换 7zz）
    await extractWith7z(sevenZipBin, filePath, workDir, version);

    // 6) 收集条目（显式列举，含空目录）
    const entries = await listAllRelativeEntries(workDir);
    logger.info(`entries found: ${entries.length}`);
    if (entries.length) {
      const preview = entries.slice(0, 40);
      log(
        'entries preview:\n' +
          preview.map((e) => '  ' + e).join('\n') +
          (entries.length > preview.length ? `\n  ...(+${entries.length - preview.length})` : ''),
      );
    } else {
      log('警告：工作目录为空！(probe.files=' + (pr.fileCount ?? 'unknown') + ')');
    }

    // 7) 打包 zip（用 7z）
    logger.info(`creating zip with ${entries.length} entries`);
    if (entries.length === 0) {
      // 真·空包：占位后再删，得到空 zip
      const placeholder = '.zip_empty_placeholder';
      await fsp.writeFile(path.join(workDir, placeholder), '');
      await addZipWith7z(sevenZipBin, outZip, [placeholder], workDir);
      await run(sevenZipBin, ['d', outZip, placeholder]); // 忽略返回码
    } else {
      await addZipWith7z(sevenZipBin, outZip, entries, workDir);
    }

    // 8) 校验
    logger.info('verifying zip:', outZip);
    await verifyZip(sevenZipBin, outZip);
    const zst = await fsp.stat(outZip).catch(() => null);
    if (!zst || !zst.isFile()) throw new Error('生成 zip 失败（未找到输出文件）');

    logger.info('convert7zToZip finished in', Date.now() - _start, 'ms');
    return outZip;
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { convert7zToZip };

if (require.main === module) {
  (async () => {
    const inPath = process.argv[2];
    const outPath = process.argv[3];
    if (!inPath) {
      console.error('用法: node convert7zToZip.js <input.7z> [output.zip]');
      process.exit(1);
    }
    try {
      const out = await convert7zToZip(inPath, outPath);
      logger.info('转换成功 ->', out);
    } catch (err) {
      console.error('转换失败：', err && err.message ? err.message : err);
      process.exit(2);
    }
  })();
}
