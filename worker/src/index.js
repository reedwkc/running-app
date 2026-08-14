import { handleOptions, checkOrigin, corsHeaders, checkSharedSecret, checkRateLimit } from './security.js';
import { stravaAuthorizeRedirect, stravaOAuthCallback, listActivities, getActivityStreams, getActivityLaps } from './strava.js';
import { proxyAnthropicMessages } from './anthropic.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleOptions(request, env);

    // These two are browser navigations (redirects), not fetch/XHR calls - they can't
    // carry a custom header, so they're exempt from the shared-secret check. Strava's
    // own client_secret exchange is what actually authenticates the callback.
    if (url.pathname === '/strava/authorize' && request.method === 'GET') {
      return stravaAuthorizeRedirect(request, env);
    }
    if (url.pathname === '/strava/callback' && request.method === 'GET') {
      return stravaOAuthCallback(request, env);
    }

    // Everything else is a same-origin fetch/XHR call from the app itself.
    const origin = request.headers.get('Origin') || '';
    if (!checkOrigin(request, env)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!checkSharedSecret(request, env)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!(await checkRateLimit(request, env))) {
      return new Response('Rate limit exceeded - try again later', { status: 429, headers: corsHeaders(origin, env) });
    }

    try {
      if (url.pathname === '/strava/activities' && request.method === 'GET') {
        const activities = await listActivities(request, env);
        return new Response(JSON.stringify(activities), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
        });
      }

      const streamsMatch = url.pathname.match(/^\/strava\/activity\/(\d+)\/streams$/);
      if (streamsMatch && request.method === 'GET') {
        const streams = await getActivityStreams(request, env, streamsMatch[1]);
        return new Response(JSON.stringify(streams), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
        });
      }

      const lapsMatch = url.pathname.match(/^\/strava\/activity\/(\d+)\/laps$/);
      if (lapsMatch && request.method === 'GET') {
        const laps = await getActivityLaps(request, env, lapsMatch[1]);
        return new Response(JSON.stringify(laps), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
        });
      }

      if (url.pathname === '/anthropic/messages' && request.method === 'POST') {
        const resp = await proxyAnthropicMessages(request, env);
        const headers = new Headers(resp.headers);
        Object.entries(corsHeaders(origin, env)).forEach(([k, v]) => headers.set(k, v));
        return new Response(resp.body, { status: resp.status, headers });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders(origin, env) });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
      });
    }
  },
};
