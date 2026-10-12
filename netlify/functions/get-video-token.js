// netlify/functions/get-video-token.js
// Returns a time-limited Bunny Stream embed URL for a given videoId.
// Only accessible to authenticated Supabase members.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── 1. Verify Supabase JWT ──────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY  // service role key to bypass RLS for lookup
  );

  // Get user from token
  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  // Check membership
  const { data: profile } = await sb.from('profiles').select('is_member').eq('id', user.id).single();
  if (!profile?.is_member) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Active membership required' }) };
  }

  // ── 2. Parse and validate request body ────────────────────────────────────
  let videoId;
  try {
    ({ videoId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid body' }) };
  }
  if (!videoId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'videoId required' }) };
  }

  // Confirm the videoId exists in our videos table (prevent token generation for arbitrary IDs)
  const { data: video } = await sb.from('videos').select('id').eq('bunny_video_id', videoId).single();
  if (!video) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Video not found' }) };
  }

  // ── 3. Generate Bunny Stream token-signed embed URL ────────────────────────
  // Bunny Stream token signing: https://docs.bunny.net/docs/stream-embedding-tokens
  const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID;
  const BUNNY_TOKEN_KEY  = process.env.BUNNY_TOKEN_AUTH_KEY;  // Token Authentication Key from Bunny dashboard
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 2; // 2-hour expiry

  // Bunny token hash: SHA256(securityKey + videoId + expires)
  const tokenString = BUNNY_TOKEN_KEY + videoId + expires;
  const securityToken = crypto.createHash('sha256').update(tokenString).digest('hex');

  const embedUrl = `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${videoId}?token=${securityToken}&expires=${expires}`;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ embedUrl }),
  };
};
