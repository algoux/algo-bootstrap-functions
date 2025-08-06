const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const got = require('got');
const { logger } = require('../utils/logger');
const { downloadFile } = require('../utils/download');
const { uploadFileToCOS } = require('../utils/cos');
const ResourceIndexManager = require('../utils/res-index-mgr');

const PYTHON_BASE_PATH = 'algo-bootstrap/res/python';
const TARGET_PLATFORMS = ['win32-arm64', 'win32-x64'];

/**
 * 从 Python 官网获取最新版本信息
 * @returns {Promise<{ version: string, downloadUrls: Record<string, string> }>}
 */
async function getLatestPythonVersion() {
  logger.info('Fetching latest Python version from python.org');

  try {
    const { body } = await got('https://www.python.org/downloads/windows/', {
      responseType: 'text',
    });

    // 解析最新版本号 - 查找 "Python X.Y.Z" 模式，确保获取完整版本号
    const versionMatch = body.match(/Python ([\d]+\.[\d]+\.[\d]+)/);
    if (!versionMatch) {
      throw new Error('Could not find latest Python version on downloads page');
    }

    const version = versionMatch[1];
    logger.info(`Found latest Python version: ${version}`);

    const downloadUrls = {
      'win32-x64': `https://www.python.org/ftp/python/${version}/python-${version}-amd64.exe`,
      'win32-arm64': `https://www.python.org/ftp/python/${version}/python-${version}-arm64.exe`,
    };

    logger.info(`Generated download URLs: ${JSON.stringify(downloadUrls)}`);

    return { version, downloadUrls };
  } catch (error) {
    throw new Error(`Failed to get latest Python version: ${error.message}`);
  }
}

/**
 * 下载 Python 安装包
 * @param {string} url - 下载链接
 * @param {string} platform - 平台标识
 * @param {string} version - Python 版本
 * @param {string} saveDir - 保存目录
 * @returns {Promise<{ filePath: string, fileName: string }>}
 */
async function downloadPythonInstaller(url, platform, version, saveDir) {
  const saveDirResolved = path.resolve(saveDir);
  await fs.ensureDir(saveDirResolved);

  const fileName = `python-${version}-${platform}.exe`;
  const filePath = path.join(saveDirResolved, fileName);

  try {
    logger.info(`Downloading Python installer: ${url} -> ${filePath}`);
    await downloadFile(url, filePath);
    return { filePath, fileName };
  } catch (error) {
    throw new Error(`Failed to download Python installer for ${platform}: ${error.message}`);
  }
}

async function runPythonTask(args) {
  const tmpSaveDir = path.join(os.tmpdir(), 'ab-f-python');
  const successPlatforms = [];
  const failedPlatforms = [];
  let updates = 0;

  try {
    const { version, downloadUrls } = await getLatestPythonVersion();
    const rim = new ResourceIndexManager(PYTHON_BASE_PATH);
    await rim.load();

    for (const platform of TARGET_PLATFORMS) {
      try {
        logger.info(`Processing Python for platform: ${platform}`);

        const downloadUrl = downloadUrls[platform];
        if (!downloadUrl) {
          logger.warn(`No download URL found for platform: ${platform}`);
          failedPlatforms.push(platform);
          continue;
        }

        const resItem = rim.get(platform);
        if (resItem && resItem.version === version) {
          logger.info(`Skipping Python ${platform}, already up-to-date (version ${version}).`);
          continue;
        }

        const { filePath, fileName } = await downloadPythonInstaller(
          downloadUrl,
          platform,
          version,
          tmpSaveDir,
        );

        const cosDir = path.join(PYTHON_BASE_PATH, platform);
        const cosFilePath = path.join(cosDir, fileName);

        if (
          rim.update(
            platform,
            ResourceIndexManager.genIndexItemForFile(filePath, cosFilePath, version),
          )
        ) {
          await uploadFileToCOS(filePath, cosFilePath);
        }

        await fs.remove(filePath);
        successPlatforms.push(platform);
      } catch (error) {
        logger.error(`Failed to process Python for platform ${platform}:`, error);
        failedPlatforms.push(platform);
      }
    }

    updates += await rim.save();
  } catch (error) {
    logger.error('Failed to run Python task:', error);
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

module.exports = runPythonTask;
