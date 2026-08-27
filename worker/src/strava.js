const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
const TOKENS_KEY = 'strava:tokens';

export function stravaAuthorizeRedirect(request, env) {
  const redirectUri = new URL('/strava/callback', request.url).toString();
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
  });
  return Response.redirect(STRAVA_AUTHORIZE_URL + '?' + params.toString(), 302);
}

export async function stravaOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code) {
    return Response.redirect(env.FRONTEND_URL + '?strava_error=1', 302);
  }
  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) {
    return Response.redirect(env.FRONTEND_URL + '?strava_error=1', 302);
  }
  const data = await resp.json();
  await env.APP_KV.put(TOKENS_KEY, JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at, // unix seconds
  }));
  return Response.redirect(env.FRONTEND_URL + '?strava_connected=1', 302);
}

async function getValidAccessToken(env) {
  const raw = await env.APP_KV.get(TOKENS_KEY);
  if (!raw) throw new Error('Strava is not connected yet - visit /strava/authorize first');
  let tokens = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at - now < 300) {
    const resp = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!resp.ok) throw new Error('Strava token refresh failed (' + resp.status + ') - may need to reconnect via /strava/authorize');
    const data = await resp.json();
    tokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at };
    await env.APP_KV.put(TOKENS_KEY, JSON.stringify(tokens));
  }
  return tokens.access_token;
}

// Cheap, no-Claude-involved: just the activity list for the client to match a session
// against by date/name before paying for the expensive stream analysis.
export async function listActivities(request, env) {
  const url = new URL(request.url);
  const after = url.searchParams.get('after');
  const before = url.searchParams.get('before');
  const token = await getValidAccessToken(env);
  const params = new URLSearchParams({ per_page: '30' });
  if (after) params.set('after', after);
  if (before) params.set('before', before);
  const resp = await fetch(STRAVA_API_BASE + '/athlete/activities?' + params.toString(), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!resp.ok) throw new Error('Strava activities fetch failed (' + resp.status + ')');
  const activities = await resp.json();
  return activities.map(a => ({
    id: a.id,
    name: a.name,
    type: a.type,
    start_date_local: a.start_date_local,
    distance_km: a.distance != null ? Math.round(a.distance / 10) / 100 : null,
    moving_time_min: a.moving_time != null ? Math.round(a.moving_time / 6) / 10 : null,
    average_heartrate: a.average_heartrate != null ? Math.round(a.average_heartrate) : null,
  }));
}

// resolution=medium: Strava resamples to ~1000 points across the WHOLE activity, so
// shorter interval sessions (where fine-grained "when did HR hit target" detection
// matters most) get the finest per-point spacing - a few seconds for a 40-60 minute
// threshold/VO2max session. See the M4 planning conversation for the full reasoning.
export async function getActivityStreams(request, env, activityId) {
  const token = await getValidAccessToken(env);
  // cadence: not every activity has one (needs a footpod or cadence-capable watch), but
  // it's free to request alongside the rest - Strava just omits the key from the response
  // when an activity has no cadence data, same as any other missing stream.
  const keys = 'time,heartrate,velocity_smooth,distance,altitude,cadence';
  const resp = await fetch(
    STRAVA_API_BASE + '/activities/' + activityId + '/streams?keys=' + keys + '&key_by_type=true&resolution=medium',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!resp.ok) throw new Error('Strava streams fetch failed (' + resp.status + ')');
  return resp.json();
}

// The athlete's own device-recorded laps - from a structured workout auto-advancing
// steps, or the runner manually pressing lap, or (less usefully) a default fixed-distance
// autolap setting. The client decides which of those this actually is (real effort
// boundaries vs an arbitrary distance split) - this endpoint just returns the raw data
// Strava already computed for each lap from the full-resolution recording, trimmed to
// what the client needs.
export async function getActivityLaps(request, env, activityId) {
  const token = await getValidAccessToken(env);
  const resp = await fetch(
    STRAVA_API_BASE + '/activities/' + activityId + '/laps',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!resp.ok) throw new Error('Strava laps fetch failed (' + resp.status + ')');
  const laps = await resp.json();
  return laps.map((l, i) => ({
    lapNum: i + 1,
    elapsedTimeSec: l.elapsed_time,
    distanceM: l.distance,
    avgHR: l.average_heartrate != null ? Math.round(l.average_heartrate) : null,
    avgSpeedMps: l.average_speed,
  }));
}
