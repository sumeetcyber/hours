import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;
const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = (process.env.APP_URL || 'https://hours-yvm9.onrender.com').replace(/\/+$/, '');

if (!URL || !ANON || !SERVICE) throw new Error('Missing Supabase environment variables');

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const auth = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

function setSession(res, session) {
  res.cookie('hours_access', session.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: (session.expires_in || 3600) * 1000,
    path: '/'
  });
  res.cookie('hours_refresh', session.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 90 * 24 * 3600 * 1000,
    path: '/'
  });
}

function clearSession(res) {
  res.clearCookie('hours_access', { path: '/' });
  res.clearCookie('hours_refresh', { path: '/' });
}

function setGuestCookie(res, id) {
  res.cookie('hours_guest', id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 365 * 24 * 3600 * 1000,
    path: '/'
  });
}

function clearGuestCookie(res) {
  res.clearCookie('hours_guest', { path: '/' });
}

function newGuestId() {
  return crypto.randomUUID();
}

function defaultState() {
  return { pursuits: [], entries: [], active: null, theme: 'system', wishfulDefault: 8 };
}

function sanitizeState(s) {
  if (!s || typeof s !== 'object') throw new Error('bad state');
  return {
    pursuits: Array.isArray(s.pursuits) ? JSON.parse(JSON.stringify(s.pursuits)) : [],
    entries: Array.isArray(s.entries) ? JSON.parse(JSON.stringify(s.entries)) : [],
    active: s.active || null,
    theme: String(s.theme || 'system'),
    wishfulDefault: Number(s.wishfulDefault || 0)
  };
}

function hasData(s) {
  return !!(s && ((s.pursuits?.length || 0) || (s.entries?.length || 0)));
}

async function readAccountState(userId) {
  const { data, error } = await admin.from('user_state').select('state').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.state || defaultState();
}

async function readGuestState(guestId) {
  const { data, error } = await admin.from('guest_state').select('state').eq('guest_id', guestId).maybeSingle();
  if (error) throw error;
  return data?.state || defaultState();
}

