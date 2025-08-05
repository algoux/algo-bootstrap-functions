const { moment } = require('./datetime');

const logger = {
  info: (...args) => {
    console.info(`${moment().format('YYYY-MM-DD HH:mm:ss.SSS')} [INFO] `, ...args);
  },
  warn: (...args) => {
    console.warn(`${moment().format('YYYY-MM-DD HH:mm:ss.SSS')} [WARN] `, ...args);
  },
  error: (...args) => {
    console.error(`${moment().format('YYYY-MM-DD HH:mm:ss.SSS')} [ERROR]`, ...args);
  },
};

module.exports = {
  logger,
};
