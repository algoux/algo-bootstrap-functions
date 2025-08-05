const fs = require('fs-extra');
const COS = require('cos-nodejs-sdk-v5');
const { logger } = require('./logger');

const TIMEOUT = 5 * 60 * 1000;

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
  Domain: process.env.COS_DOMAIN,
  Timeout: TIMEOUT,
});

async function uploadFileToCOS(filePathOrBuffer, remoteFilePath) {
  if (!filePathOrBuffer || !remoteFilePath) {
    throw new Error('Invalid COS upload parameters');
  }
  if (!process.env.COS_BUCKET || !process.env.COS_REGION) {
    throw new Error('COS upload options must include bucket and region');
  }
  if (Buffer.isBuffer(filePathOrBuffer)) {
    logger.info(
      `Uploading buffer to COS: cos://${remoteFilePath} (${filePathOrBuffer.length} bytes)`,
    );
    return await cos.putObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: remoteFilePath,
      Body: filePathOrBuffer,
    });
  }
  logger.info(
    `Uploading file to COS: ${filePathOrBuffer} -> cos://${remoteFilePath} (${
      fs.statSync(filePathOrBuffer).size
    } bytes)`,
  );
  return await cos.uploadFile({
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION,
    Key: remoteFilePath,
    FilePath: filePathOrBuffer,
  });
}

async function getFileContentFromCOS(remoteFilePath) {
  if (!process.env.COS_BUCKET || !process.env.COS_REGION) {
    throw new Error('COS get file content options must include bucket and region');
  }
  logger.info(`Fetching file content from COS: cos://${remoteFilePath}`);
  return (
    await cos.getObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: remoteFilePath,
    })
  ).Body;
}

module.exports = {
  uploadFileToCOS,
  getFileContentFromCOS,
};
