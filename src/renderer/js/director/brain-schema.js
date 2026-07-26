// Contract between the local model (LM Studio / Ollama — any OpenAI-style
// server) and the Director. Pure functions, no bridge import, so the whole
// parse/validate path is unit-testable without a model. Every model reply
// is validated here before it may influence the show; anything malformed
// collapses to null and the heuristic policy takes over.

export const BRAIN_INTENTS = [
  'HoldCurrentVisual', 'TriggerFlash', 'TriggerStrobe', 'TriggerImpactFX',
  'TriggerCameraFX', 'SwitchDeck', 'PrepareTransition', 'PrepareNextClip',
  'IncreaseEnergy', 'ReduceDensity',
];

const IMPACTS = ['none', 'low', 'medium', 'high'];
const DEFAULT_IMPACT = {
  HoldCurrentVisual: 'none', TriggerFlash: 'low', TriggerStrobe: 'high',
  TriggerImpactFX: 'medium', TriggerCameraFX: 'low', SwitchDeck: 'high',
  PrepareTransition: 'low', PrepareNextClip: 'low',
  IncreaseEnergy: 'medium', ReduceDensity: 'low',
};

const clamp01 = v => Math.min(1, Math.max(0, Number(v)));
// Strict numeric read: null/undefined/'' stay null (Number(null) is 0 — a
// trap that would silently turn "no color" into black).
const num = v => {
  const n = typeof v === 'number' ? v
    : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
};

export function decisionSystemPrompt() {
  return [
    'You are the brain of an automatic VJ driving a Resolume Arena composition at a live show.',
    'Every few bars you get the music state, the visual memory and which cue roles exist.',
    'Act like a tasteful human VJ: calm and slow in breakdowns, tension during builds,',
    'punchy on drops, and vary the look over time instead of hammering one trick.',
    'Never strobe in quiet sections. Prefer HoldCurrentVisual when nothing calls for change.',
    'Intents you may pick from:',
    '  HoldCurrentVisual - do nothing this round',
    '  TriggerFlash - short white/color flash cue',
    '  TriggerStrobe - strobe cue, only for drops/peaks',
    '  TriggerImpactFX - one-shot impact cue (invert, suck, pixelate...)',
    '  TriggerCameraFX - subtle ongoing camera/content effect',
    '  SwitchDeck - hard switch of the main content visual',
    '  PrepareTransition / PrepareNextClip - pre-select next content, soft',
    '  IncreaseEnergy - engage color motion for more movement',
    '  ReduceDensity - release color motion to calm the frame',
    'Also set the color mood when it should change: color is applied to the',
    'background colorize; morph toggles the auto color-cycling effect.',
    'Reply with ONLY one JSON object, no prose, no markdown:',
    '{"intent":"...","confidence":0.0-1.0,"impact":"none|low|medium|high",',
    ' "reason":"short why","color":{"r":0-1,"g":0-1,"b":0-1} or null,',
    ' "morph":true|false|null,"morphSpeed":0-1 or null}',
  ].join('\n');
}

// Compact state the model decides from. Keep it terse — small local models
// lose the plot in long prompts, and short prompts keep latency down.
export function decisionUserPrompt({ music, visual, roles, lastLook, recent }) {
  return JSON.stringify({
    bpm: Math.round(music.bpm || 0),
    section: music.section,
    secondsInSection: Math.round((music.msInSection ?? 0) / 1000),
    bar: music.bar, phrase: `${music.phrasePos + 1}/${music.phraseLen}`,
    energy: music.metrics ?? {},
    visual, // { tension, heats, fatigue }
    availableRoles: roles,
    recentActions: recent,
    lastLookCheck: lastLook ?? undefined,
  });
}

export function parseDecision(j) {
  if (!j || typeof j !== 'object') return null;
  const type = BRAIN_INTENTS.includes(j.intent) ? j.intent : null;
  if (!type) return null;
  const impact = IMPACTS.includes(j.impact) ? j.impact : DEFAULT_IMPACT[type];
  const confidence = num(j.confidence) !== null ? clamp01(num(j.confidence)) : 0.6;
  const reasoning = '🧠 ' + String(j.reason ?? j.reasoning ?? 'local model decision').slice(0, 200);
  const c = j.color;
  const color = c && typeof c === 'object' && ['r', 'g', 'b'].every(k => num(c[k]) !== null)
    ? { r: clamp01(num(c.r)), g: clamp01(num(c.g)), b: clamp01(num(c.b)) }
    : null;
  const morph = typeof j.morph === 'boolean' ? j.morph : null;
  const morphSpeed = num(j.morphSpeed) !== null ? clamp01(num(j.morphSpeed)) : null;
  return {
    intent: { type, confidence, impact, reasoning },
    extras: { color, morph, morphSpeed },
  };
}

export function lookSystemPrompt() {
  return [
    'You are reviewing ONE frame of live VJ output from a screenshot.',
    'Judge it as a lighting designer: readability, color mood, is it too dark,',
    'too static, too busy, or is a logo/text broken. Be terse.',
    'Reply with ONLY one JSON object:',
    '{"looksGood":true|false,"score":0.0-1.0,"issues":["..."],"suggestion":"one short hint"}',
  ].join('\n');
}

export function parseLook(j) {
  if (!j || typeof j !== 'object' || typeof j.looksGood !== 'boolean') return null;
  const issues = Array.isArray(j.issues) ? j.issues.map(x => String(x).slice(0, 80)).slice(0, 4) : [];
  return {
    ok: j.looksGood,
    score: num(j.score) !== null ? clamp01(num(j.score)) : (j.looksGood ? 0.8 : 0.3),
    notes: [...issues, String(j.suggestion ?? '').slice(0, 120)].filter(Boolean).join(' · '),
  };
}
