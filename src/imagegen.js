import { GoogleGenerativeAI } from '@google/generative-ai';
import { compressDataUri } from './imageutil.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Generate an image from a text prompt and return it as a base64 data URI.
 * Images are stored inline (in MongoDB) instead of on the local filesystem so
 * the backend stays stateless and works on ephemeral hosts like Railway.
 *
 * PNG output is re-encoded as JPEG, which is several times smaller and is the
 * only format Instagram accepts.
 *
 * Returns a `data:<mime>;base64,<data>` string, or null if generation failed.
 */
export async function generateImageDataUri(prompt) {
  const uri = await generateRaw(prompt);
  return uri ? compressDataUri(uri) : null;
}

async function generateRaw(prompt) {
  const tryModel = async (modelName, withModalities) => {
    const model = genAI.getGenerativeModel({ model: modelName });
    const request = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    if (withModalities) {
      request.generationConfig = { responseModalities: ['image', 'text'] };
    }

    const result = await model.generateContent(request);
    const parts = result.response?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        const mime = part.inlineData.mimeType || 'image/png';
        return `data:${mime};base64,${part.inlineData.data}`;
      }
    }
    return null;
  };

  // Primary: Gemini 2.5 Flash Image (aka "Nano Banana", GA)
  try {
    const dataUri = await tryModel('gemini-2.5-flash-image', true);
    if (dataUri) return dataUri;
  } catch (err) {
    console.warn('gemini-2.5-flash-image failed, trying gemini-3.1-flash-image:', err.message);
  }

  // Fallback: Gemini 3.1 Flash Image
  try {
    const dataUri = await tryModel('gemini-3.1-flash-image', true);
    if (dataUri) return dataUri;
  } catch (err) {
    console.error('gemini-3.1-flash-image failed:', err.message);
  }

  return null;
}
