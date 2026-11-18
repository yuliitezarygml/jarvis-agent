import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  clientReqPerMin: 20,
  ipReqPerMin: 100,
  maxTextLength: 800,
  cacheMaxChars: 160,
  model: 's2.1-pro-free',
  voiceRu: '680d74fbef69419f87cfc70f092a1451',
  voiceEn: '14129c3e320149449d6bada6862f7338',
  notice: ''
});

export function loadConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const redisUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  if (Boolean(redisUrl) !== Boolean(redisToken)) throw new Error('Both Redis REST URL and token are required');
  if (redisUrl && !/^https:\/\//.test(redisUrl)) throw new Error('Redis REST URL must use HTTPS');
  if (env.VERCEL && !redisUrl) throw new Error('Configure shared Redis REST storage before deploying to Vercel');
  const password = env.ADMIN_PASSWORD || '';
  const sessionSecret = env.ADMIN_SESSION_SECRET || createHash('sha256').update(`jarvis-admin-session:${password}`).digest('hex');
  const latency = env.FISH_LATENCY || 'balanced';
  if (!['normal', 'balanced', 'low'].includes(latency)) throw new Error('Invalid FISH_LATENCY');
  return {
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 3000, 0, 65535),
    password, sessionSecret, redisUrl, redisToken,
    redisPrefix: env.REDIS_PREFIX || 'jarvis-tts',
    dataFile: resolve(env.DATA_FILE || '.data/state.json'),
    trustProxy: Boolean(env.VERCEL) || env.TRUST_PROXY === 'true',
    concurrency: integer('FISH_KEY_CONCURRENCY', 2, 1, 20),
    timeoutMs: integer('FISH_TIMEOUT_MS', 45000, 100, 55000),
    latency,
    upstreamUrl: 'https://api.fish.audio/v1/tts',
    cacheTtlMs: 24 * 3600_000,
    cacheMaxBytes: 16 * 1024 * 1024,
    cacheEntryMaxBytes: 512 * 1024,
    settings: {
      ...DEFAULT_SETTINGS,
      model: env.FISH_MODEL || DEFAULT_SETTINGS.model,
      voiceRu: env.FISH_VOICE_RU || DEFAULT_SETTINGS.voiceRu,
      voiceEn: env.FISH_VOICE_EN || DEFAULT_SETTINGS.voiceEn
    },
    seedKeys: (env.FISH_API_KEYS || env.FISH_API_KEY || '').split(/[\n,;]+/).map(key => key.trim()).filter(Boolean)
  };
}

export const keyId = key => createHash('sha256').update(key).digest('hex').slice(0, 20);

export function initialState(config) {
  return {
    version: 1, settings: { ...config.settings },
    keys: [...new Set(config.seedKeys)].map((key, i) => ({
      id: keyId(key), key, label: `Key ${i + 1}`, enabled: true, status: 'active',
      cooldownUntil: 0, lastError: '', lastUsed: 0, leases: {}
    })),
    blocked: [], stats: {}, errors: [], rates: {}, loginRates: {}
  };
}