async function writeAccountState(userId, state) {
  const { error } = await admin.from('user_state').upsert({
    user_id: userId,
    state: sanitizeState(state),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function writeGuestState(guestId, state) {
  const { error } = await admin.from('guest_state').upsert({
    guest_id: guestId,
    state: sanitizeState(state),
    updated_at: new Date().toISOString()
  }, { onConflict: 'guest_id' });
  if (error) throw error;
}

async function getUser(req, res, next) {
  let token = req.cookies.hours_access;
  if (!token) return res.status(401).json({ error: 'unauthenticated' });

  let { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) {
    const refresh = req.cookies.hours_refresh;
    if (!refresh) return res.status(401).json({ error: 'unauthenticated' });
    const r = await auth.auth.refreshSession({ refresh_token: refresh });
    if (r.error || !r.data.session) {
      clearSession(res);
      return res.status(401).json({ error: 'unauthenticated' });
    }
    setSession(res, r.data.session);
    const refreshed = await auth.auth.getUser(r.data.session.access_token);
    if (refreshed.error || !refreshed.data.user) {
      clearSession(res);
      return res.status(401).json({ error: 'unauthenticated' });
    }
    data = refreshed.data;
  }
  req.user = data.user;
  next();
}

async function getGuest(req, res, next) {
  try {
    let id = req.cookies.hours_guest;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      if (req.query.create !== '1') return res.status(401).json({ error: 'no guest session' });
      id = newGuestId();
      setGuestCookie(res, id);
    }
    req.guestId = id;
    next();
  } catch {
    res.status(500).json({ error: 'guest unavailable' });
  }
}

async function getIdentity(req, res, next) {
  if (req.cookies.hours_access) {
    return getUser(req, res, next);
  }
  return getGuest(req, res, next);
}

async function mergeGuestIntoAccount(userId, guestId) {
  if (!guestId) return;
  const guest = await readGuestState(guestId);
  if (!hasData(guest)) return;

  const account = await readAccountState(userId);
  if (!hasData(account)) {
    await writeAccountState(userId, guest);
  } else {
    const merged = JSON.parse(JSON.stringify(account));
    const pursuitsById = new Map((merged.pursuits || []).map(p => [p.id, p]));
    for (const p of guest.pursuits || []) {
      if (!pursuitsById.has(p.id)) {
        merged.pursuits.push(p);
      }
    }
    const entryIds = new Set((merged.entries || []).map(e => e.id));
    for (const e of guest.entries || []) {
      if (!entryIds.has(e.id)) merged.entries.push(e);
    }
    merged.theme = account.theme || guest.theme || 'system';
    merged.wishfulDefault = account.wishfulDefault || guest.wishfulDefault || 8;
    await writeAccountState(userId, merged);
  }

  await admin.from('guest_state').delete().eq('guest_id', guestId);
}

app.post('/api/auth/register/send-otp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  const r = await auth.auth.signUp({ email, password });
  if (r.error) return res.status(400).json({ error: r.error.message });
  res.json({ ok: true });
});

app.post('/api/auth/register/verify-otp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const token = String(req.body.token || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{8}$/.test(token)) {
    return res.status(400).json({ error: 'invalid registration details' });
  }

  const r = await auth.auth.verifyOtp({ email, token, type: 'signup' });
  if (r.error || !r.data.user) return res.status(401).json({ error: r.error?.message || 'invalid code' });

  try { await mergeGuestIntoAccount(r.data.user.id, req.cookies.hours_guest); } catch { return res.status(500).json({ error: 'could not sync guest data' }); }
  clearSession(res);
  clearGuestCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const r = await auth.auth.signInWithPassword({ email, password });
  if (r.error || !r.data.session) return res.status(401).json({ error: r.error?.message || 'invalid credentials' });
  try { await mergeGuestIntoAccount(r.data.user.id, req.cookies.hours_guest); } catch {}
  setSession(res, r.data.session);
  clearGuestCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const r = await auth.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/` });
  if (r.error) return res.status(400).json({ error: r.error.message });
  res.json({ ok: true });
});

app.post('/api/auth/reset-password/complete', async (req, res) => {
  const accessToken = String(req.body.access_token || '');
  const password = String(req.body.password || '');
  if (!accessToken || password.length < 8) return res.status(400).json({ error: 'invalid password reset' });
  const { data, error } = await auth.auth.getUser(accessToken);
  if (error || !data.user) return res.status(401).json({ error: 'invalid reset session' });
  const r = await admin.auth.admin.updateUserById(data.user.id, { password });
  if (r.error) return res.status(400).json({ error: r.error.message });
  res.json({ ok: true });
});

app.post('/api/auth/set-password', getUser, async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  const r = await admin.auth.admin.updateUserById(req.user.id, { password });
  if (r.error) return res.status(400).json({ error: r.error.message });
  res.json({ ok: true });
});

app.delete('/api/auth/delete-account', getUser, async (req, res) => {
  const userId = req.user.id;
  try {
    await admin.from('user_state').delete().eq('user_id', userId);
    await admin.auth.admin.deleteUser(userId);
    clearSession(res);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'account deletion failed' });
  }
});

app.post('/api/auth/signout', getUser, async (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', getUser, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

app.get('/api/guest', getGuest, async (req, res) => {
  try {
    res.json({ guest: true, state: await readGuestState(req.guestId) });
  } catch {
    res.status(500).json({ error: 'guest state unavailable' });
  }
});

app.get('/api/state', getIdentity, async (req, res) => {
  try {
    const state = req.user ? await readAccountState(req.user.id) : await readGuestState(req.guestId);
    res.json(state);
  } catch {
    res.status(500).json({ error: 'state read failed' });
  }
});

app.put('/api/state', getIdentity, async (req, res) => {
  try {
    const state = sanitizeState(req.body);
    if (req.user) {
      await writeAccountState(req.user.id, state);
    } else {
      await writeGuestState(req.guestId, state);
    }
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'invalid state' });
  }
});

app.delete('/api/guest', getGuest, async (req, res) => {
  try {
    await admin.from('guest_state').delete().eq('guest_id', req.guestId);
    clearGuestCookie(res);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'guest deletion failed' });
  }
});

const sse = new Map();

app.get('/api/events', getIdentity, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const key = req.user ? `u:${req.user.id}` : `g:${req.guestId}`;
  if (!sse.has(key)) sse.set(key, new Set());
  sse.get(key).add(res);
  res.write('event: ready\ndata: {}\n\n');
  req.on('close', () => {
    sse.get(key)?.delete(res);
    if (!sse.get(key)?.size) sse.delete(key);
  });
});

admin.channel('hours-server-state').on('postgres_changes', { event: '*', schema: 'public', table: 'user_state' }, payload => {
  const uid = payload.new?.user_id || payload.old?.user_id;
  if (!uid) return;
  for (const res of sse.get(`u:${uid}`) || []) {
    res.write(`event: state\ndata: ${JSON.stringify({ updated_at: payload.new?.updated_at || null })}\n\n`);
  }
}).subscribe();

app.use(express.static('public', { index: 'index.html', extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api')) return res.status(500).json({ error: err.message || 'server error' });
  next(err);
});

app.use((req, res) => res.sendFile(process.cwd() + '/public/index.html'));

app.listen(PORT, () => console.log(`HOURS online on :${PORT}`));
