// This app is a single-user personal tool with a public frontend, so anyone can read
// the deployed JS and find this Worker's URL - none of these checks are true
// authentication, and none of them alone is the real financial backstop. CORS only
// constrains browser-based requests (a plain curl/script ignores it entirely). The
// shared secret raises the bar (it's not visible without reading the bundled JS) but
// isn't a secret in the cryptographic sense once someone bothers to look. Rate
// limiting bounds worst-case throughput per IP. The ACTUAL ceiling on financial
// exposure is the hard monthly spend limit set directly on the Anthropic API key in
// the Anthropic console - that's an account-level control this Worker can't bypass
// even if every check here were defeated, and it's not optional.

export function corsHeaders(origin, env) {
  const allow = origin === env.FRONTEND_ORIGIN ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Secret',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function handleOptions(request, env) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
}

export function checkOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  return origin === env.FRONTEND_ORIGIN;
}

export function checkSharedSecret(request, env) {
  const provided = request.headers.get('X-App-Secret') || '';
  return !!provided && provided === env.APP_SHARED_SECRET;
}

const RATE_LIMIT_MAX = 30; // requests
const RATE_LIMIT_WINDOW_SEC = 3600; // per rolling hour bucket, per IP

// A plain KV counter, not atomic under true concurrency - fine for this app's actual
// threat model (a personal tool, not a public API under real load), not a claim of
// bulletproof rate limiting.
export async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SEC);
  const key = `ratelimit:${ip}:${bucket}`;
  const current = parseInt((await env.APP_KV.get(key)) || '0', 10);
  if (current >= RATE_LIMIT_MAX) return false;
  await env.APP_KV.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC + 60 });
  return true;
}
