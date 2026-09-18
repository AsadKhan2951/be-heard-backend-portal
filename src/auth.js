import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { randomUUID } from 'crypto';
import { User, Brand, Content, Campaign, PRPiece, GeneratedImage, Analytics } from './models/index.js';
import { JWT_SECRET } from './config.js';
import { exactInsensitive } from './utils.js';
import { loginKey, resetRateLimit } from './ratelimit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.userId = decoded.userId;
  next();
}

// Older accounts may have been stored with mixed-case emails.
function findUserByEmail(email) {
  return User.findOne({ email: exactInsensitive(email) }).lean();
}

function authResponse(user, token) {
  return {
    token,
    userId: user.id,
    id: user.id,
    email: user.email,
    name: user.name,
    company_name: user.company_name,
    plan: user.plan,
    onboarding_complete: user.onboarding_complete
  };
}

export async function signup(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const user = {
      id: randomUUID(),
      email,
      name: name || email.split('@')[0],
      password_hash: await bcryptjs.hash(password, 10),
      plan: 'starter',
      onboarding_complete: 0
    };
    await User.create(user);

    res.json(authResponse(user, generateToken(user.id)));
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
}

export async function login(req, res) {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcryptjs.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    resetRateLimit(loginKey(email));
    res.json(authResponse(user, generateToken(user.id)));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
}

export async function getMe(req, res) {
  try {
    const user = await User.findOne({ id: req.userId })
      .select('id email name company_name plan onboarding_complete created_at -_id')
      .lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
}

export async function updateMe(req, res) {
  try {
    const set = {};
    if (typeof req.body.name === 'string' && req.body.name.trim()) set.name = req.body.name.trim();
    if (typeof req.body.company_name === 'string') set.company_name = req.body.company_name.trim();

    if (Object.keys(set).length > 0) {
      await User.updateOne({ id: req.userId }, { $set: set });
    }
    return getMe(req, res);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
}

export async function deleteAccount(req, res) {
  try {
    const userId = req.userId;
    const brandIds = (await Brand.find({ user_id: userId }).select('id -_id').lean()).map(b => b.id);
    await Promise.all([
      User.deleteOne({ id: userId }),
      Brand.deleteMany({ user_id: userId }),
      Content.deleteMany({ user_id: userId }),
      Campaign.deleteMany({ user_id: userId }),
      PRPiece.deleteMany({ user_id: userId }),
      GeneratedImage.deleteMany({ user_id: userId }),
      Analytics.deleteMany({ brand_id: { $in: brandIds } })
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}
