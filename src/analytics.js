import axios from 'axios';
import { randomUUID } from 'crypto';
import { Analytics, Brand, Content } from './models/index.js';
import { META_GRAPH_URL } from './config.js';
import { escapeRegex } from './utils.js';

const DAY = 24 * 60 * 60 * 1000;

function warn(label, err) {
  console.warn(`${label}:`, err.response?.data?.error?.message || err.message);
}

/** Post ids per platform, including content published before meta_post_ids existed. */
function postIdsOf(content) {
  const ids = { ...(content.meta_post_ids || {}) };
  if (!Object.keys(ids).length && content.meta_post_id) {
    ids[content.platform === 'instagram' ? 'instagram' : 'facebook'] = content.meta_post_id;
  }
  return ids;
}

/**
 * Fetch engagement numbers for one published post from Meta.
 * Returns { engagement, reach, likes, comments, shares, saved } (whatever is available).
 */
export async function fetchPostMetrics(content, brand) {
  const ids = postIdsOf(content);
  const token = brand.meta_page_token;
  const totals = {};
  const add = (key, value) => {
    if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
  };

  if (ids.instagram) {
    try {
      const r = await axios.get(`${META_GRAPH_URL}/${ids.instagram}/insights`, {
        params: { metric: 'reach,likes,comments,shares,saved,total_interactions', access_token: token }
      });
      for (const m of r.data.data || []) {
        const value = m.values?.[0]?.value ?? m.total_value?.value;
        add(m.name === 'total_interactions' ? 'engagement' : m.name, value);
      }
    } catch (err) {
      warn(`Instagram insights for ${ids.instagram}`, err);
    }
  }

  if (ids.facebook) {
    try {
      const r = await axios.get(`${META_GRAPH_URL}/${ids.facebook}`, {
        params: { fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0),shares', access_token: token }
      });
      const likes = r.data.likes?.summary?.total_count || 0;
      const comments = r.data.comments?.summary?.total_count || 0;
      const shares = r.data.shares?.count || 0;
      add('likes', likes);
      add('comments', comments);
      add('shares', shares);
      add('engagement', likes + comments + shares);
    } catch (err) {
      warn(`Facebook post stats for ${ids.facebook}`, err);
    }
    try {
      const r = await axios.get(`${META_GRAPH_URL}/${ids.facebook}/insights`, {
        params: { metric: 'post_impressions_unique', access_token: token }
      });
      add('reach', r.data.data?.[0]?.values?.[0]?.value);
    } catch (err) {
      warn(`Facebook post reach for ${ids.facebook}`, err);
    }
  }

  return totals;
}

/** Daily insight series for one metric, fetched in <=30 day windows. */
async function fetchDailySeries(objectId, metric, token, since, until) {
  const points = [];
  for (let start = since.getTime(); start < until.getTime(); start += 30 * DAY) {
    const end = Math.min(start + 30 * DAY, until.getTime());
    const r = await axios.get(`${META_GRAPH_URL}/${objectId}/insights`, {
      params: {
        metric,
        period: 'day',
        since: Math.floor(start / 1000),
        until: Math.floor(end / 1000),
        access_token: token
      }
    });
    for (const v of r.data.data?.[0]?.values || []) {
      if (typeof v.value === 'number') points.push({ date: String(v.end_time || '').slice(0, 10), value: v.value });
    }
  }
  return points;
}

async function ownedBrand(req, brandId) {
  if (!brandId) return null;
  return Brand.findOne({ id: brandId, user_id: req.userId }).lean();
}

