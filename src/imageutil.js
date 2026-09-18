import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

/** Parse a `data:<mime>;base64,<data>` URI. Returns null for anything else. */
export function parseDataUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const meta = uri.slice(5, comma);
  if (!meta.endsWith(';base64')) return null;
  return {
    mime: meta.slice(0, -';base64'.length) || 'application/octet-stream',
    buffer: Buffer.from(uri.slice(comma + 1), 'base64')
  };
}

/**
 * Convert an image buffer to JPEG. Pure JS (no native deps) so it builds on any
 * host. Supports PNG input; JPEG is returned unchanged. Returns null for
 * formats we cannot decode (webp, svg, ...).
 */
export function toJpeg(buffer, mime, quality = 88) {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return buffer;
  if (mime !== 'image/png') return null;

  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  // JPEG has no alpha channel: flatten transparent pixels onto white.
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 255) {
      const f = a / 255;
      data[i] = Math.round(data[i] * f + 255 * (1 - f));
      data[i + 1] = Math.round(data[i + 1] * f + 255 * (1 - f));
      data[i + 2] = Math.round(data[i + 2] * f + 255 * (1 - f));
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, quality).data;
}

/**
 * Re-encode a PNG data URI as JPEG when that makes it smaller (it usually does
 * for photos). Any failure returns the original URI untouched. Instagram gets
 * a JPEG either way via /api/media/...&format=jpg.
 */
export function compressDataUri(uri) {
  try {
    const parsed = parseDataUri(uri);
    if (!parsed || parsed.mime !== 'image/png') return uri;
    const jpg = toJpeg(parsed.buffer, parsed.mime);
    if (!jpg || jpg.length >= parsed.buffer.length) return uri;
    return `data:image/jpeg;base64,${Buffer.from(jpg).toString('base64')}`;
  } catch (err) {
    console.warn('Image compression skipped:', err.message);
    return uri;
  }
}
