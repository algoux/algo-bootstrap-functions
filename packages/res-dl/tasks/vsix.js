const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const { logger } = require('../utils/logger');
const { downloadVsix, getLatestVersionInfo } = require('../utils/vsix');
const { uploadFileToCOS } = require('../utils/cos');
const ResourceIndexManager = require('../utils/res-index-mgr');

const VSIX_BASE_PATH = 'algo-bootstrap/res/vsix';
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
      logger.info(`Fetched ${id}: version ${version}, platforms: ${platforms.join(', ')}`);
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
            ResourceIndexManager.genIndexItemForFile(filePath, cosFilePath, version),
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
