/**
 * Serializes platform actions per physical Chrome profile.
 * Due comments use a higher priority than posts that are waiting to start.
 * Actions for different profiles remain independent and may run concurrently.
 */
class ProfileActionQueue {
  constructor() {
    this.queues = new Map();
    this.sequence = 0;
  }

  run(profileId, type, task, priority = 0) {
    const key = String(profileId);
    if (!this.queues.has(key)) {
      this.queues.set(key, { active: false, items: [] });
    }
    const queue = this.queues.get(key);

    return new Promise((resolve, reject) => {
      queue.items.push({
        type,
        task,
        priority: Number(priority) || 0,
        sequence: this.sequence++,
        resolve,
        reject,
      });
      this._pump(key);
    });
  }

  hasPending(profileId, type = null) {
    const queue = this.queues.get(String(profileId));
    if (!queue) return false;
    if (!type) return queue.active || queue.items.length > 0;
    return queue.items.some(item => item.type === type);
  }

  getSnapshot(profileId) {
    const queue = this.queues.get(String(profileId));
    if (!queue) return { active: false, waiting: [] };
    return {
      active: queue.active,
      waiting: queue.items.map(item => ({
        type: item.type,
        priority: item.priority,
        sequence: item.sequence,
      })),
    };
  }

  async _pump(key) {
    const queue = this.queues.get(key);
    if (!queue || queue.active) return;
    if (queue.items.length === 0) {
      this.queues.delete(key);
      return;
    }

    queue.active = true;
    queue.items.sort((a, b) => (b.priority - a.priority) || (a.sequence - b.sequence));
    const item = queue.items.shift();

    try {
      item.resolve(await item.task());
    } catch (error) {
      item.reject(error);
    } finally {
      queue.active = false;
      if (queue.items.length === 0) this.queues.delete(key);
      else this._pump(key);
    }
  }
}

const singleton = new ProfileActionQueue();
singleton.ProfileActionQueue = ProfileActionQueue;

module.exports = singleton;
