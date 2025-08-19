const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const got = require('got');
const { logger } = require('../utils/logger');
const { downloadFile } = require('../utils/download');
const { uploadFileToCOS } = require('../utils/cos');
const ResourceIndexManager = require('../utils/res-index-mgr');

const RES_BASE_PATH = 'algo-bootstrap/res';
const C_CPP_BASE_PATH = `${RES_BASE_PATH}/c_cpp`;

/**
 * 从 GitHub API 获取最新版本信息
 * @param {string} repo - 仓库名称 (格式: "owner/repo")
 * @returns {Promise<{ version: string, downloadUrl: string }>}
 */
async function getLatestRelease(repo) {
  logger.info(`Fetching latest release from ${repo}`);

  try {
    const { body } = await got(`https://api.github.com/repos/${repo}/releases/latest`, {
      responseType: 'json',
    });

    const tagName = body.tag_name;
    const name = body.name;
    logger.info(`Found latest release of ${repo}: ${tagName} (${name})`);

    return { tagName, name, releaseData: body };
  } catch (error) {
    throw new Error(`Failed to get latest release from ${repo}: ${error.message}`);
  }
}

/**
 * 获取 MinGW-w64 的下载信息
 * @returns {Promise<{ version: string, downloadUrl: string }>}
 */
async function getMinGWForWin32X64DownloadInfo() {
  const { name, releaseData } = await getLatestRelease('niXman/mingw-builds-binaries');
  const version = name.match(/(\d+\.\d+\.\d+)/)[1];
  if (!version) {
    throw new Error(`Failed to parse version from release name: ${name}`);
  }

  const asset = releaseData.assets.find(
    (asset) => asset.name.includes('x86_64') && asset.name.includes('seh-ucrt'),
  );

  if (!asset) {
    throw new Error(`No seh-ucrt asset found in release ${version}`);
  }

  return {
    version,
    downloadUrl: asset.browser_download_url,
    fileName: asset.name,
  };
}

/**
 * 获取 LLVM-MinGW 的下载信息
 * @returns {Promise<{ version: string, downloadUrl: string }>}
 */
async function getLLVMMinGWForWin32Arm64DownloadInfo() {
  const { name, releaseData } = await getLatestRelease('mstorsjo/llvm-mingw');
  const version = name.match(/LLVM (\d+\.\d+\.\d+)/)[1];
  const asset = releaseData.assets.find((asset) => asset.name.includes('ucrt-aarch64'));

  if (!version) {
    throw new Error(`Failed to parse version from release name: ${name}`);
  }

  if (!asset) {
    throw new Error(`No ucrt-aarch64 asset found in release ${version}`);
  }

  return {
    version,
    downloadUrl: asset.browser_download_url,
    fileName: asset.name,
  };
}

/**
 * 下载 C/C++ 编译器
 * @param {string} url - 下载链接
 * @param {string} fileName - 文件名
 * @param {string} saveDir - 保存目录
 * @returns {Promise<{ filePath: string, fileName: string }>}
 */
async function downloadCppCompiler(url, fileName, saveDir) {
  const saveDirResolved = path.resolve(saveDir);
  await fs.ensureDir(saveDirResolved);

  const filePath = path.join(saveDirResolved, fileName);

  try {
    logger.info(`Downloading C/C++ compiler: ${url} -> ${filePath}`);
    await downloadFile(url, filePath);
    return { filePath, fileName };
  } catch (error) {
    throw new Error(`Failed to download C/C++ compiler: ${error.message}`);
  }
}

async function runCppTask(args) {
  const tmpSaveDir = path.join(os.tmpdir(), 'ab-f-c_cpp');
  const successPlatforms = [];
  const failedPlatforms = [];
  let updates = 0;

  try {
    const rim = new ResourceIndexManager(C_CPP_BASE_PATH);
    await rim.load();

    // win32-x64 (MinGW-w64)
    try {
      logger.info('Processing C/C++ compiler for platform: win32-x64');

      const { version, downloadUrl, fileName } = await getMinGWForWin32X64DownloadInfo();

      const resItem = rim.get('win32-x64');
      if (resItem && resItem.version === version) {
        logger.info(`Skipping win32-x64, already up-to-date (version ${version}).`);
      } else {
        const { filePath } = await downloadCppCompiler(downloadUrl, fileName, tmpSaveDir);

        const cosDir = path.join(C_CPP_BASE_PATH, 'win32-x64');
        const cosFilePath = path.join(cosDir, fileName);

        if (
          rim.update(
            'win32-x64',
            ResourceIndexManager.genIndexItemForFile(
              filePath,
              path.relative(RES_BASE_PATH, cosFilePath),
              version,
            ),
          )
        ) {
          await uploadFileToCOS(filePath, cosFilePath);
        }

        await fs.remove(filePath);
      }

      successPlatforms.push('win32-x64');
    } catch (error) {
      logger.error('Failed to process C/C++ compiler for platform win32-x64:', error);
      failedPlatforms.push('win32-x64');
    }

    // win32-arm64 (LLVM-MinGW)
    try {
      logger.info('Processing C/C++ compiler for platform: win32-arm64');

      const { version, downloadUrl, fileName } = await getLLVMMinGWForWin32Arm64DownloadInfo();

      const resItem = rim.get('win32-arm64');
      if (resItem && resItem.version === version) {
        logger.info(`Skipping win32-arm64, already up-to-date (version ${version}).`);
      } else {
        const { filePath } = await downloadCppCompiler(downloadUrl, fileName, tmpSaveDir);

        const cosDir = path.join(C_CPP_BASE_PATH, 'win32-arm64');
        const cosFilePath = path.join(cosDir, fileName);

        if (
          rim.update(
            'win32-arm64',
            ResourceIndexManager.genIndexItemForFile(
              filePath,
              path.relative(RES_BASE_PATH, cosFilePath),
              version,
            ),
          )
        ) {
          await uploadFileToCOS(filePath, cosFilePath);
        }

        await fs.remove(filePath);
      }

      successPlatforms.push('win32-arm64');
    } catch (error) {
      logger.error('Failed to process C/C++ compiler for platform win32-arm64:', error);
      failedPlatforms.push('win32-arm64');
    }

    updates += await rim.save();
  } catch (error) {
    logger.error('Failed to run C/C++ task:', error);
    throw error;
  }

  logger.info(
    `${successPlatforms.length} succeeded, ${failedPlatforms.length} failed, ${updates} updated.`,
  );
  if (failedPlatforms.length > 0) {
    logger.warn(`Failed platforms: ${failedPlatforms.join(', ')}`);
  }

  return {
    successPlatforms,
    failedPlatforms,
    updates,
  };
}

module.exports = runCppTask;
