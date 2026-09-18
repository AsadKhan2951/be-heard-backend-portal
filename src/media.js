import { Content, GeneratedImage, Brand } from './models/index.js';
import { parseDataUri, toJpeg } from './imageutil.js';
import { appUrl } from './config.js';

// Images are stored inline (base64 data URIs) in MongoDB. Instead of shipping
// megabytes of base64 in every list response, API responses carry a short
// /api/media/... URL and this public endpoint streams the binary. The ids are
// random UUIDs, and a public URL is also what Meta needs to fetch images for
// publishing.
const SOURCES = {
  content: { model: Content, field: 'image_url' },
  creative: { model: GeneratedImage, field: 'image_url' },
  logo: { model: Brand, field: 'logo_url' }
};

/** URL for a stored image; non-data URLs (e.g. https://...) pass through. */
export function mediaUrl(kind, id, value) {
  if (typeof value !== 'string' || !value) return value || null;
  if (!value.startsWith('data:')) return value;
  return `/api/media/${kind}/${id}?v=${value.length}`;
}

/**
 * Aggregation expression doing the same as mediaUrl() inside MongoDB, so list
 * queries never transfer the base64 payload.
 */
export function mediaUrlExpr(kind, field = 'image_url') {
  const f = `$${field}`;
  return {
    $cond: [
      { $eq: [{ $substrCP: [{ $ifNull: [f, ''] }, 0, 5] }, 'data:'] },
      { $concat: [`/api/media/${kind}/`, '$id', '?v=', { $toString: { $strLenCP: f } }] },
      f
    ]
  };
}

/** Absolute, publicly fetchable image URL (for Meta). JPEG when requested. */
export function publicImageUrl(kind, doc, field = 'image_url', { jpg = false } = {}) {
  const value = doc?.[field];
  if (!value) return null;
  if (!value.startsWith('data:')) return value;
  const base = appUrl();
  if (!base) throw new Error('APP_URL is not configured on the server, so Meta cannot fetch the image.');
  return `${base}${mediaUrl(kind, doc.id, value)}${jpg ? '&format=jpg' : ''}`;
}

// GET /api/media/:kind/:id  (public)
export async function serveMedia(req, res) {
  try {
    const source = SOURCES[req.params.kind];
    if (!source) return res.status(404).end();

    const doc = await source.model.findOne({ id: req.params.id }).select(`${source.field} -_id`).lean();
    const value = doc?.[source.field];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return res.redirect(value);

    const parsed = parseDataUri(value);
    if (!parsed) return res.status(404).end();

    let { mime, buffer } = parsed;
    if (req.query.format === 'jpg' && mime !== 'image/jpeg') {
      const jpg = toJpeg(buffer, mime);
      if (jpg) {
        buffer = Buffer.from(jpg);
        mime = 'image/jpeg';
      }
    }

    res.set({
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // Uploaded SVGs must never run scripts on our origin.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    });
    res.send(buffer);
  } catch (err) {
    console.error('Serve media error:', err);
    res.status(500).end();
  }
}
