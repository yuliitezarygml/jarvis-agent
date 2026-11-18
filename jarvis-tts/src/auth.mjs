import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'jarvis_admin';
const digest = value => createHash('sha256').update(value).digest();

export function correctPassword(config, password) {
  return typeof password === 'string' && Boolean(config.password) && timingSafeEqual(digest(config.password), digest(password));
}
const sign = (config, value) => createHmac('sha256', config.sessionSecret).update(value).digest('base64url');

export function sessionCookie(config, request, now, clear = false) {
  const payload = Buffer.from(JSON.stringify({ expires: now + 12 * 3600_000, password: digest(config.password).toString('hex') })).toString('base64url');
  const value = clear ? '' : `${payload}.${sign(config, payload)}`;
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 12 * 3600}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export function signedIn(config, request, now) {
  if (!config.password) return false;
  try {
    const cookie = (request.headers.get('cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`));
    if (!cookie) return false;
    const [payload, signature] = cookie.slice(COOKIE.length + 1).split('.');
    const expected = sign(config, payload);
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.expires > now && data.password === digest(config.password).toString('hex');
  } catch { return false; }
}
