// Minimal in-memory fixed-window rate limiter. The app runs as a single
// container, so process memory is a sufficient store.
const buckets = new Map();

export function rateLimit({ windowMs, max, key, message }) {
  return (req, res, next) => {
    const k = key(req);
    if (!k) return next();

    const now = Date.now();
    let bucket = buckets.get(k);
    if (!bucket || now >= bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(k, bucket);
    }
    bucket.count++;

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

export function resetRateLimit(key) {
  buckets.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, bucket] of buckets) {
    if (now >= bucket.reset) buckets.delete(k);
  }
}, 60_000).unref();

export const loginKey = (email) => `login:${String(email || '').trim().toLowerCase()}`;

// Brute-force protection per account.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  key: (req) => (req.body?.email ? loginKey(req.body.email) : null),
  message: 'Too many login attempts. Please wait 15 minutes and try again.'
});

// Caps AI spend per user (each call hits Claude and/or Gemini).
export const aiLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 40,
  key: (req) => (req.userId ? `ai:${req.userId}` : null),
  message: 'AI generation limit reached. Please wait a few minutes and try again.'
});
