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

  // 1. Verify Supabase JWT
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Client for auth verification
  const sbAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: { user }, error: authError } = await sbAdmin.auth.getUser(token);
  if (authError || !user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token', debug_auth_error: authError?.message }) };
  }

  // 2. Check membership using a fresh admin client
  // Separate client so auth.getUser() context does not bleed into DB queries
  const sbDb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: profile, error: profileError } = await sbDb
    .from('profiles')
    .select('is_member')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.is_member) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: 'Active membership required',
        debug_user_id: user.id,
        debug_profile: profile,
        debug_profile_error: profileError?.message,
      }),
    };
  }

  // 3. Parse and validate request body
  let videoId;
  try {
    ({ videoId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid body' }) };
  }
  if (!videoId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'videoId required' }) };
  }

  // Confirm the videoId exists in our videos table
  const { data: video } = await sbDb.from('videos').select('id').eq('bunny_video_id', videoId).single();
  if (!video) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Video not found' }) };
  }

  // 4. Generate Bunny Stream token-signed embed URL
  const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID;
  const BUNNY_TOKEN_KEY  = process.env.BUNNY_TOKEN_AUTH_KEY;
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 2; // 2-hour expiry

  // Bunny token hash: SHA256(securityKey + libraryId + expires + videoId)
  const tokenString = BUNNY_TOKEN_KEY + BUNNY_LIBRARY_ID + expires + videoId;
  const securityToken = crypto.createHash('sha256').update(tokenString).digest('hex');

  const embedUrl = `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${videoId}?token=${securityToken}&expires=${expires}`;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ embedUrl }),
  };
};
