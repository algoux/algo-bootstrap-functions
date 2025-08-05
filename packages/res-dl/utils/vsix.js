const fs = require('fs-extra');
const path = require('path');
const got = require('got');
const { logger } = require('./logger');

/**
 * 从 VSCode 市场下载指定扩展的 VSIX 文件
 * @param {string} extensionId - 扩展ID (如 "ms-vscode.cpptools")
 * @param {"alpine-x64" | "alpine-arm64" | "linux-armhf" | "linux-arm64" | "linux-x64" | "win32-arm64" | "win32-x64" | "darwin-arm64" | "darwin-x64" | "universal"} platform - 平台架构
 * @param {string|undefined} version - 版本号（可选传入完整版本号，如 "1.15.4"）
 * @param {string} saveDir - 保存目录
 */
async function downloadVsix(extensionId, platform, version = undefined, saveDir) {
  const [publisher, extensionName] = extensionId.split('.');
  if (!publisher || !extensionName) {
    throw new Error(`Invalid extension ID format: ${extensionId}`);
  }

  const targetVersion = version || (await getLatestVersionInfo(extensionId)).version;
  const downloadUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${extensionName}/${targetVersion}/vspackage${
    platform !== 'universal' ? `?targetPlatform=${platform}` : ''
  }`;
  // const downloadUrl = `https://${publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/${publisher}/extension/${extensionName}/${targetVersion}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage`;

  const saveDirResolved = path.resolve(saveDir);
  await fs.ensureDir(saveDirResolved);
  const fileName = `${extensionId}-${targetVersion}-${platform}.vsix`;
  const filePath = path.join(saveDirResolved, fileName);

  try {
    logger.info(
      `Downloading VSIX ${extensionId}@${targetVersion}-${platform} from: ${downloadUrl}`,
    );
    await downloadFile(downloadUrl, filePath);
    return { extensionId, publisher, extensionName, version: targetVersion, fileName, filePath };
  } catch (err) {
    throw new Error(
      `Failed to download VSIX (${extensionId}@${targetVersion}-${platform}): ${err.message}`,
    );
  }
}

/**
 * 获取指定扩展的最新版本信息
 * @param {string} extensionId - 扩展 ID (如 "ms-vscode.cpptools")
 * @param {Array<string>} [requiredPlatforms] - 可选的目标平台列表
 * @returns {Promise<{ version: string, platforms: Array<string> }>} 最新版本和支持的平台列表
 */
async function getLatestVersionInfo(extensionId, requiredPlatforms) {
  logger.info(`Fetching latest version for ${extensionId}`);
  // @see https://github.com/microsoft/vscode/blob/b43174e1b275850f5b80d170e47c1c04eb780790/src/vs/platform/extensionManagement/node/extensionGalleryService.ts#L94-L103
  const requestBody = {
    assetTypes: null,
    filters: [
      {
        criteria: [
          {
            filterType: 7,
            value: extensionId,
          },
        ],
        direction: 2,
        pageSize: 1,
        pageNumber: 1,
        sortBy: 0,
        sortOrder: 0,
        pagingToken: null,
      },
    ],
    flags: 2151,
  };

  try {
    const { body } = await got.post(
      'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json;api-version=7.2-preview.1;excludeUrls=true',
        },
        body: JSON.stringify(requestBody),
        responseType: 'json',
      },
    );

    if (!body.results?.[0]?.extensions?.[0]?.versions?.[0]?.version) {
      throw new Error('No version information found in marketplace response');
    }

    const version = body.results[0].extensions[0].versions[0].version;
    const platforms = body.results[0].extensions[0].versions
      .filter(
        (v) =>
          v.version === version &&
          (!v.targetPlatform ||
            !requiredPlatforms?.length ||
            requiredPlatforms.includes(v.targetPlatform)),
      )
      .map((v) => v.targetPlatform || 'universal');

    return { version, platforms };
  } catch (err) {
    throw new Error(`Marketplace API request failed: ${err.message}`);
  }
}

async function downloadFile(url, filePath) {
  try {
    const downloadStream = got.stream(url);
    const fileWriterStream = fs.createWriteStream(filePath);

    downloadStream.pipe(fileWriterStream);

    return new Promise((resolve, reject) => {
      fileWriterStream.on('error', reject);
      downloadStream.on('error', reject);
      fileWriterStream.on('finish', resolve);
    });
  } catch (err) {
    await fs.unlink(filePath).catch(() => {});
    throw err;
  }
}

module.exports = {
  downloadVsix,
  getLatestVersionInfo,
};
