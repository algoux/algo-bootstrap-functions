const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const got = require('got');
const { logger } = require('../utils/logger');
const { downloadFile } = require('../utils/download');
const { uploadFileToCOS } = require('../utils/cos');
const ResourceIndexManager = require('../utils/res-index-mgr');

const RES_BASE_PATH = 'algo-bootstrap/res';
const VSCODE_BASE_PATH = `${RES_BASE_PATH}/vscode`;
const TARGET_PLATFORMS = ['win32-arm64', 'win32-x64', 'darwin-arm64', 'darwin-x64'];

/**
 * 从 VSCode 官方 API 获取最新版本信息
 * @returns {Promise<{ version: string, downloadUrls: Record<string, string> }>}
 */
async function getLatestVSCodeVersion() {
  logger.info('Fetching latest VSCode version from official API');

  try {
    // 使用 VSCode 的官方 API 获取最新版本信息
    const apiEndpoints = {
      'win32-x64': 'https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest',
      'win32-arm64':
        'https://update.code.visualstudio.com/api/update/win32-arm64-user/stable/latest',
      'darwin-x64': 'https://update.code.visualstudio.com/api/update/darwin/stable/latest',
      'darwin-arm64': 'https://update.code.visualstudio.com/api/update/darwin-arm64/stable/latest',
    };

    const downloadUrls = {};
    let version = null;

    // 获取所有平台的下载信息
    for (const [platform, endpoint] of Object.entries(apiEndpoints)) {
      try {
        const { body } = await got(endpoint, {
          responseType: 'json',
        });

        if (!version) {
          version = body.productVersion;
          logger.info(`Found latest VSCode version: ${version}`);
        }

        downloadUrls[platform] = body.url;
        logger.info(`Found download URL for ${platform}: ${body.url}`);
      } catch (error) {
        logger.error(`Failed to get download info for ${platform}: ${error.message}`);
        throw error;
      }
    }

    logger.info(`Generated download URLs: ${JSON.stringify(downloadUrls)}`);

    return { version, downloadUrls };
  } catch (error) {
    throw new Error(`Failed to get latest VSCode version: ${error.message}`);
  }
}

/**
 * 下载 VSCode 安装包
 * @param {string} url - 下载链接
 * @param {string} platform - 平台标识
 * @param {string} version - VSCode 版本
 * @param {string} saveDir - 保存目录
 * @returns {Promise<{ filePath: string, fileName: string }>}
 */
async function downloadVSCodeInstaller(url, platform, version, saveDir) {
  const saveDirResolved = path.resolve(saveDir);
  await fs.ensureDir(saveDirResolved);

  const extension = platform.startsWith('win32') ? '.exe' : '.zip';
  const fileName = `VSCode-${version}-${platform}${extension}`;
  const filePath = path.join(saveDirResolved, fileName);

  try {
    logger.info(`Downloading VSCode installer: ${url} -> ${filePath}`);
    await downloadFile(url, filePath);
    return { filePath, fileName };
  } catch (error) {
    throw new Error(`Failed to download VSCode installer for ${platform}: ${error.message}`);
  }
}

async function runVSCodeTask(args) {
  const tmpSaveDir = path.join(os.tmpdir(), 'ab-f-vscode');
  const successPlatforms = [];
  const failedPlatforms = [];
  let updates = 0;

  try {
    const { version, downloadUrls } = await getLatestVSCodeVersion();
    const rim = new ResourceIndexManager(VSCODE_BASE_PATH);
    await rim.load();

    for (const platform of TARGET_PLATFORMS) {
      try {
        logger.info(`Processing VSCode for platform: ${platform}`);

        const downloadUrl = downloadUrls[platform];
        if (!downloadUrl) {
          logger.warn(`No download URL found for platform: ${platform}`);
          failedPlatforms.push(platform);
          continue;
        }

        const resItem = rim.get(platform);
        if (resItem && resItem.version === version) {
          logger.info(`Skipping VSCode ${platform}, already up-to-date (version ${version}).`);
          continue;
        }

        const { filePath, fileName } = await downloadVSCodeInstaller(
          downloadUrl,
          platform,
          version,
          tmpSaveDir,
        );

        const cosDir = path.join(VSCODE_BASE_PATH, platform);
        const cosFilePath = path.join(cosDir, fileName);

        if (
          rim.update(
            platform,
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
        successPlatforms.push(platform);
      } catch (error) {
        logger.error(`Failed to process VSCode for platform ${platform}:`, error);
        failedPlatforms.push(platform);
      }
    }

    updates += await rim.save();
  } catch (error) {
    logger.error('Failed to run VSCode task:', error);
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

module.exports = runVSCodeTask;
