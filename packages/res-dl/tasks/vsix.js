const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const got = require('got');
const { logger } = require('../utils/logger');
const { downloadFile } = require('../utils/download');
const { uploadFileToCOS } = require('../utils/cos');
const ResourceIndexManager = require('../utils/res-index-mgr');

const RES_BASE_PATH = 'algo-bootstrap/res';
const VSIX_BASE_PATH = `${RES_BASE_PATH}/vsix`;
const COMM_PLATFORMS = ['win32-arm64', 'win32-x64', 'darwin-arm64', 'darwin-x64'];
const vsixList = [
  { id: 'divyanshuagrawal.competitive-programming-helper' },
  { id: 'editorconfig.editorconfig' },
  { id: 'formulahendry.code-runner' },
  { id: 'ms-ceintl.vscode-language-pack-zh-hans' },
  { id: 'ms-python.debugpy' },
  { id: 'ms-python.python' },
  { id: 'ms-python.vscode-pylance' },
  { id: 'ms-python.vscode-python-envs' },
  { id: 'ms-vscode.cpptools' },
  { id: 'qiumingge.cpp-check-lint' },
  { id: 'streetsidesoftware.code-spell-checker' },
  { id: 'usernamehw.errorlens' },
  { id: 'vadimcn.vscode-lldb' },
];

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
  // @see https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts
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
    flags: 2167,
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

    if (!body.results?.[0]?.extensions?.[0]?.versions) {
      throw new Error('No version information found in marketplace response');
    }

    const latestReleaseVersion = body.results[0].extensions[0].versions.find(
      (v) =>
        !v.properties.some(
          (p) => p.key === 'Microsoft.VisualStudio.Code.PreRelease' && p.value === 'true',
        ),
    );
    if (!latestReleaseVersion) {
      throw new Error('No release version found in marketplace response');
    }

    const platforms = body.results[0].extensions[0].versions
      .filter(
        (v) =>
          v.version === latestReleaseVersion.version &&
          (!v.targetPlatform ||
            !requiredPlatforms?.length ||
            requiredPlatforms.includes(v.targetPlatform)),
      )
      .map((v) => v.targetPlatform || 'universal');

    return { version: latestReleaseVersion.version, platforms };
  } catch (err) {
    throw new Error(`Marketplace API request failed: ${err.message}`);
  }
}

async function runVsixTask(args) {
  const tmpSaveDir = path.join(os.tmpdir(), 'ab-f-vsix');
  const successIds = [];
  const failedIds = [];
  let updates = 0;

  for (const vsix of vsixList) {
    const { id } = vsix;
    try {
      logger.info(`Processing: ${id}`);
      const basePath = path.join(VSIX_BASE_PATH, id);
      const rim = new ResourceIndexManager(basePath);
      await rim.load();
      const { version, platforms } = await getLatestVersionInfo(id, COMM_PLATFORMS);
      logger.info(`Fetched ${id}: version ${version}, platforms: [${platforms.join(', ')}]`);
      if (platforms.length === 0) {
        logger.warn(`No platforms found for ${id}, skipping.`);
        continue;
      }
      for (const platform of platforms) {
        const resItem = rim.get(platform);
        if (resItem && resItem.version === version) {
          logger.info(`Skipping ${id}-${platform}, already up-to-date.`);
          continue;
        }
        const { filePath, fileName } = await downloadVsix(id, platform, version, tmpSaveDir);
        const cosDir = path.join(basePath, platform);
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
      }
      updates += await rim.save();
      successIds.push(id);
    } catch (error) {
      logger.error(`Failed to process extension ${id}:`, error);
      failedIds.push(id);
    }
  }

  logger.info(`${successIds.length} succeeded, ${failedIds.length} failed, ${updates} updated.`);
  if (failedIds.length > 0) {
    logger.warn(`Failed extensions: ${failedIds.join(', ')}`);
  }

  return {
    successIds,
    failedIds,
    updates,
  };
}

module.exports = runVsixTask;