export async function getAnalytics(req, res) {
  try {
    const { brandId } = req.query;
    const brand = await ownedBrand(req, brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const days = [7, 30, 90].includes(parseInt(req.query.dateRange, 10)) ? parseInt(req.query.dateRange, 10) : 7;
    const until = new Date();
    const since = new Date(until.getTime() - days * DAY);

    // Content performance from our own database (works without Meta too)
    const [contentMetrics, topPosts] = await Promise.all([
      Content.aggregate([
        { $match: { brand_id: brandId, status: 'published', published_at: { $gte: since } } },
        {
          $group: {
            _id: '$platform',
            total_posts: { $sum: 1 },
            avg_engagement: { $avg: '$performance.engagement' },
            avg_reach: { $avg: '$performance.reach' }
          }
        }
      ]),
      Content.find({ brand_id: brandId, status: 'published' })
        .sort({ 'performance.engagement': -1, published_at: -1 })
        .limit(5)
        .select('id platform body performance published_at -_id')
        .lean()
    ]);

    const base = {
      brandId,
      dateRange: days,
      contentMetrics: contentMetrics.map(m => ({
        platform: m._id,
        total_posts: m.total_posts,
        avg_engagement: Math.round(m.avg_engagement || 0),
        avg_reach: Math.round(m.avg_reach || 0)
      })),
      topPosts: topPosts.map(p => ({
        id: p.id,
        platform: p.platform,
        excerpt: String(Array.isArray(p.body) ? p.body[0] || '' : p.body || '').slice(0, 140),
        engagement: p.performance?.engagement || 0,
        reach: p.performance?.reach || 0,
        published_at: p.published_at
      })),
      fetchedAt: new Date().toISOString()
    };

    if (!brand.meta_page_id || !brand.meta_page_token) {
      return res.json({ connected: false, message: 'Connect Meta account to view analytics', ...base });
    }

    const token = brand.meta_page_token;
    const overview = {};
    const series = [];
    const tasks = [
      axios.get(`${META_GRAPH_URL}/${brand.meta_page_id}`, { params: { fields: 'name,followers_count,fan_count', access_token: token } })
        .then(r => { overview.facebook = { name: r.data.name, followers: r.data.followers_count ?? r.data.fan_count ?? null }; })
        .catch(err => warn('Facebook page overview', err)),
      fetchDailySeries(brand.meta_page_id, 'page_post_engagements', token, since, until)
        .then(points => points.length && series.push({ key: 'fb_engagements', label: 'Facebook engagements', platform: 'facebook', points }))
        .catch(err => warn('Facebook page engagements', err))
    ];
    if (brand.meta_ig_account_id) {
      tasks.push(
        axios.get(`${META_GRAPH_URL}/${brand.meta_ig_account_id}`, { params: { fields: 'username,followers_count,media_count', access_token: token } })
          .then(r => { overview.instagram = { name: r.data.username, followers: r.data.followers_count ?? null, posts: r.data.media_count ?? null }; })
          .catch(err => warn('Instagram overview', err)),
        fetchDailySeries(brand.meta_ig_account_id, 'reach', token, since, until)
          .then(points => points.length && series.push({ key: 'ig_reach', label: 'Instagram reach', platform: 'instagram', points }))
          .catch(err => warn('Instagram reach', err))
      );
    }
    await Promise.all(tasks);

    res.json({ connected: true, overview, series, ...base });
  } catch (err) {
    console.error('Get analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
}

export async function syncAnalytics(req, res) {
  try {
    const { brandId } = req.body;
    const brand = await ownedBrand(req, brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    if (!brand.meta_page_id || !brand.meta_page_token) {
      return res.status(400).json({ error: 'Meta account not connected' });
    }

    const published = await Content.find({
      brand_id: brandId,
      status: 'published',
      $or: [{ meta_post_id: { $ne: null } }, { meta_post_ids: { $ne: {} } }]
    }).sort({ published_at: -1 }).limit(50).lean();

    let synced = 0;
    for (const content of published) {
      const performance = await fetchPostMetrics(content, brand);
      if (Object.keys(performance).length) {
        await Content.updateOne({ id: content.id }, { $set: { performance } });
        await Analytics.create({
          id: randomUUID(),
          brand_id: brandId,
          platform: content.platform,
          metric_name: 'post_performance',
          metric_value: performance.engagement || 0,
          data: { content_id: content.id, ...performance }
        });
        synced++;
      }
    }

    res.json({
      success: true,
      brandId,
      postsChecked: published.length,
      postsSynced: synced,
      syncedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Sync analytics error:', err);
    res.status(500).json({ error: 'Failed to sync analytics' });
  }
}

export async function getAnalyticsHistory(req, res) {
  try {
    const { brandId, metric } = req.query;
    const brand = await ownedBrand(req, brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const filter = { brand_id: brandId };
    if (metric) filter.metric_name = new RegExp(escapeRegex(metric), 'i');

    const history = await Analytics.find(filter)
      .sort({ recorded_at: -1 })
      .limit(100)
      .select('metric_name metric_value data recorded_at -_id')
      .lean();

    res.json(history);
  } catch (err) {
    console.error('Get analytics history error:', err);
    res.status(500).json({ error: 'Failed to get analytics history' });
  }
}
