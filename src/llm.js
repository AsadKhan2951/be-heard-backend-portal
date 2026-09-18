import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL } from './config.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Send a single-turn prompt to Claude and return the text of the reply.
 */
export async function claudeText({ prompt, system, maxTokens = 1024 }) {
  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }]
  });
  return message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

/**
 * Pull the first JSON object out of a model reply (tolerates code fences and
 * surrounding prose). Returns null if nothing parses.
 */
export function extractJson(text) {
  const match = (text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Leading labels the model sometimes adds, e.g. "**Version 1:**" or "Version 2 -"
const VERSION_LABEL = /^\s*(?:\*\*|__|#+\s*)?\s*(?:version|option|variation)\s*\d+\s*(?:\*\*|__)?\s*[:.\-–—]?\s*(?:\*\*|__)?\s*\n?/i;

/** Split a "===VERSION==="-separated reply into clean versions. */
export function splitVersions(text) {
  return (text || '')
    .split('===VERSION===')
    .map(v => v.trim().replace(VERSION_LABEL, '').trim())
    .filter(Boolean);
}

// Appended to prompts whose output is pasted straight into social platforms.
export const PLAIN_TEXT_RULES = 'Do not label or number the versions. Write plain text ready to paste: no markdown formatting such as ** or # headings.';
