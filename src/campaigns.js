import { randomUUID } from 'crypto';
import { Campaign, Brand, Content } from './models/index.js';
import { buildBrandSystemPrompt } from './brandBrain.js';
import { claudeText, extractJson, splitVersions, PLAIN_TEXT_RULES } from './llm.js';
import { generateImageForContent } from './ai.js';
import { brandMetaStatus } from './publishing.js';
import { CONTENT_LIST_STAGES } from './content.js';
import { isValidDate, mapWithConcurrency } from './utils.js';

// A run older than this is assumed dead (e.g. the server restarted mid-run).
const STALE_RUN_MS = 15 * 60 * 1000;

export async function generateCampaignPlan(req, res) {
  try {
    const { brandId, name, objective, startDate, endDate, budget, channels, frequency } = req.body;

    if (!name || !objective || !startDate || !endDate || !Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: 'Name, objective, dates and at least one channel are required' });
    }
    if (new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({ error: 'End date must be after the start date' });
    }

    const brand = await Brand.findOne({ id: brandId, user_id: req.userId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const prompt = `Create a comprehensive ${objective} campaign plan for ${brand.name}:
- Campaign Name: ${name}
- Duration: ${startDate} to ${endDate}
- Budget: ${budget ? `$${budget}` : 'Not specified'}
- Channels: ${channels.join(', ')}
- Frequency: ${frequency || 'Weekly'}

Generate a JSON response with:
{
  "strategy": "Overall strategy description",
  "key_messages": ["message1", "message2", "message3"],
  "content_plan": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "platform": "one of: ${channels.join('|')}",
      "type": "Social Post|Blog|Email|Ad Copy|Thread|Reel Script",
      "topic": "content topic",
      "brief": "brief description",
      "time": "HH:MM",
      "generate_image": true|false
    }
  ],
  "kpis": {
    "metric1": "target1",
    "metric2": "target2"
  }
}

Generate exactly 5 content items with dates between ${startDate} and ${endDate}. Only use the listed channels. Ensure variety in content types. Keep each brief to one short sentence. Return ONLY the JSON object, no markdown fences or extra text.`;

    const plan = extractJson(await claudeText({ system: buildBrandSystemPrompt(brand), prompt, maxTokens: 6000 }));
    if (!plan || !Array.isArray(plan.content_plan)) {
      return res.status(502).json({ error: 'The AI returned an invalid plan. Please try again.' });
    }

    res.json({
      strategy: plan.strategy || '',
      key_messages: Array.isArray(plan.key_messages) ? plan.key_messages : [],
      content_plan: plan.content_plan,
      kpis: plan.kpis && typeof plan.kpis === 'object' ? plan.kpis : {}
    });
  } catch (err) {
    console.error('Generate campaign plan error:', err);
    res.status(500).json({ error: 'Failed to generate campaign plan' });
  }
}

