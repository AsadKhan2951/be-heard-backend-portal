import axios from 'axios';
import { Content, Brand } from './models/index.js';
import { META_GRAPH_URL } from './config.js';
import { publicImageUrl } from './media.js';
import { isValidDate } from './utils.js';
import { fetchPostMetrics } from './analytics.js';

// Only these platforms can be published to automatically.
export const META_PLATFORMS = ['instagram', 'facebook', 'both'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function firstVersion(body) {
  if (Array.isArray(body)) return String(body[0] || '');
  return String(body || '');
}

function buildCaption(content) {
  const hashtags = (content.hashtags || []).join(' ');
  return hashtags ? `${firstVersion(content.body)}\n\n${hashtags}` : firstVersion(content.body);
}

function metaError(err) {
  return err.response?.data?.error?.message || err.message;
}

export function brandMetaStatus(brand) {
  return {
    facebook: !!(brand?.meta_page_id && brand?.meta_page_token),
    instagram: !!(brand?.meta_ig_account_id && brand?.meta_page_token)
  };
}

async function publishToInstagram(content, brand) {
  if (!brandMetaStatus(brand).instagram) {
    throw new Error('Instagram is not connected for this brand. Connect it in Brand Settings.');
  }
  // Instagram only accepts JPEG images fetched from a public URL.
  const imageUrl = publicImageUrl('content', content, 'image_url', { jpg: true });
  if (!imageUrl) throw new Error('Instagram posts need an image. Generate one first.');

  const container = await axios.post(`${META_GRAPH_URL}/${brand.meta_ig_account_id}/media`, {
    image_url: imageUrl,
    caption: buildCaption(content),
    access_token: brand.meta_page_token
  });
  const creationId = container.data.id;

  // Wait for Instagram to finish processing the image before publishing.
  for (let i = 0; i < 10; i++) {
    const status = await axios.get(`${META_GRAPH_URL}/${creationId}`, {
      params: { fields: 'status_code', access_token: brand.meta_page_token }
    });
    const code = status.data.status_code;
    if (code === 'FINISHED' || !code) break;
    if (code === 'ERROR' || code === 'EXPIRED') throw new Error(`Instagram could not process the image (${code})`);
    await sleep(2000);
  }

  const published = await axios.post(`${META_GRAPH_URL}/${brand.meta_ig_account_id}/media_publish`, {
    creation_id: creationId,
    access_token: brand.meta_page_token
  });
  return published.data.id;
}

async function publishToFacebook(content, brand) {
  if (!brandMetaStatus(brand).facebook) {
    throw new Error('Facebook is not connected for this brand. Connect it in Brand Settings.');
  }
  const caption = buildCaption(content);
  const imageUrl = publicImageUrl('content', content);

  if (imageUrl) {
    const response = await axios.post(`${META_GRAPH_URL}/${brand.meta_page_id}/photos`, {
      url: imageUrl,
      caption,
      access_token: brand.meta_page_token
    });
    return response.data.post_id || response.data.id;
  }

  const response = await axios.post(`${META_GRAPH_URL}/${brand.meta_page_id}/feed`, {
    message: caption,
    access_token: brand.meta_page_token
  });
  return response.data.id;
}

/**
 * Publish content to one platform (or both) and record the result.
 * Throws with a user-readable message on failure.
 */
async function publishNow(content, brand, platform) {
  if (!META_PLATFORMS.includes(platform)) {
    throw new Error('Direct publishing is only available for Instagram and Facebook. Copy this post and publish it manually.');
  }

  const targets = platform === 'both' ? ['instagram', 'facebook'] : [platform];
  const postIds = { ...(content.meta_post_ids || {}) };
  const errors = [];

  for (const target of targets) {
    try {
      postIds[target] = target === 'instagram'
        ? await publishToInstagram(content, brand)
        : await publishToFacebook(content, brand);
    } catch (err) {
      errors.push(`${target}: ${metaError(err)}`);
    }
  }

  const published = targets.filter(t => postIds[t] && postIds[t] !== content.meta_post_ids?.[t]);
  if (published.length === 0) {
    throw new Error(errors.join(' | '));
  }

  await Content.updateOne(
    { id: content.id },
    {
      $set: {
        status: 'published',
        published_at: new Date(),
        meta_post_ids: postIds,
        meta_post_id: postIds[published[0]],
        ...(errors.length ? { publish_error: errors.join(' | ') } : {})
      },
      ...(errors.length ? {} : { $unset: { publish_error: '' } })
    }
  );
  return { postIds, errors };
}

// POST /api/content/:contentId/publish   body: { platform }
export async function publishContent(req, res) {
  try {
    const contentId = req.params.contentId || req.body.contentId;
    const content = await Content.findOne({ id: contentId, user_id: req.userId }).lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    if (content.status === 'published' || content.status === 'publishing') {
      return res.status(400).json({ error: `This content is already ${content.status}` });
    }

    const brand = await Brand.findOne({ id: content.brand_id }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const platform = req.body.platform || content.platform;
    const { postIds, errors } = await publishNow(content, brand, platform);
    res.json({ success: true, platform, postIds, warnings: errors });
  } catch (err) {
    console.error('Publish error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to publish' });
  }
}

// POST /api/content/:contentId/schedule   body: { scheduledFor }
export async function scheduleContent(req, res) {
  try {
    const contentId = req.params.contentId || req.body.contentId;
    const scheduledFor = new Date(req.body.scheduledFor);
    if (!isValidDate(scheduledFor)) {
      return res.status(400).json({ error: 'Please pick a valid date and time' });
    }
    if (scheduledFor.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' });
    }

    const content = await Content.findOne({ id: contentId, user_id: req.userId }).lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    if (content.status === 'published') {
      return res.status(400).json({ error: 'This content is already published' });
    }
    if (!META_PLATFORMS.includes(content.platform)) {
      return res.status(400).json({ error: 'Auto-publishing is only available for Instagram and Facebook posts.' });
    }

    const brand = await Brand.findOne({ id: content.brand_id }).lean();
    const status = brandMetaStatus(brand);
    const needs = content.platform === 'both' ? ['instagram', 'facebook'] : [content.platform];
    const missing = needs.filter(p => !status[p]);
    if (missing.length) {
      return res.status(400).json({ error: `Connect ${missing.join(' and ')} in Brand Settings before scheduling.` });
    }
    if (needs.includes('instagram') && !content.image_url) {
      return res.status(400).json({ error: 'Instagram posts need an image. Generate one before scheduling.' });
    }

    await Content.updateOne(
      { id: contentId },
      { $set: { status: 'scheduled', scheduled_for: scheduledFor }, $unset: { publish_error: '' } }
    );

    res.json({ success: true, scheduledFor });
  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: 'Failed to schedule content' });
  }
}

