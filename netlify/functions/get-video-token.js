const crypto = require('crypto');

// Supabase anon key - safe to include; it is a public key already in every HTML page
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13c3Fia2dnY2NyeWp1ZGpyb21uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3ODc1MTIsImV4cCI6MjEwNzM2MzUxMn0.vZX7-SCCWUu40PUnh3sa9HOiiJEKfCgvSAUnck5Cq1g';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const authHeader = event.headers['authorization'] || '';
  const userToken = authHeader.replace('Bearer ', '').trim();
  if (!userToken) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 1. Verify the user JWT via Supabase Auth
  const authRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + userToken },
  });
  if (!authRes.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token', debug_auth_status: authRes.status }) };
  const authUser = await authRes.json();
  const userId = authUser.id;
  if (!userId) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No user id' }) };

  // 2. Check membership using user's JWT + anon key (RLS: users_read_own_profile)
  const profileRes = await fetch(
    SUPABASE_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=is_member&limit=1',
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + userToken, 'Accept': 'application/json' } }
  );
  const profileData = await profileRes.json();
  const profile = Array.isArray(profileData) ? profileData[0] : null;
  if (!profile || !profile.is_member) {
    return { statusCode: 403, headers, body: JSON.stringify({
      error: 'Active membership required',
      debug_user_id: userId, debug_profile: profile,
      debug_profile_status: profileRes.status,
      debug_profile_count: Array.isArray(profileData) ? profileData.length : -1,
    })};
  }

  // 3. Parse videoId from request body
  let videoId;
  try { ({ videoId } = JSON.parse(event.body || '{}')); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid body' }) }; }
  if (!videoId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'videoId required' }) };

  // 4. Verify video exists in our DB
  const videoRes = await fetch(
    SUPABASE_URL + '/rest/v1/videos?bunny_video_id=eq.' + videoId + '&select=id&limit=1',
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + userToken, 'Accept': 'application/json' } }
  );
  const videoData = await videoRes.json();
  if (!Array.isArray(videoData) || videoData.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Video not found' }) };

  // 5. Generate Bunny Stream token-signed embed URL
  // Bunny token formula: SHA256(TokenAuthKey + VideoId + Expires)
  const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID;
  const BUNNY_TOKEN_KEY = process.env.BUNNY_TOKEN_AUTH_KEY;
  const expires = Math.floor(Date.now() / 1000) + 7200;
  const securityToken = crypto.createHash('sha256').update(BUNNY_TOKEN_KEY + videoId + expires).digest('hex');
  const embedUrl = 'https://iframe.mediadelivery.net/embed/' + BUNNY_LIBRARY_ID + '/' + videoId + '?token=' + securityToken + '&expires=' + expires;

  return { statusCode: 200, headers, body: JSON.stringify({ embedUrl }) };
};
