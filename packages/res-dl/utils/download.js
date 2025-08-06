const fs = require('fs-extra');
const got = require('got');

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
  downloadFile,
};
