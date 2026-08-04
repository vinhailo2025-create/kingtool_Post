const facebook = require('./runner.service');
const { PLATFORMS, normalizePlatform } = require('../platforms/platform.utils');

class RunnerManager {
  constructor() {
    this.runners = new Map(PLATFORMS.map(platform => [
      platform,
      platform === 'facebook' ? facebook : new facebook.RunnerService(platform),
    ]));
  }

  get(platform = 'facebook') {
    return this.runners.get(normalizePlatform(platform));
  }

  setDefaultBroadcast(fn) {
    for (const runner of this.runners.values()) runner.setDefaultBroadcast(fn);
  }

  getStatus() {
    return Object.fromEntries(
      [...this.runners].map(([platform, runner]) => [platform, runner.getStatus()])
    );
  }
}

module.exports = new RunnerManager();
