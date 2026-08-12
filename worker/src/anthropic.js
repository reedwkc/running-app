const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The client sends a `type`, never a raw model name - this is the single source of
// truth for which model/token ceiling each kind of call gets, so a compromised shared
// secret can't be used to request an arbitrary (more expensive) model. Sonnet stays
// on coach-chat, where nuanced judgment and voice matter; Haiku handles Strava
// analysis, which is closer to structured pattern-matching + arithmetic than
// open-ended coaching judgment.
const REQUEST_PROFILES = {
  'coach-chat': { model: 'claude-sonnet-4-6', max_tokens: 1000 },
  'strava-analysis': { model: 'claude-haiku-4-5', max_tokens: 4000 },
};

export async function proxyAnthropicMessages(request, env) {
  const body = await request.json();
  const profile = REQUEST_PROFILES[body.type];
  if (!profile) {
    return new Response(JSON.stringify({ error: 'unknown request type' }), { status: 400 });
  }
  if (!body.system || !body.messages) {
    return new Response(JSON.stringify({ error: 'missing system/messages' }), { status: 400 });
  }

  const anthropicBody = {
    model: profile.model,
    max_tokens: profile.max_tokens,
    system: body.system,     // client builds this as content blocks with cache_control set
    messages: body.messages, // likewise, chat history carries its own cache_control breakpoint
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
  });

  return new Response(resp.body, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