let checking = false;

// Runs every minute. Each due item is claimed atomically (scheduled ->
// publishing) so it is published at most once, and failures are recorded
// instead of being retried forever.
export async function checkScheduledContent() {
  if (checking) return;
  checking = true;
  try {
    for (;;) {
      const content = await Content.findOneAndUpdate(
        { status: 'scheduled', scheduled_for: { $lte: new Date() } },
        { $set: { status: 'publishing' } },
        { sort: { scheduled_for: 1 }, new: true }
      ).lean();
      if (!content) break;

      try {
        const brand = await Brand.findOne({ id: content.brand_id }).lean();
        if (!brand) throw new Error('Brand not found');
        await publishNow(content, brand, content.platform);
        console.log(`✓ Published scheduled content: ${content.id}`);
      } catch (err) {
        console.error(`✗ Scheduled publish failed for ${content.id}:`, err.message);
        await Content.updateOne({ id: content.id }, { $set: { status: 'failed', publish_error: err.message } });
      }
    }
  } catch (err) {
    console.error('Check scheduled content error:', err);
  } finally {
    checking = false;
  }
}

// Items left in "publishing" by a crash/redeploy mid-publish become failed so
// the user can retry them.
export async function recoverStuckPublishing() {
  await Content.updateMany(
    { status: 'publishing' },
    { $set: { status: 'failed', publish_error: 'Publishing was interrupted by a server restart. Please try again.' } }
  );
}

// GET /api/content/:contentId/analytics
export async function fetchContentAnalytics(req, res) {
  try {
    const content = await Content.findOne({ id: req.params.contentId, user_id: req.userId }).lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    if (content.status !== 'published') {
      return res.json({ performance: {} });
    }

    const brand = await Brand.findOne({ id: content.brand_id }).lean();
    if (!brand?.meta_page_token) {
      return res.json({ performance: content.performance || {} });
    }

    const performance = await fetchPostMetrics(content, brand);
    if (Object.keys(performance).length) {
      await Content.updateOne({ id: content.id }, { $set: { performance } });
    }
    res.json({ performance: Object.keys(performance).length ? performance : (content.performance || {}) });
  } catch (err) {
    console.error('Get content analytics error:', err);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
}
