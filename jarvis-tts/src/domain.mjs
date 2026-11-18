import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, keyId } from './config.mjs';

export class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

export function prune(state, now) {
  for (const key of state.keys) for (const [id, until] of Object.entries(key.leases)) if (until <= now) delete key.leases[id];
  for (const field of ['rates', 'loginRates']) for (const [id, rate] of Object.entries(state[field])) if (rate.until <= now) delete state[field][id];
  const days = Object.keys(state.stats).sort().reverse();
  for (const day of days.slice(7)) delete state.stats[day];
}

export function dayStats(state, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return (state.stats[day] ??= { day, requests: 0, chars: 0, cacheHits: 0, errors: 0, clients: {} });
}

export function checkTraffic(state, client, ip, now) {
  prune(state, now);
  if (!state.settings.enabled) throw new HttpError(503, state.settings.notice || 'Voice server is paused');
  if (state.blocked.includes(`client:${client}`) || state.blocked.includes(`ip:${ip}`)) throw new HttpError(403, 'Access blocked');
  const limits = [[`client:${client}`, state.settings.clientReqPerMin], [`ip:${ip}`, state.settings.ipReqPerMin]];
  for (const [id, maximum] of limits) {
    const rate = state.rates[id];
    if (rate && rate.count >= maximum) throw new HttpError(429, 'Too many requests. Please try again shortly.', { 'retry-after': String(Math.max(1, Math.ceil((rate.until - now) / 1000))) });
  }
  if (Object.keys(state.rates).length > 20000) throw new HttpError(503, 'Voice server is busy');
  for (const [id] of limits) {
    state.rates[id] ??= { count: 0, until: now + 60000 };
    state.rates[id].count++;
  }
  const stats = dayStats(state, now);
  stats.requests++;
  if (stats.clients[client] || Object.keys(stats.clients).length < 10000) {
    stats.clients[client] ??= { requests: 0, chars: 0 };
    stats.clients[client].requests++;
  }
  return { ...state.settings };
}

export function validateSpeech(body, settings) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON body');
  if (typeof body.text !== 'string') throw new HttpError(400, body.text == null ? 'Empty text' : 'Text must be a string');
  const text = body.text.trim();
  if (!text) throw new HttpError(400, 'Empty text');
  if (text.length > settings.maxTextLength) throw new HttpError(413, `Text is longer than ${settings.maxTextLength} characters`);
  const lang = body.lang ?? (/[а-яё]/i.test(text) ? 'ru' : 'en');
  if (!['ru', 'en'].includes(lang)) throw new HttpError(400, 'Unsupported language. Use ru or en');
  const format = body.format ?? 'mp3';
  if (!['mp3', 'wav', 'pcm', 'opus'].includes(format)) throw new HttpError(400, 'Unsupported audio format');
  if (body.speed != null && (typeof body.speed !== 'number' || !Number.isFinite(body.speed))) throw new HttpError(400, 'Speed must be a finite number');
  return { text, lang, format, speed: Math.min(1.6, Math.max(0.6, body.speed ?? 1)) };
}

export function leaseKey(state, config, excluded, now) {
  prune(state, now);
  const key = state.keys.filter(key => key.enabled && key.cooldownUntil <= now && !excluded.has(key.id) && Object.keys(key.leases).length < config.concurrency)
    .sort((a, b) => Object.keys(a.leases).length - Object.keys(b.leases).length || a.lastUsed - b.lastUsed || a.id.localeCompare(b.id))[0];
  if (!key) return null;
  const lease = randomUUID();
  key.leases[lease] = now + config.timeoutMs + 10000;
  key.lastUsed = now;
  return { id: key.id, secret: key.key, lease };
}

export function releaseKey(state, lease) {
  const key = state.keys.find(key => key.id === lease.id);
  if (key) delete key.leases[lease.lease];
}

export function keyFailure(state, lease, status, retryAfter, now) {
  releaseKey(state, lease);
  const key = state.keys.find(key => key.id === lease.id);
  if (!key) return;
  if (status === 401 || status === 403) { key.enabled = false; key.status = 'invalid'; }
  else key.cooldownUntil = now + (status === 402 ? 24 * 3600_000 : status === 429 ? retryAfter : 30000);
  key.lastError = `Fish Audio HTTP ${status || 'connection error'}`;
}

export function finishRequest(state, client, characters, cached, error, now) {
  const stats = dayStats(state, now);
  if (error) {
    stats.errors++;
    state.errors.unshift({ at: now, msg: error });
    state.errors = state.errors.slice(0, 100);
  } else {
    stats.chars += characters;
    if (cached) stats.cacheHits++;
    if (stats.clients[client]) stats.clients[client].chars += characters;
  }
}

export function adminState(state, config, now) {
  prune(state, now);
  const stats = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
    const { clients: _clients, ...rest } = state.stats[day] || { day, requests: 0, chars: 0, cacheHits: 0, errors: 0 };
    return rest;
  });
  const today = state.stats[new Date(now).toISOString().slice(0, 10)];
  return {
    settings: { ...state.settings }, concurrency: config.concurrency,
    keys: state.keys.map(({ key, leases, ...rest }) => ({ ...rest, key: key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••••••', busy: Object.keys(leases).length })),
    stats, errors: state.errors.slice(0, 100), blocked: [...state.blocked],
    activeClientsToday: Object.keys(today?.clients || {}).length,
    topClients: Object.entries(today?.clients || {}).map(([client, values]) => ({ client, ...values })).sort((a, b) => b.chars - a.chars).slice(0, 20)
  };
}

export function patchSettings(state, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid settings');
  const ranges = { clientReqPerMin: [1, 1000], ipReqPerMin: [1, 10000], maxTextLength: [1, 35000], cacheMaxChars: [0, 2000] };
  const patch = {};
  for (const [field, value] of Object.entries(input)) {
    if (!(field in DEFAULT_SETTINGS)) throw new HttpError(400, `Unknown setting: ${field}`);
    if (field === 'enabled') {
      if (typeof value !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
      patch[field] = value;
    } else if (ranges[field]) {
      const n = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
      const [min, max] = ranges[field];
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Invalid ${field}: expected ${min}..${max}`);
      patch[field] = n;
    } else {
      if (typeof value !== 'string' || value.length > (field === 'notice' ? 500 : 128) || field !== 'notice' && !value.trim()) throw new HttpError(400, `Invalid ${field}`);
      patch[field] = value.trim();
    }
  }
  Object.assign(state.settings, patch);
}

export function addKeys(state, raw) {
  if (typeof raw !== 'string' || raw.length > 50000) throw new HttpError(400, 'keys must be a string');
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (state.keys.length + lines.length > 100) throw new HttpError(400, 'At most 100 keys are supported');
  const results = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    const label = colon > 0 ? line.slice(0, colon).trim().slice(0, 100) : `Key ${state.keys.length + 1}`;
    const secret = (colon > 0 ? line.slice(colon + 1) : line).trim();
    if (!secret || /\s/.test(secret) || secret.length > 512) { results.push(`Skipped ${label}: invalid key format`); continue; }
    const id = keyId(secret);
    if (state.keys.some(key => key.id === id)) { results.push(`Skipped ${label}: already added`); continue; }
    state.keys.push({ id, key: secret, label, enabled: true, status: 'active', cooldownUntil: 0, lastError: '', lastUsed: 0, leases: {} });
    results.push(`Added ${label}`);
  }
  return results;
}
