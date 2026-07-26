'use strict';
// Brain client against a fake OpenAI-style server: JSON extraction from
// messy model replies, model listing, timeouts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const brain = require('../src/main/brain.js');

let server;
let url;
let replyWith; // per-test reply payload or behavior

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [
          { id: 'qwen3-4b' }, { id: 'qwen/qwen3-vl-30b' },
          { id: 'text-embedding-nomic-embed-text-v1.5' },
        ] }));
        return;
      }
      if (typeof replyWith === 'function') { replyWith(req, res, body); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: replyWith } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('extractJson: plain object', () => {
  assert.deepEqual(brain.extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: thinking blocks and fences are tolerated', () => {
  const txt = '<think>hmm the drop is coming\n{not json}</think>\n```json\n{"intent":"TriggerStrobe"}\n```';
  assert.deepEqual(brain.extractJson(txt), { intent: 'TriggerStrobe' });
});

test('extractJson: braces inside strings do not break the walk', () => {
  assert.deepEqual(brain.extractJson('noise {"reason":"buildup {rising}","x":2} trailing'),
    { reason: 'buildup {rising}', x: 2 });
});

test('extractJson: unterminated thinking block is stripped', () => {
  assert.deepEqual(brain.extractJson('{"ok":true} <think>never closed'), { ok: true });
});

test('extractJson: throws on no JSON', () => {
  assert.throws(() => brain.extractJson('just vibes, no object'));
});

test('chat() round-trips a decision through the OpenAI shape', async () => {
  replyWith = 'Here you go: {"intent":"TriggerFlash","confidence":0.8,"reason":"drop"}';
  const res = await brain.chat({ url, model: 'qwen3-4b', system: 's', user: 'u', timeoutMs: 2000 });
  assert.equal(res.json.intent, 'TriggerFlash');
  assert.equal(res.json.confidence, 0.8);
});

test('chat() rejects on server error status', async () => {
  replyWith = (req, res) => { res.statusCode = 500; res.end('boom'); };
  await assert.rejects(() => brain.chat({ url, model: 'm', system: 's', user: 'u', timeoutMs: 2000 }),
    /answered 500/);
});

test('chat() times out on a hanging server', async () => {
  replyWith = () => { /* never respond */ };
  await assert.rejects(() => brain.chat({ url, model: 'm', system: 's', user: 'u', timeoutMs: 300 }));
});

test('chat() with images builds a vision content array', async () => {
  replyWith = (req, res, body) => {
    const parsed = JSON.parse(body);
    const content = parsed.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image_url');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"looksGood":true}' } }] }));
  };
  const res = await brain.chat({ url, model: 'vl', system: 's', user: 'u',
    images: ['data:image/jpeg;base64,xx'], timeoutMs: 2000 });
  assert.equal(res.json.looksGood, true);
});

test('listModels filters embedding models', async () => {
  const models = await brain.listModels(url);
  assert.deepEqual(models, ['qwen3-4b', 'qwen/qwen3-vl-30b']);
});
