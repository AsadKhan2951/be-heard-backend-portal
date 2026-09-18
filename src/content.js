import { randomUUID } from 'crypto';
import { Content, Brand } from './models/index.js';
import { escapeRegex, isValidDate } from './utils.js';
import { mediaUrl, mediaUrlExpr } from './media.js';

const EDITABLE_STATUSES = ['draft', 'scheduled'];

/** Shape one content document for the API (image as a short media URL). */
export function contentToClient(doc) {
  if (!doc) return doc;
  const { _id, image_data, ...rest } = doc;
  return { ...rest, image_url: mediaUrl('content', doc.id, doc.image_url) };
}

/** Aggregation stages that replace base64 images with media URLs. */
export const CONTENT_LIST_STAGES = [
  { $set: { image_url: mediaUrlExpr('content') } },
  { $project: { _id: 0, image_data: 0 } }
];

export async function createContent(req, res) {
  try {
    const { brandId, type, platform, body, imageUrl, status } = req.body;
    const userId = req.userId;

    const brand = await Brand.findOne({ id: brandId, user_id: userId }).select('id -_id').lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    if (!type || body === undefined || body === '') {
      return res.status(400).json({ error: 'type and body are required' });
    }

    const contentId = randomUUID();
    await Content.create({
      id: contentId,
      brand_id: brandId,
      user_id: userId,
      type,
      platform,
      body,
      image_url: typeof imageUrl === 'string' && !imageUrl.startsWith('/api/media/') ? imageUrl : undefined,
      status: EDITABLE_STATUSES.includes(status) ? status : 'draft'
    });

    res.json({ id: contentId, status: 'draft' });
  } catch (err) {
    console.error('Create content error:', err);
    res.status(500).json({ error: 'Failed to create content' });
  }
}

export async function getContent(req, res) {
  try {
    const { type, platform, status, search, brandId, limit } = req.query;

    const filter = { user_id: req.userId };
    if (brandId) filter.brand_id = brandId;
    if (type) filter.type = type;
    if (platform) filter.platform = platform;
    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      // A regex on an array field matches any element, so this covers both
      // string bodies and arrays of versions.
      filter.$or = [{ media_brief: rx }, { title: rx }, { body: rx }];
    }

    const pipeline = [{ $match: filter }, { $sort: { created_at: -1 } }];
    const n = parseInt(limit, 10);
    if (n > 0) pipeline.push({ $limit: Math.min(n, 200) });
    pipeline.push(...CONTENT_LIST_STAGES);

    res.json(await Content.aggregate(pipeline));
  } catch (err) {
    console.error('Get content error:', err);
    res.status(500).json({ error: 'Failed to get content' });
  }
}

export async function getContentById(req, res) {
  try {
    const content = await Content.findOne({ id: req.params.contentId, user_id: req.userId }).lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const brand = await Brand.findOne({ id: content.brand_id }).select('name meta_page_id meta_page_token meta_ig_account_id -_id').lean();
    res.json({
      ...contentToClient(content),
      brand_name: brand?.name || null,
      brand_meta_connected: !!(brand?.meta_page_id && brand?.meta_page_token),
      brand_instagram_connected: !!(brand?.meta_ig_account_id && brand?.meta_page_token)
    });
  } catch (err) {
    console.error('Get content error:', err);
    res.status(500).json({ error: 'Failed to get content' });
  }
}

export async function updateContent(req, res) {
  try {
    const { contentId } = req.params;
    const { body, imageUrl, status, scheduledFor, title } = req.body;

    const content = await Content.findOne({ id: contentId, user_id: req.userId }).select('id -_id').lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const set = {};
    const unset = {};
    if (body !== undefined) set.body = body;
    if (title !== undefined) set.title = title;
    if (typeof imageUrl === 'string' && !imageUrl.startsWith('/api/media/')) set.image_url = imageUrl;
    if (imageUrl === null) unset.image_url = '';
    if (status !== undefined) {
      if (!EDITABLE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${EDITABLE_STATUSES.join(', ')}` });
      }
      set.status = status;
      if (status === 'draft') unset.publish_error = '';
    }
    if (scheduledFor !== undefined) {
      if (scheduledFor === null) {
        unset.scheduled_for = '';
      } else {
        const date = new Date(scheduledFor);
        if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date' });
        set.scheduled_for = date;
      }
    }

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (Object.keys(update).length) {
      await Content.updateOne({ id: contentId }, update);
    }

    res.json({ id: contentId });
  } catch (err) {
    console.error('Update content error:', err);
    res.status(500).json({ error: 'Failed to update content' });
  }
}

export async function deleteContent(req, res) {
  try {
    const result = await Content.deleteOne({ id: req.params.contentId, user_id: req.userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete content error:', err);
    res.status(500).json({ error: 'Failed to delete content' });
  }
}

export async function getDashboardStats(req, res) {
  try {
    const { brandId } = req.query;

    const base = { user_id: req.userId };
    if (brandId) base.brand_id = brandId;

    const [totalContent, scheduled, published, engagementAgg] = await Promise.all([
      Content.countDocuments(base),
      Content.countDocuments({ ...base, status: 'scheduled' }),
      Content.countDocuments({ ...base, status: 'published' }),
      Content.aggregate([
        { $match: { ...base, status: 'published', 'performance.reach': { $gt: 0 } } },
        {
          $group: {
            _id: null,
            avg: { $avg: { $multiply: [{ $divide: [{ $ifNull: ['$performance.engagement', 0] }, '$performance.reach'] }, 100] } }
          }
        }
      ])
    ]);

    const engagementRate = Math.round((engagementAgg[0]?.avg || 0) * 100) / 100;

    res.json({
      totalContent,
      scheduled,
      published,
      engagementRate
    });
  } catch (err) {
    console.error('Get dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
}
