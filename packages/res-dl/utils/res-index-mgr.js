const path = require('path');
const md5File = require('md5-file');
const { logger } = require('./logger');
const { moment } = require('./datetime');
const { uploadFileToCOS, getFileContentFromCOS } = require('./cos');

/**
 * @typedef {Object} ResourceIndexItem
 * @property {string} version - Version of the resource
 * @property {string} path - Relative path in COS
 * @property {string} md5 - MD5 hash of the resource
 * @property {string} updatedAt - Last updated timestamp in ISO 8601 format
 */

class ResourceIndexManager {
  static genIndexItemForFile(filePath, remotePath, version) {
    return {
      version,
      path: remotePath,
      md5: md5File.sync(filePath),
      updatedAt: moment().toISOString(true),
    };
  }

  /** @type {Record<string, ResourceIndexItem>} */
  index;

  updates = 0;

  /**
   * @param {string} basePath - Base path for the resource index
   */
  constructor(basePath) {
    /** @type {string} */
    this.basePath = basePath;
  }

  /**
   * Get the remote relative path to the index.json file
   * @returns {string} The index file path
   */
  get indexPath() {
    return path.join(this.basePath, 'index.json');
  }

  /**
   * Load index from remote
   * @returns {Promise<Record<string, ResourceIndexItem>>} The loaded index
   */
  async load() {
    try {
      const content = await getFileContentFromCOS(this.indexPath);
      this.index = JSON.parse(content.toString('utf-8'));
      return this.index;
    } catch (err) {
      if (err.code === 'NoSuchKey') {
        logger.info(
          `[ResourceIndexManager] index not found at ${this.indexPath}, initializing empty index.`,
        );
        this.index = {};
        return this.index;
      }
      logger.error(`[ResourceIndexManager] Failed to load index ${this.indexPath}:`, err);
      throw err;
    }
  }

  /**
   * Save index to remote
   * @returns {Promise<void>}
   */
  async save() {
    if (!this.index) {
      throw new Error(`Resource index must be loaded before saving.`);
    }
    if (this.updates === 0) {
      logger.info(`[ResourceIndexManager] No updates to save, skipping.`);
      return this.updates;
    }
    const content = JSON.stringify(this.index, null, 2);
    logger.info(`[ResourceIndexManager] Saving index ${this.indexPath}: ${content}`);
    await uploadFileToCOS(Buffer.from(content), this.indexPath);
    const updates = this.updates;
    this.updates = 0;
    return updates;
  }

  /**
   * Check if the resource needs to be updated
   * @param {string} key
   * @param {ResourceIndexItem} data
   * @returns {boolean} True if the resource item needs to be updated, false otherwise
   */
  hasUpdate(key, data) {
    if (!this.index) {
      throw new Error(`Resource index must be loaded before checking updates.`);
    }
    if (!this.index[key]) {
      return true;
    }
    return this.index[key].version !== data.version || this.index[key].md5 !== data.md5;
  }

  /**
   * Get an item from the index
   * @param {string} key
   * @returns {ResourceIndexItem} The resource index item
   */
  get(key) {
    if (!this.index) {
      throw new Error(`Resource index must be loaded before getting items`);
    }
    return this.index[key];
  }

  /**
   * Update an existing resource in the index
   * @param {string} key
   * @param {ResourceIndexItem} data
   * @return {boolean} True if the index was updated, false if no changes were made
   */
  update(key, data) {
    if (!this.index) {
      throw new Error(`Resource index must be loaded before updating items`);
    }
    if (this.hasUpdate(key, data)) {
      logger.info(
        `[ResourceIndexManager] Update key ${key}: ${JSON.stringify(
          this.index[key],
        )} -> ${JSON.stringify(data)}`,
      );
      this.index[key] = data;
      this.updates++;
      return true;
    }
    return false;
  }
}

module.exports = ResourceIndexManager;
