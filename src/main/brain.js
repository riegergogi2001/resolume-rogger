'use strict';
// Local-model client for the Director's brain: talks to any OpenAI-style
// chat server (LM Studio :1234, Ollama :11434/v1, llama-server). Zero-dep —
// global fetch + AbortSignal. Lenient JSON extraction tolerates thinking
// models (<think> blocks) and markdown fences.

function stripThinking(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '');
}

// First complete top-level {...} object in the reply, string-aware.
function extractJson(text) {
  const t = stripThinking(text);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  const start = body.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in model reply');
}

const base = url => String(url ?? '').replace(/\/+$/, '');

async function chat({ url, model, system, user, images = [], temperature = 0.7,
  maxTokens = 2500, timeoutMs = 30000 }) {
  const content = images.length
    ? [{ type: 'text', text: user },
      ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))]
    : user;
  const res = await fetch(`${base(url)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, temperature, max_tokens: maxTokens, stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`brain server answered ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { json: extractJson(text), raw: text, model: data.model ?? model };
}

async function listModels(url, timeoutMs = 2500) {
  const res = await fetch(`${base(url)}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`brain server answered ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map(m => m.id).filter(id => !/embed/i.test(id));
}

module.exports = { chat, listModels, extractJson, stripThinking };
