import { randomUUID } from 'crypto';
import { PRPiece, Brand } from './models/index.js';
import { buildBrandSystemPrompt } from './brandBrain.js';
import { claudeText } from './llm.js';

const PR_TYPES = {
  'press-release': 'Press Release',
  'media-pitch': 'Media Pitch',
  'brand-story': 'Brand Story',
  'crisis': 'Crisis Statement',
  'thought-leadership': 'Thought Leadership Article'
};

const PR_STATUSES = ['draft', 'final'];
const OUTLETS_MARKER = '===OUTLETS===';

/**
 * The PR text goes first (plain text, so long copy never breaks JSON), then a
 * marker line, then a JSON array of outlets.
 */
function parsePRReply(text) {
  const [body, outletsPart = ''] = text.split(OUTLETS_MARKER);
  let outlets = [];
  const match = outletsPart.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) outlets = parsed.filter(o => o && o.name);
    } catch {
      outlets = [];
    }
  }
  return { content: body.trim(), outlets };
}

export async function generatePR(req, res) {
  try {
    const { brandId, type, topic, keyFacts, spokesperson, targetMedia, prId } = req.body;
    const userId = req.userId;

    if (!PR_TYPES[type]) {
      return res.status(400).json({ error: 'Invalid PR type' });
    }
    if (!topic || !String(topic).trim()) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const brand = await Brand.findOne({ id: brandId, user_id: userId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    let existing = null;
    if (prId) {
      existing = await PRPiece.findOne({ id: prId, user_id: userId }).select('id -_id').lean();
      if (!existing) return res.status(404).json({ error: 'PR piece not found' });
    }

    const prompt = `You are a professional PR writer for ${brand.name}, a ${brand.industry || ''} company.

Write a professional ${PR_TYPES[type]} about:
Topic: ${topic}
Key Facts: ${keyFacts || 'Not provided'}
Spokesperson: ${spokesperson || 'Not provided'}
Target Media: ${targetMedia || 'General business and industry media'}

Format it properly with:
- Headline (if Press Release/Media Pitch)
- Subheading
- Opening paragraph (hook)
- Body (3-4 paragraphs)
- Closing/Call to action
- Boilerplate about ${brand.name}

Output the finished piece as plain text first. Then output a line containing exactly ${OUTLETS_MARKER} followed by a JSON array of 5 media outlets that would be interested in this story (favour the target media above):
[{ "name": "outlet name", "type": "publication type", "focus": "why relevant" }]`;

    const result = parsePRReply(await claudeText({ system: buildBrandSystemPrompt(brand), prompt, maxTokens: 3000 }));
    if (!result.content) {
      return res.status(502).json({ error: 'The AI returned an empty response. Please try again.' });
    }

    const fields = {
      brand_id: brandId,
      type,
      title: topic,
      body: result.content,
      target_outlets: result.outlets,
      status: 'draft'
    };

    const id = existing ? existing.id : randomUUID();
    if (existing) {
      await PRPiece.updateOne({ id }, { $set: fields });
    } else {
      await PRPiece.create({ id, user_id: userId, ...fields });
    }

    res.json({
      id,
      type,
      topic,
      content: result.content,
      outlets: result.outlets
    });
  } catch (err) {
    console.error('Generate PR error:', err);
    res.status(500).json({ error: 'Failed to generate PR' });
  }
}

export async function getPRPieces(req, res) {
  try {
    const { type, status, brandId } = req.query;

    const filter = { user_id: req.userId };
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (brandId) filter.brand_id = brandId;

    const pieces = await PRPiece.find(filter).sort({ created_at: -1 }).select('-_id').lean();
    res.json(pieces);
  } catch (err) {
    console.error('Get PR pieces error:', err);
    res.status(500).json({ error: 'Failed to get PR pieces' });
  }
}

export async function getPRById(req, res) {
  try {
    const pr = await PRPiece.findOne({ id: req.params.prId, user_id: req.userId }).select('-_id').lean();
    if (!pr) {
      return res.status(404).json({ error: 'PR piece not found' });
    }
    res.json(pr);
  } catch (err) {
    console.error('Get PR error:', err);
    res.status(500).json({ error: 'Failed to get PR piece' });
  }
}

export async function updatePR(req, res) {
  try {
    const { prId } = req.params;
    const { title, body, status } = req.body;

    const pr = await PRPiece.findOne({ id: prId, user_id: req.userId }).select('id -_id').lean();
    if (!pr) {
      return res.status(404).json({ error: 'PR piece not found' });
    }

    const set = {};
    if (typeof title === 'string' && title.trim()) set.title = title.trim();
    if (typeof body === 'string') set.body = body;
    if (status !== undefined) {
      if (!PR_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      set.status = status;
    }

    if (Object.keys(set).length) {
      await PRPiece.updateOne({ id: prId }, { $set: set });
    }
    res.json({ id: prId });
  } catch (err) {
    console.error('Update PR error:', err);
    res.status(500).json({ error: 'Failed to update PR piece' });
  }
}

export async function deletePR(req, res) {
  try {
    const result = await PRPiece.deleteOne({ id: req.params.prId, user_id: req.userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'PR piece not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete PR error:', err);
    res.status(500).json({ error: 'Failed to delete PR piece' });
  }
}
