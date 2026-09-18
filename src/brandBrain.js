import { claudeText, extractJson } from './llm.js';

const EMPTY_PROFILE = {
  tone_attributes: [],
  dos: [],
  donts: [],
  key_messages: [],
  hashtag_bank: { instagram: [], facebook: [], linkedin: [] },
  personas: [],
  banned_words: []
};

// Settings the user edits by hand; regenerating the AI profile keeps them.
const MANUAL_PREFERENCE_KEYS = ['hashtags_preference', 'content_length'];

// Lightweight HTML -> text (no jsdom dependency)
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scrape brand website (homepage + /about) and return cleaned text.
 * Uses the global fetch (Node 18+). Graceful failure returns null.
 */
export async function scrapeBrandSite(url) {
  try {
    if (!url) return null;

    let fullUrl = url.trim();
    if (!/^https?:\/\//i.test(fullUrl)) fullUrl = 'https://' + fullUrl;

    const fetchText = async (u) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(u, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (BeHeard brand analyzer)' } });
        if (res.ok) return stripHtml(await res.text());
      } catch (err) {
        console.error('Failed to fetch', u, '-', err.message);
      } finally {
        clearTimeout(timeout);
      }
      return '';
    };

    const [home, about] = await Promise.all([
      fetchText(fullUrl),
      fetchText(fullUrl.replace(/\/$/, '') + '/about')
    ]);

    const text = `${home}\n${about}`.replace(/\s+/g, ' ').trim().substring(0, 8000);
    return text || null;
  } catch (err) {
    console.error('Brand site scraping failed:', err.message);
    return null;
  }
}

/**
 * Pre-fill brand suggestions (voice, audience, industry) from website text.
 */
export async function prefillBrandProfile(siteText) {
  try {
    if (!siteText) return {};

    const text = await claudeText({
      maxTokens: 1024,
      prompt: `Based on this website content, suggest a brand voice description, target audience, and industry. Return ONLY valid JSON with keys: voiceDescription, targetAudience, industry.

Website content:
${siteText}`
    });

    return extractJson(text) || {};
  } catch (err) {
    console.error('Prefill failed:', err.message);
    return {};
  }
}

/**
 * Generate a comprehensive brand profile from all collected data.
 * `websiteText` is optional scraped site content.
 */
export async function generateBrandProfile(brand, websiteText = null) {
  const competitors = Array.isArray(brand.competitors)
    ? brand.competitors.join(', ')
    : (brand.competitors || 'Not specified');
  const colors = brand.colors && typeof brand.colors === 'object'
    ? JSON.stringify(brand.colors)
    : (brand.colors || '{}');

  const profilePrompt = `You are a brand strategist. Analyze this brand data and create a comprehensive brand profile.

Brand Name: ${brand.name}
Industry: ${brand.industry || 'Not specified'}
Voice Description: ${brand.voice_description || 'Not specified'}
Target Audience: ${brand.target_audience || 'Not specified'}
Competitors: ${competitors || 'Not specified'}
Sample Content: ${brand.sample_content || 'Not specified'}
Colors: ${colors}
Website Content: ${websiteText || 'Not provided'}

Generate ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "tone_attributes": [
    {"trait": "string", "intensity": 1-5}
  ],
  "dos": ["string"],
  "donts": ["string"],
  "key_messages": ["string"],
  "hashtag_bank": {
    "instagram": ["string"],
    "facebook": ["string"],
    "linkedin": ["string"]
  },
  "personas": [
    {"name": "string", "description": "string", "pain_points": ["string"]}
  ],
  "banned_words": ["string"]
}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const profile = extractJson(await claudeText({ prompt: profilePrompt, maxTokens: 2048 }));
      if (profile) return profile;
    } catch (err) {
      console.error(`Profile generation attempt ${attempt} failed:`, err.message);
    }
  }
  return EMPTY_PROFILE;
}

/**
 * Combine a freshly generated AI profile with the preferences the user set by
 * hand, so regenerating never wipes manual edits.
 */
export function mergeProfile(existing, generated) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const merged = { ...generated };
  for (const key of MANUAL_PREFERENCE_KEYS) {
    if (prev[key] !== undefined) merged[key] = prev[key];
  }
  const banned = new Set([...(prev.banned_words || []), ...(generated.banned_words || [])]);
  merged.banned_words = [...banned];
  return merged;
}

/**
 * Build a comprehensive system prompt from the brand profile.
 * `content_preferences` may be a native object (Mongo) or a JSON string.
 */
export function buildBrandSystemPrompt(brand) {
  let profile = {};
  if (brand.content_preferences) {
    if (typeof brand.content_preferences === 'string') {
      try { profile = JSON.parse(brand.content_preferences); } catch { profile = {}; }
    } else {
      profile = brand.content_preferences;
    }
  }

  const colors = brand.colors && typeof brand.colors === 'object'
    ? JSON.stringify(brand.colors)
    : (brand.colors || '#BFFF00 and #0a0a0a');

  return `You are a content creator for ${brand.name}.

Brand Voice:
${brand.voice_description || 'Professional and engaging'}

Target Audience:
${brand.target_audience || 'General audience'}

Industry: ${brand.industry || 'General'}

Key Messages:
${profile.key_messages?.map(m => `- ${m}`).join('\n') || '- Create engaging content'}

Tone Attributes:
${profile.tone_attributes?.map(t => `- ${t.trait} (intensity: ${t.intensity}/5)`).join('\n') || '- Professional'}

Do's:
${profile.dos?.map(d => `✓ ${d}`).join('\n') || '✓ Be authentic'}

Don'ts:
${profile.donts?.map(d => `✗ ${d}`).join('\n') || '✗ Be misleading'}

Brand Personas:
${profile.personas?.map(p => `- ${p.name}: ${p.description}`).join('\n') || '- General audience'}

Banned Words: ${profile.banned_words?.join(', ') || 'None'}

Brand Colors: ${colors}

When creating content:
1. Reflect the brand voice and tone attributes
2. Address the target audience's needs
3. Follow the do's and don'ts
4. Incorporate key messages naturally
5. Avoid banned words
6. Consider the brand personas`;
}
