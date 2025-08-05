function getScfArgs(event) {
  if (!event) {
    return {};
  }
  if (event.Type === 'Timer') {
    let args = {};
    try {
      args = JSON.parse(event.Message);
    } catch (e) {}
    return args;
  }
  return event;
}

module.exports = {
  getScfArgs,
};
