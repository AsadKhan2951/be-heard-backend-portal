import { randomUUID } from 'crypto';
import { GeneratedImage, Brand, Content } from './models/index.js';
import { generateImageDataUri } from './imagegen.js';
import { claudeText } from './llm.js';
import { mediaUrl, mediaUrlExpr } from './media.js';

const FORMATS = {
  'ig-post': { name: 'Instagram Post', ratio: '1:1' },
  'ig-story': { name: 'Instagram Story', ratio: '9:16' },
  'carousel': { name: 'Carousel', ratio: '1:1' },
  'cover': { name: 'Cover Image', ratio: '16:9' },
  'banner': { name: 'Banner', ratio: '1280:400' }
};

const STYLES = ['Photo', 'Illustration', 'Abstract', '3D', 'Flat', 'Minimal'];

export async function generateCreative(req, res) {
  try {
    const { brandId, contentId, description, format, style } = req.body;
    const userId = req.userId;

    if (!FORMATS[format] || !STYLES.includes(style)) {
      return res.status(400).json({ error: 'Invalid format or style' });
    }

    const brand = await Brand.findOne({ id: brandId, user_id: userId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    if (contentId && !(await Content.exists({ id: contentId, user_id: userId }))) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const imagePrompt = await claudeText({
      maxTokens: 512,
      prompt: `Create a detailed image prompt for a ${FORMATS[format].name} (${FORMATS[format].ratio}) in ${style} style for ${brand.name}${brand.industry ? `, a ${brand.industry} brand` : ''}.
${description ? `Context: ${description}` : ''}
Brand colors: ${JSON.stringify(brand.colors || {})}

Requirements:
- Professional, high-quality
- No text or watermarks
- Optimized for ${FORMATS[format].name}
- Style: ${style}
- Aspect ratio: ${FORMATS[format].ratio}

Respond with ONLY the detailed image prompt.`
    });

    const imageUri = await generateImageDataUri(imagePrompt);
    if (!imageUri) {
      return res.status(502).json({ error: 'Failed to generate image. Please try again.' });
    }

    const creativeId = randomUUID();
    await GeneratedImage.create({
      id: creativeId,
      content_id: contentId || null,
      brand_id: brandId,
      user_id: userId,
      prompt: imagePrompt,
      image_url: imageUri,
      format
    });

    res.json({
      id: creativeId,
      imageUrl: mediaUrl('creative', creativeId, imageUri),
      prompt: imagePrompt,
      format,
      style,
      brandId,
      contentId
    });
  } catch (err) {
    console.error('Generate creative error:', err);
    res.status(500).json({ error: 'Failed to generate creative' });
  }
}

export async function getCreativeGallery(req, res) {
  try {
    const filter = { user_id: req.userId };
    if (req.query.brandId) filter.brand_id = req.query.brandId;

    const images = await GeneratedImage.aggregate([
      { $match: filter },
      { $sort: { created_at: -1 } },
      { $set: { image_url: mediaUrlExpr('creative') } },
      { $project: { _id: 0, image_data: 0 } }
    ]);

    // Attach brand_name
    const brandIds = [...new Set(images.map(i => i.brand_id).filter(Boolean))];
    const brands = await Brand.find({ id: { $in: brandIds } }).select('id name -_id').lean();
    const brandNameById = Object.fromEntries(brands.map(b => [b.id, b.name]));

    res.json(images.map(i => ({ ...i, brand_name: brandNameById[i.brand_id] || null })));
  } catch (err) {
    console.error('Get creative gallery error:', err);
    res.status(500).json({ error: 'Failed to get gallery' });
  }
}

export async function regenerateCreative(req, res) {
  try {
    const { creativeId } = req.params;

    const creative = await GeneratedImage.findOne({ id: creativeId, user_id: req.userId }).select('id prompt -_id').lean();
    if (!creative) {
      return res.status(404).json({ error: 'Creative not found' });
    }

    const imageUri = await generateImageDataUri(creative.prompt);
    if (!imageUri) {
      return res.status(502).json({ error: 'Failed to regenerate image. Please try again.' });
    }

    await GeneratedImage.updateOne({ id: creativeId }, { $set: { image_url: imageUri } });

    res.json({ id: creativeId, imageUrl: mediaUrl('creative', creativeId, imageUri) });
  } catch (err) {
    console.error('Regenerate creative error:', err);
    res.status(500).json({ error: 'Failed to regenerate creative' });
  }
}

export async function deleteCreative(req, res) {
  try {
    const result = await GeneratedImage.deleteOne({ id: req.params.creativeId, user_id: req.userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Creative not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete creative error:', err);
    res.status(500).json({ error: 'Failed to delete creative' });
  }
}
