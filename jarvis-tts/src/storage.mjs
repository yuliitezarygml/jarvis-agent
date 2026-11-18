import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const CAS = `local old=redis.call('GET',KEYS[1]); if (not old and ARGV[1]=='__absent__') or old==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 else return 0 end`;

/** Mutations are serialized locally or compared-and-swapped atomically across Vercel instances. */
export class StateStore {
  constructor(config, factory, { fetcher = fetch } = {}) {
    this.config = config;
    this.factory = factory;
    this.fetcher = fetcher;
    this.state = undefined;
    this.queue = Promise.resolve();
  }

  async redis(command) {
    const response = await this.fetcher(this.config.redisUrl, {
      method: 'POST', headers: { authorization: `Bearer ${this.config.redisToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Shared storage is unavailable');
    const result = await response.json();
    if (result.error) throw new Error('Shared storage command failed');
    return result.result;
  }

  async loadLocal() {
    if (this.state) return this.state;
    if (!this.config.dataFile) return (this.state = this.factory());
    try {
      const state = JSON.parse(await readFile(this.config.dataFile, 'utf8'));
      if (state.version !== 1 || !state.settings || !Array.isArray(state.keys)) throw new Error('Invalid persisted state');
      return (this.state = state);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return (this.state = this.factory());
    }
  }

  async update(mutator) {
    if (this.config.redisUrl) {
      const name = `${this.config.redisPrefix}:state`;
      for (let attempt = 0; attempt < 16; attempt++) {
        const previous = await this.redis(['GET', name]);
        const state = previous ? JSON.parse(previous) : this.factory();
        const value = mutator(state);
        if (await this.redis(['EVAL', CAS, 1, name, previous ?? '__absent__', JSON.stringify(state)])) return value;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, 5 * (attempt + 1))));
      }
      throw new Error('Shared storage is busy; retry shortly');
    }
    const run = async () => {
      const next = structuredClone(await this.loadLocal());
      const value = mutator(next);
      if (this.config.dataFile) {
        await mkdir(dirname(this.config.dataFile), { recursive: true, mode: 0o700 });
        const temporary = `${this.config.dataFile}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, this.config.dataFile);
      }
      this.state = next;
      return value;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async read() {
    if (this.config.redisUrl) {
      const raw = await this.redis(['GET', `${this.config.redisPrefix}:state`]);
      if (raw) return JSON.parse(raw);
      return this.update(state => structuredClone(state));
    }
    await this.queue;
    return structuredClone(await this.loadLocal());
  }
}

/** Audio cache is bounded in memory; Redis entries have their own expiration. */
export class AudioCache {
  constructor(config, store, clock = Date.now) {
    this.config = config; this.store = store; this.clock = clock;
    this.entries = new Map(); this.bytes = 0;
  }
  async get(key) {
    if (this.config.redisUrl) {
      const raw = await this.store.redis(['GET', `${this.config.redisPrefix}:audio:${key}`]);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      return { audio: Buffer.from(entry.audio, 'base64'), type: entry.type };
    }
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key); this.bytes -= entry.audio.length;
    if (entry.expires <= this.clock()) return null;
    this.entries.set(key, entry); this.bytes += entry.audio.length;
    return entry;
  }
  async put(key, audio, type) {
    if (audio.length > this.config.cacheEntryMaxBytes) return;
    if (this.config.redisUrl) {
      await this.store.redis(['SET', `${this.config.redisPrefix}:audio:${key}`, JSON.stringify({ audio: audio.toString('base64'), type }), 'EX', Math.ceil(this.config.cacheTtlMs / 1000)]);
      return;
    }
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.audio.length; this.entries.delete(key); }
    this.entries.set(key, { audio, type, expires: this.clock() + this.config.cacheTtlMs }); this.bytes += audio.length;
    while (this.bytes > this.config.cacheMaxBytes && this.entries.size) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).audio.length; this.entries.delete(oldest);
    }
  }
}
