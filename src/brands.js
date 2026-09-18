import { randomUUID } from 'crypto';
import { Brand } from './models/index.js';
import { scrapeBrandSite, prefillBrandProfile, generateBrandProfile, mergeProfile } from './brandBrain.js';
import { mediaUrl, mediaUrlExpr } from './media.js';

const DEFAULT_COLORS = { primary: '#BFFF00', secondary: '#0a0a0a' };

// Never send the Meta page token to the browser.
function toClient(brand) {
  if (!brand) return brand;
  const { meta_page_token, _id, ...rest } = brand;
  return {
    ...rest,
    logo_url: mediaUrl('logo', brand.id, brand.logo_url),
    meta_connected: !!(brand.meta_page_id && meta_page_token)
  };
}

function normalizeCompetitors(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}

// Accept both camelCase and snake_case keys from clients.
function pick(body, camel, snake) {
  if (body[camel] !== undefined) return body[camel];
  if (snake && body[snake] !== undefined) return body[snake];
  return undefined;
}

export async function createBrand(req, res) {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Brand name is required' });
    }

    const brandId = randomUUID();
    await Brand.create({
      id: brandId,
      user_id: req.userId,
      name,
      industry: req.body.industry,
      website_url: pick(req.body, 'websiteUrl', 'website_url'),
      colors: req.body.colors || DEFAULT_COLORS,
      voice_description: pick(req.body, 'voiceDescription', 'voice_description'),
      target_audience: pick(req.body, 'targetAudience', 'target_audience'),
      competitors: normalizeCompetitors(req.body.competitors),
      sample_content: pick(req.body, 'sampleContent', 'sample_content'),
      onboarding_step: 2
    });

    res.json({ id: brandId, name, industry: req.body.industry });
  } catch (err) {
    console.error('Create brand error:', err);
    res.status(500).json({ error: 'Failed to create brand' });
  }
}

export async function getBrands(req, res) {
  try {
    const brands = await Brand.aggregate([
      { $match: { user_id: req.userId, active: 1 } },
      { $sort: { created_at: -1 } },
      {
        $set: {
          logo_url: mediaUrlExpr('logo', 'logo_url'),
          meta_connected: { $and: [{ $gt: ['$meta_page_id', null] }, { $gt: ['$meta_page_token', null] }] }
        }
      },
      { $project: { _id: 0, meta_page_token: 0 } }
    ]);

    res.json(brands);
  } catch (err) {
    console.error('Get brands error:', err);
    res.status(500).json({ error: 'Failed to get brands' });
  }
}

export async function getBrand(req, res) {
  try {
    const brand = await Brand.findOne({ id: req.params.brandId, user_id: req.userId, active: 1 }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    res.json(toClient(brand));
  } catch (err) {
    console.error('Get brand error:', err);
    res.status(500).json({ error: 'Failed to get brand' });
  }
}

export async function updateBrand(req, res) {
  try {
    const { brandId } = req.params;
    const body = req.body || {};

    const brand = await Brand.findOne({ id: brandId, user_id: req.userId }).select('id -_id').lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const set = {};
    const unset = {};
    const text = (camel, snake, field) => {
      const v = pick(body, camel, snake);
      if (typeof v === 'string') set[field] = v.trim();
    };

    const name = pick(body, 'name');
    if (typeof name === 'string' && name.trim()) set.name = name.trim();
    text('industry', null, 'industry');
    text('voiceDescription', 'voice_description', 'voice_description');
    text('targetAudience', 'target_audience', 'target_audience');
    text('sampleContent', 'sample_content', 'sample_content');
    text('websiteUrl', 'website_url', 'website_url');

    if (body.colors && typeof body.colors === 'object') set.colors = body.colors;

    const competitors = pick(body, 'competitors');
    if (competitors !== undefined) set.competitors = normalizeCompetitors(competitors);

    // Only accept freshly uploaded images or external URLs, never our own
    // /api/media links echoed back.
    const logoUrl = pick(body, 'logoUrl', 'logo_url');
    if (typeof logoUrl === 'string' && !logoUrl.startsWith('/api/media/')) set.logo_url = logoUrl;

    const step = pick(body, 'onboardingStep', 'onboarding_step');
    if (Number.isInteger(step)) set.onboarding_step = step;
    const complete = pick(body, 'onboardingComplete', 'onboarding_complete');
    if (complete !== undefined) set.onboarding_complete = complete ? 1 : 0;

    // Manual content preferences live inside content_preferences; set them
    // with dotted paths so the AI-generated profile is preserved.
    const bannedWords = pick(body, 'bannedWords', 'banned_words');
    if (bannedWords !== undefined) set['content_preferences.banned_words'] = normalizeCompetitors(bannedWords);
    const hashtags = pick(body, 'hashtagsPreference', 'hashtags_preference');
    if (['always', 'sometimes', 'never'].includes(hashtags)) set['content_preferences.hashtags_preference'] = hashtags;
    const length = pick(body, 'contentLength', 'content_length');
    if (['short', 'medium', 'long'].includes(length)) set['content_preferences.content_length'] = length;

    if (body.disconnectMeta) {
      Object.assign(unset, { meta_page_id: '', meta_page_name: '', meta_page_token: '', meta_ig_account_id: '', meta_connected_at: '' });
    }

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (Object.keys(update).length) {
      await Brand.updateOne({ id: brandId }, update);
    }

    const updated = await Brand.findOne({ id: brandId }).lean();
    res.json(toClient(updated));
  } catch (err) {
    console.error('Update brand error:', err);
    res.status(500).json({ error: 'Failed to update brand' });
  }
}

// Soft delete: hides the brand everywhere but keeps its content in the database.
export async function deleteBrand(req, res) {
  try {
    const result = await Brand.updateOne(
      { id: req.params.brandId, user_id: req.userId },
      { $set: { active: 0 } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete brand error:', err);
    res.status(500).json({ error: 'Failed to delete brand' });
  }
}

// Scrape the brand website and return prefill suggestions (voice, audience, industry)
export async function prefillBrand(req, res) {
  try {
    const brand = await Brand.findOne({ id: req.params.brandId, user_id: req.userId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const url = req.body?.websiteUrl || brand.website_url;
    if (!url) {
      return res.json({});
    }

    const siteText = await scrapeBrandSite(url);
    if (!siteText) {
      return res.json({});
    }

    res.json(await prefillBrandProfile(siteText));
  } catch (err) {
    console.error('Prefill error:', err);
    res.json({});
  }
}

// Synthesize all brand data into a full brand profile and save it
export async function regenerateBrandProfile(req, res) {
  try {
    const { brandId } = req.params;

    const brand = await Brand.findOne({ id: brandId, user_id: req.userId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const websiteText = brand.website_url ? await scrapeBrandSite(brand.website_url) : null;
    const profile = mergeProfile(brand.content_preferences, await generateBrandProfile(brand, websiteText));

    await Brand.updateOne({ id: brandId }, { $set: { content_preferences: profile } });

    res.json(profile);
  } catch (err) {
    console.error('Regenerate profile error:', err);
    res.status(500).json({ error: 'Failed to regenerate profile' });
  }
}
