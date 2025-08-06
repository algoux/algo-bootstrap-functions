'use strict';
const { logger } = require('./utils/logger');
const { getScfArgs } = require('./utils/args');

exports.main_handler = async (event, context) => {
  logger.info('event:', event);
  const args = getScfArgs(event);
  logger.info('args:', args);
  const { type } = args;
  switch (type) {
    case 'vsix': {
      const runVsixTask = require('./tasks/vsix');
      return await runVsixTask(args);
    }
    case 'python': {
      const runPythonTask = require('./tasks/python');
      return await runPythonTask(args);
    }
    case 'c_cpp': {
      const runCppTask = require('./tasks/c_cpp');
      return await runCppTask(args);
    }
    default:
      throw new Error(`Unknown task type: ${type}`);
  }
};
