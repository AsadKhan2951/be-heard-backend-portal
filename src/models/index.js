import mongoose from 'mongoose';

const { Schema } = mongoose;
const opts = { versionKey: false };

// ----- Users -----
const userSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true },
  name: String,
  password_hash: { type: String, required: true },
  company_name: String,
  plan: { type: String, default: 'starter' },
  onboarding_complete: { type: Number, default: 0 },
  preferences: { type: Object, default: {} },
  created_at: { type: Date, default: Date.now }
}, opts);

// ----- Brands -----
const brandSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  user_id: { type: String, index: true },
  name: { type: String, required: true },
  logo_url: String,
  colors: { type: Object, default: { primary: '#BFFF00', secondary: '#0a0a0a' } },
  voice_description: String,
  target_audience: String,
  industry: String,
  competitors: { type: Array, default: [] },
  sample_content: String,
  content_preferences: { type: Object, default: {} },
  meta_page_id: String,
  meta_page_name: String,
  meta_page_token: String,
  meta_ig_account_id: String,
  meta_connected_at: Date,
  website_url: String,
  onboarding_step: { type: Number, default: 1 },
  onboarding_complete: { type: Number, default: 0 },
  active: { type: Number, default: 1 },
  created_at: { type: Date, default: Date.now }
}, opts);

// ----- Content -----
const contentSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  brand_id: { type: String, index: true },
  user_id: { type: String, index: true },
  type: { type: String, required: true },
  platform: String,
  title: String,
  body: { type: Schema.Types.Mixed, required: true }, // array of versions or string
  image_url: String,
  image_data: String,
  media_brief: String,
  hashtags: { type: Array, default: [] },
  // draft | scheduled | publishing | published | failed
  status: { type: String, default: 'draft' },
  scheduled_for: Date,
  published_at: Date,
  meta_post_id: String,
  // Post ids per platform, e.g. { instagram: '...', facebook: '...' }
  meta_post_ids: { type: Object, default: {} },
  publish_error: String,
  campaign_id: { type: String, index: true },
  // Position of this item in its campaign's content_plan
  plan_index: Number,
  performance: { type: Object, default: {} },
  ai_prompt: String,
  version: { type: Number, default: 1 },
  created_at: { type: Date, default: Date.now }
}, opts);

// ----- Campaigns -----
const campaignSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  brand_id: { type: String, index: true },
  user_id: { type: String, index: true },
  name: { type: String, required: true },
  objective: String,
  target_audience: String,
  channels: { type: Array, default: [] },
  frequency: String,
  start_date: String,
  end_date: String,
  budget: String,
  status: { type: String, default: 'planning' },
  strategy: String,
  key_messages: { type: Array, default: [] },
  content_plan: { type: Array, default: [] },
  kpis: { type: Object, default: {} },
  performance_summary: { type: Object, default: {} },
  // Background content generation: idle | running | done | failed
  generation_status: { type: String, default: 'idle' },
  generation_started_at: Date,
  generation_errors: { type: Array, default: [] },
  created_at: { type: Date, default: Date.now }
}, opts);

// ----- PR pieces -----
const prPieceSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  brand_id: { type: String, index: true },
  user_id: { type: String, index: true },
  type: String,
  title: String,
  body: String,
  target_outlets: { type: Array, default: [] },
  // draft | final
  status: { type: String, default: 'draft' },
  created_at: { type: Date, default: Date.now }
}, opts);

// ----- Analytics -----
const analyticsSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  brand_id: { type: String, index: true },
  platform: String,
  metric_name: String,
  metric_value: Schema.Types.Mixed,
  date: String,
  data: { type: Object, default: {} },
  recorded_at: { type: Date, default: Date.now },
  created_at: { type: Date, default: Date.now }
}, opts);

// ----- Generated images -----
const generatedImageSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  content_id: { type: String, index: true },
  brand_id: { type: String, index: true },
  user_id: { type: String, index: true },
  prompt: String,
  image_url: String, // base64 data URI
  image_data: String,
  format: String,
  created_at: { type: Date, default: Date.now }
}, opts);

export const User = mongoose.model('User', userSchema);
export const Brand = mongoose.model('Brand', brandSchema);
export const Content = mongoose.model('Content', contentSchema);
export const Campaign = mongoose.model('Campaign', campaignSchema);
export const PRPiece = mongoose.model('PRPiece', prPieceSchema);
export const Analytics = mongoose.model('Analytics', analyticsSchema);
export const GeneratedImage = mongoose.model('GeneratedImage', generatedImageSchema);
