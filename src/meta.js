import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Brand } from './models/index.js';
import { JWT_SECRET, META_API_VERSION, META_GRAPH_URL, appUrl, clientUrl } from './config.js';

const RETURN_PATHS = ['brand', 'onboarding'];

function redirectUri() {
  return `${appUrl()}/api/meta/callback`;
}

function returnPath(returnTo, brandId) {
  if (returnTo === 'onboarding') return '/onboarding';
  return brandId ? `/brand/${brandId}` : '/dashboard';
}

// GET /api/meta/oauth-url?brandId=...&returnTo=brand|onboarding  (authenticated)
// Returns the Facebook OAuth URL. brandId + userId are carried in a signed `state`.
export async function getMetaOAuthUrl(req, res) {
  try {
    const { brandId } = req.query;
    const returnTo = RETURN_PATHS.includes(req.query.returnTo) ? req.query.returnTo : 'brand';
    const userId = req.userId;

    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
      return res.status(400).json({ error: 'Meta is not configured on the server (META_APP_ID / META_APP_SECRET missing).' });
    }
    if (!appUrl()) {
      return res.status(400).json({ error: 'Meta is not configured on the server (APP_URL missing).' });
    }
    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    const brand = await Brand.findOne({ id: brandId, user_id: userId }).select('id -_id').lean();
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const state = jwt.sign({ brandId, userId, returnTo }, JWT_SECRET, { expiresIn: '15m' });
    const scopes = [
      'pages_show_list',
      'pages_manage_posts',
      'pages_read_engagement',
      'read_insights',
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_insights'
    ].join(',');

    const url = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?` +
      `client_id=${encodeURIComponent(process.env.META_APP_ID)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri())}&` +
      `state=${encodeURIComponent(state)}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `response_type=code`;

    res.json({ url });
  } catch (err) {
    console.error('Get Meta OAuth URL error:', err);
    res.status(500).json({ error: 'Failed to build Meta OAuth URL' });
  }
}

// GET /api/meta/callback  (hit by Facebook's redirect — NOT authenticated)
// Exchanges the code for a long-lived token, finds the page + IG account,
// saves them to the brand, then redirects back to the frontend.
export async function handleMetaCallback(req, res) {
  const client = clientUrl();
  let path = '/dashboard';
  const fail = (message) =>
    res.redirect(`${client}${path}?meta=error&message=${encodeURIComponent(message)}`);

  try {
    const { code, state } = req.query;

    let payload = null;
    try {
      payload = state ? jwt.verify(state, JWT_SECRET) : null;
    } catch {
      return fail('Your Meta connection link expired. Please try again.');
    }
    if (payload) path = returnPath(payload.returnTo, payload.brandId);

    if (req.query.error) {
      return fail(req.query.error_description || 'Meta connection was cancelled');
    }
    if (!code || !payload) return fail('Missing authorization code');

    const { brandId, userId } = payload;

    // 1) Exchange code for a short-lived user token
    const tokenRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri(),
        code
      }
    });

    // 2) Upgrade to a long-lived user token. Page tokens obtained with a
    //    long-lived user token do not expire; with a short-lived one they die
    //    after about an hour.
    const longRes = await axios.get(`${META_GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: tokenRes.data.access_token
      }
    });
    const userToken = longRes.data.access_token;

    // 3) Get the user's Facebook pages (with any linked Instagram account)
    const pagesRes = await axios.get(`${META_GRAPH_URL}/me/accounts`, {
      params: { fields: 'id,name,access_token,instagram_business_account', access_token: userToken }
    });
    const pages = pagesRes.data.data || [];
    if (pages.length === 0) return fail('No Facebook pages found on this account');

    // Prefer a page that has an Instagram business account linked
    const page = pages.find(p => p.instagram_business_account?.id) || pages[0];

    // 4) Save to the brand
    const result = await Brand.updateOne(
      { id: brandId, user_id: userId },
      {
        $set: {
          meta_page_id: page.id,
          meta_page_name: page.name,
          meta_page_token: page.access_token,
          meta_ig_account_id: page.instagram_business_account?.id || null,
          meta_connected_at: new Date()
        }
      }
    );
    if (result.matchedCount === 0) return fail('Brand not found');

    return res.redirect(`${client}${path}?meta=connected`);
  } catch (err) {
    console.error('Meta callback error:', err.response?.data || err.message);
    return fail(err.response?.data?.error?.message || 'Failed to connect Meta account');
  }
}
