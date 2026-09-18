import { randomUUID } from 'crypto';
import { Content, Brand, GeneratedImage } from './models/index.js';
import { generateImageDataUri } from './imagegen.js';
import { buildBrandSystemPrompt } from './brandBrain.js';
import { claudeText, splitVersions, PLAIN_TEXT_RULES } from './llm.js';
import { mediaUrl } from './media.js';

// POST /api/content/generate
// Body: brandId, contentType, platform, topic, tone, length, hashtags, cta,
//   generateImage,
//   preview   - true: return versions only, save nothing (voice tests, samples)
//   contentId - regenerate into this existing draft instead of creating a new one
export async function generateContent(req, res) {
  try {
    const { brandId, contentType, platform, topic, tone, length, hashtags: includeHashtags, cta, generateImage, preview, contentId: targetId } = req.body;
    const userId = req.userId;

    if (!topic || !String(topic).trim()) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const brand = await Brand.findOne({ id: brandId, user_id: userId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    let target = null;
    if (targetId) {
      target = await Content.findOne({ id: targetId, user_id: userId }).select('id status -_id').lean();
      if (!target) return res.status(404).json({ error: 'Content not found' });
      if (target.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be regenerated' });
    }

    // Build comprehensive system prompt from the brand profile (Brand Brain)
    const systemPrompt = `${buildBrandSystemPrompt(brand)}\n\nGenerate 3 versions separated by ===VERSION===. ONLY content, no explanations. ${PLAIN_TEXT_RULES}`;

    // Pull hashtags from the brand profile when available
    const profile = (brand.content_preferences && typeof brand.content_preferences === 'object')
      ? brand.content_preferences : {};
    const hashtagBank = profile.hashtag_bank?.[platform?.toLowerCase()] || [];
    const hashtagSuggestion = hashtagBank.length > 0
      ? ` Use these hashtags when relevant: ${hashtagBank.join(', ')}.` : '';

    const userPrompt = `Generate a ${contentType} for ${platform}. Topic: ${topic}. Tone: ${tone}. Length: ${length}.${includeHashtags ? ` Include relevant hashtags.${hashtagSuggestion}` : ' Do not include hashtags.'}${cta ? ' Include a call-to-action.' : ''}`;

    const versions = splitVersions(await claudeText({ system: systemPrompt, prompt: userPrompt, maxTokens: 2048 }));
    if (versions.length === 0) {
      return res.status(502).json({ error: 'The AI returned an empty response. Please try again.' });
    }

    if (preview) {
      return res.json({ versions, platform, type: contentType });
    }

    const fields = {
      type: contentType,
      platform,
      body: versions,
      ai_prompt: userPrompt,
      media_brief: topic
    };

    let contentId;
    if (target) {
      contentId = target.id;
      await Content.updateOne({ id: contentId }, { $set: fields });
    } else {
      contentId = randomUUID();
      await Content.create({ id: contentId, brand_id: brandId, user_id: userId, hashtags: [], status: 'draft', ...fields });
    }

    let imageUrl = null;
    let imageError = null;
    if (generateImage) {
      try {
        imageUrl = await generateImageForContent(contentId, brand, userId, topic);
      } catch (err) {
        console.error('Image generation error:', err);
        imageError = 'Text was generated, but the image could not be created. Try "Regenerate image".';
      }
    }
    if (!imageUrl) {
      const existing = await Content.findOne({ id: contentId }).select('id image_url -_id').lean();
      imageUrl = mediaUrl('content', contentId, existing?.image_url);
    }

    res.json({
      id: contentId,
      versions,
      imageUrl,
      imageError,
      platform,
      type: contentType
    });
  } catch (err) {
    console.error('Generate content error:', err);
    res.status(500).json({ error: 'Failed to generate content' });
  }
}

async function createImage({ contentId, brand, userId, prompt }) {
  const imageUri = await generateImageDataUri(prompt);
  if (!imageUri) {
    throw new Error('Image generation failed with both models');
  }

  await GeneratedImage.create({
    id: randomUUID(),
    content_id: contentId,
    brand_id: brand.id,
    user_id: userId,
    prompt,
    image_url: imageUri
  });

  await Content.updateOne({ id: contentId }, { $set: { image_url: imageUri } });
  return mediaUrl('content', contentId, imageUri);
}

export async function generateImageForContent(contentId, brand, userId, topic) {
  // Ask Claude for a detailed image prompt
  const prompt = await claudeText({
    maxTokens: 256,
    prompt: `Write a detailed image prompt for a ${brand.name} post about: ${topic}. No text in image. Match brand colors ${JSON.stringify(brand.colors || {})}. Respond with ONLY the prompt.`
  });
  return createImage({ contentId, brand, userId, prompt });
}

export async function regenerateImage(req, res) {
  try {
    const { contentId, versionIndex } = req.body;
    const userId = req.userId;

    const content = await Content.findOne({ id: contentId, user_id: userId }).lean();
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const brand = await Brand.findOne({ id: content.brand_id }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const versions = Array.isArray(content.body) ? content.body : [content.body];
    const versionText = String(versions[versionIndex] || versions[0] || content.media_brief || '');

    const prompt = await claudeText({
      maxTokens: 256,
      prompt: `Write a detailed image prompt for this ${content.platform} post: "${versionText.substring(0, 400)}". No text in image. Match brand colors ${JSON.stringify(brand.colors || {})}. Respond with ONLY the prompt.`
    });

    const imageUrl = await createImage({ contentId, brand, userId, prompt });
    res.json({ imageUrl, contentId, versionIndex });
  } catch (err) {
    console.error('Regenerate image error:', err);
    res.status(500).json({ error: 'Failed to regenerate image' });
  }
}
