// Central place for environment-derived settings. index.js imports
// 'dotenv/config' before anything else, so process.env is populated by the
// time this module is evaluated.

export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('✗ JWT_SECRET is not set. Add it to your environment / .env file.');
  process.exit(1);
}

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

export const META_API_VERSION = process.env.META_API_VERSION || 'v23.0';
export const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

const trimSlash = (url) => (url || '').trim().replace(/\/+$/, '');

// Public URL of this backend (used for Meta OAuth callbacks and for giving
// Meta a public URL to fetch images from).
export function appUrl() {
  return trimSlash(process.env.APP_URL);
}

// Frontend origin. On DigitalOcean the frontend and backend share one domain,
// so APP_URL is a safe fallback.
export function clientUrl() {
  return trimSlash((process.env.CLIENT_URL || '').split(',')[0]) || appUrl();
}