export async function createCampaign(req, res) {
  try {
    const { brandId, name, objective, startDate, endDate, budget, channels, frequency, strategy, key_messages, content_plan, kpis } = req.body;

    const brand = await Brand.findOne({ id: brandId, user_id: req.userId }).select('id -_id').lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Campaign name is required' });
    }

    const campaignId = randomUUID();
    await Campaign.create({
      id: campaignId,
      brand_id: brandId,
      user_id: req.userId,
      name,
      objective,
      start_date: startDate,
      end_date: endDate,
      budget,
      channels: channels || [],
      frequency,
      strategy,
      key_messages: key_messages || [],
      content_plan: content_plan || [],
      kpis: kpis || {},
      status: 'active'
    });

    res.json({ id: campaignId, status: 'active' });
  } catch (err) {
    console.error('Create campaign error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
}

export async function getCampaigns(req, res) {
  try {
    const filter = { user_id: req.userId };
    if (req.query.brandId) filter.brand_id = req.query.brandId;

    const campaigns = await Campaign.find(filter).sort({ created_at: -1 }).select('-_id').lean();
    const counts = await Content.aggregate([
      { $match: { user_id: req.userId, campaign_id: { $in: campaigns.map(c => c.id) } } },
      { $group: { _id: '$campaign_id', count: { $sum: 1 } } }
    ]);
    const countById = Object.fromEntries(counts.map(c => [c._id, c.count]));

    res.json(campaigns.map(c => ({
      ...c,
      generated_count: countById[c.id] || 0,
      planned_count: Array.isArray(c.content_plan) ? c.content_plan.length : 0
    })));
  } catch (err) {
    console.error('Get campaigns error:', err);
    res.status(500).json({ error: 'Failed to get campaigns' });
  }
}

export async function getCampaignById(req, res) {
  try {
    const campaign = await Campaign.findOne({ id: req.params.campaignId, user_id: req.userId }).select('-_id').lean();
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    campaign.content = await Content.aggregate([
      { $match: { campaign_id: campaign.id, user_id: req.userId } },
      { $sort: { plan_index: 1, scheduled_for: 1 } },
      ...CONTENT_LIST_STAGES
    ]);

    res.json(campaign);
  } catch (err) {
    console.error('Get campaign error:', err);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
}

// Runs interrupted by a restart can never finish; let the user retry them.
export async function recoverStuckCampaigns() {
  await Campaign.updateMany(
    { generation_status: 'running' },
    { $set: { generation_status: 'failed', generation_errors: [{ error: 'Generation was interrupted by a server restart. Please try again.' }] } }
  );
}

/** Plan date + "HH:MM" in the user's timezone -> Date (or null). */
function planDate(item, tzOffsetMinutes) {
  const [y, m, d] = String(item.date || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = String(item.time || '09:00').split(':').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, hh || 9, mm || 0) + (tzOffsetMinutes || 0) * 60_000);
  return isValidDate(date) ? date : null;
}

async function generatePlanItem({ campaign, brand, item, index, userId, tzOffsetMinutes, canAutoPublish }) {
  const text = await claudeText({
    system: `${buildBrandSystemPrompt(brand)}\n\nGenerate 3 versions separated by ===VERSION===. ONLY content, no explanations. ${PLAIN_TEXT_RULES}`,
    prompt: `Generate a ${item.type} for ${item.platform}. Topic: ${item.topic}. Brief: ${item.brief}. This is part of the "${campaign.name}" campaign (${campaign.objective}).`,
    maxTokens: 1500
  });
  const versions = splitVersions(text);
  if (versions.length === 0) throw new Error('Empty AI response');

  const platform = String(item.platform || '').toLowerCase();
  const scheduledFor = planDate(item, tzOffsetMinutes);
  const contentId = randomUUID();

  await Content.create({
    id: contentId,
    brand_id: campaign.brand_id,
    user_id: userId,
    campaign_id: campaign.id,
    plan_index: index,
    type: item.type,
    platform,
    body: versions,
    status: 'draft',
    scheduled_for: scheduledFor,
    media_brief: item.brief || item.topic
  });

  // Instagram cannot publish without an image.
  const needsImage = item.generate_image === true || platform === 'instagram';
  let hasImage = false;
  if (needsImage) {
    try {
      await generateImageForContent(contentId, brand, userId, `${item.topic}. ${item.brief || ''}`);
      hasImage = true;
    } catch (err) {
      console.error(`Campaign image failed for item ${index}:`, err.message);
    }
  }

  // Auto-schedule only what can actually be auto-published.
  const readyForAutoPublish = scheduledFor && scheduledFor > new Date() && canAutoPublish(platform) &&
    (platform !== 'instagram' || hasImage);
  if (readyForAutoPublish) {
    await Content.updateOne({ id: contentId }, { $set: { status: 'scheduled' } });
  }
}

async function runCampaignGeneration(campaign, brand, userId, tzOffsetMinutes) {
  const plan = Array.isArray(campaign.content_plan) ? campaign.content_plan : [];
  const existing = await Content.find({ campaign_id: campaign.id }).select('plan_index -_id').lean();
  const done = new Set(existing.map(c => c.plan_index));
  const meta = brandMetaStatus(brand);
  const canAutoPublish = (platform) => !!meta[platform];

  const errors = [];
  await mapWithConcurrency(plan.map((item, index) => ({ item, index })).filter(x => !done.has(x.index)), 3, async ({ item, index }) => {
    try {
      await generatePlanItem({ campaign, brand, item, index, userId, tzOffsetMinutes, canAutoPublish });
    } catch (err) {
      console.error(`Failed to generate campaign item ${index} (${item.topic}):`, err.message);
      errors.push({ index, topic: item.topic, error: err.message });
    }
  });

  const generated = await Content.countDocuments({ campaign_id: campaign.id });
  await Campaign.updateOne(
    { id: campaign.id },
    {
      $set: {
        generation_status: errors.length && generated < plan.length ? 'failed' : 'done',
        generation_errors: errors,
        ...(generated > 0 ? { status: 'launched' } : {})
      }
    }
  );
}

// POST /api/campaigns/:campaignId/generate-content   body: { tzOffsetMinutes }
// Starts generation in the background and returns immediately; the client
// polls GET /api/campaigns/:id for progress.
export async function generateCampaignContent(req, res) {
  try {
    const { campaignId } = req.params;
    const userId = req.userId;

    const campaign = await Campaign.findOne({ id: campaignId, user_id: userId }).lean();
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const running = campaign.generation_status === 'running' &&
      Date.now() - new Date(campaign.generation_started_at).getTime() < STALE_RUN_MS;
    if (running) {
      return res.status(202).json({ status: 'running' });
    }

    const brand = await Brand.findOne({ id: campaign.brand_id }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    await Campaign.updateOne(
      { id: campaignId },
      { $set: { generation_status: 'running', generation_started_at: new Date(), generation_errors: [] } }
    );

    const tzOffsetMinutes = Number.isFinite(req.body?.tzOffsetMinutes) ? req.body.tzOffsetMinutes : 0;
    runCampaignGeneration(campaign, brand, userId, tzOffsetMinutes).catch(async (err) => {
      console.error('Campaign generation crashed:', err);
      await Campaign.updateOne({ id: campaignId }, { $set: { generation_status: 'failed', generation_errors: [{ error: err.message }] } });
    });

    res.status(202).json({ status: 'running' });
  } catch (err) {
    console.error('Generate campaign content error:', err);
    res.status(500).json({ error: 'Failed to generate campaign content' });
  }
}

export async function getCalendarEvents(req, res) {
  try {
    const { startDate, endDate, brandId } = req.query;

    const filter = { user_id: req.userId, scheduled_for: { $ne: null } };
    if (brandId) filter.brand_id = brandId;
    if (startDate && endDate) {
      filter.scheduled_for = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const events = await Content.aggregate([
      { $match: filter },
      { $sort: { scheduled_for: 1 } },
      ...CONTENT_LIST_STAGES
    ]);

    // Attach brand_name to each event
    const brandIds = [...new Set(events.map(e => e.brand_id).filter(Boolean))];
    const brands = await Brand.find({ id: { $in: brandIds } }).select('id name -_id').lean();
    const brandNameById = Object.fromEntries(brands.map(b => [b.id, b.name]));

    res.json(events.map(e => ({ ...e, brand_name: brandNameById[e.brand_id] || null })));
  } catch (err) {
    console.error('Get calendar events error:', err);
    res.status(500).json({ error: 'Failed to get calendar events' });
  }
}

// PATCH /api/calendar/:contentId   body: { scheduledFor }
// Moves an item on the calendar. Scheduled (auto-publish) items keep their
// status; drafts just get a planned date.
export async function updateCalendarEvent(req, res) {
  try {
    const { contentId } = req.params;
    const scheduledFor = new Date(req.body.scheduledFor);
    if (!isValidDate(scheduledFor)) {
      return res.status(400).json({ error: 'Please pick a valid date and time' });
    }

    const content = await Content.findOne({ id: contentId, user_id: req.userId }).select('id status -_id').lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    if (content.status === 'published') {
      return res.status(400).json({ error: 'Published content cannot be rescheduled' });
    }
    if (content.status === 'scheduled' && scheduledFor.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' });
    }

    await Content.updateOne({ id: contentId }, { $set: { scheduled_for: scheduledFor } });
    res.json({ id: contentId, scheduledFor });
  } catch (err) {
    console.error('Update calendar event error:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
}
