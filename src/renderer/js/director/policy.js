// Pure decision policy for the autonomous AI Visual Director. Maps the
// current music read (MusicState snapshot), the rolling visual memory
// (VisualState) and the show model's role availability to AT MOST ONE
// high-level intent per evaluation. No DOM, no OSC, no timers, no
// randomness: decide() is a deterministic function of its three arguments
// so director.js can call it on every tick/downbeat and log exactly why
// each decision was made.
//
// Philosophy — think like an experienced VJ:
//   - do-nothing bias: HoldCurrentVisual is the default outcome; everything
//     else has to earn its place with a real musical reason.
//   - cost awareness: never re-fire something that's still hot
//     (visual.heat/cost) — repetition kills impact.
//   - save energy for the drop: once a drop is imminent (prediction),
//     suppress strobe/impact entirely and just make sure the next clip is
//     ready — the payoff belongs to the drop itself.
//   - tension/release: builds escalate toward the phrase boundary,
//     breakdowns strip back, drops spend the budget, sustains do quiet
//     housekeeping timed to phrase boundaries.

export const INTENTS = [
  'HoldCurrentVisual',
  'PrepareTransition',
  'IncreaseEnergy',
  'ReduceDensity',
  'TriggerImpactFX',
  'TriggerStrobe',
  'TriggerFlash',
  'TriggerCameraFX',
  'SwitchDeck',
  'PrepareNextClip',
];

const EMPTY_METRICS = { energy: 0, tension: 0, bass: 0, density: 0, vocal: 0 };

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function hold(confidence, reasoning) {
  return { type: 'HoldCurrentVisual', confidence: clamp01(confidence), reasoning, impact: 'none' };
}

/**
 * @param {object} music MusicState snapshot — see director design doc for shape.
 * @param {object} visual VisualState-like: heat(cat), cost(cat), deckDwellMs(), fatigue(), and a `tension` getter.
 * @param {object} show {hasRole(role): boolean}
 * @returns {{type:string, confidence:number, reasoning:string, impact:'none'|'low'|'medium'|'high'}}
 */
export function decide(music, visual, show) {
  // Rule 1 — invalid/missing music: the signal can't be trusted, so the
  // only safe move is to do nothing rather than react to noise.
  const bpm = music && music.bpm;
  const musicConfidence = music && typeof music.confidence === 'number' ? music.confidence : 0;
  if (!music || typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0 || musicConfidence < 0.3) {
    const bpmLabel = typeof bpm === 'number' && Number.isFinite(bpm) ? bpm : 'none';
    return hold(
      0.2,
      `Music signal is unreliable (bpm=${bpmLabel}, confidence=${musicConfidence.toFixed(2)}) — holding rather than acting on noise.`
    );
  }

  const metrics = music.metrics || EMPTY_METRICS;
  const lastEvent = music.lastEvent || null;
  const section = music.section || 'idle';
  const phrasePos = typeof music.phrasePos === 'number' ? music.phrasePos : 0;
  const phraseLen = typeof music.phraseLen === 'number' ? music.phraseLen : 8;
  const msInSection = typeof music.msInSection === 'number' ? music.msInSection : 0;
  const prediction = music.prediction || null;

  // Any intent other than Hold gets discounted by how fatigued the show
  // already is — a tired audience needs fewer, not more, big moments.
  function fire(type, confidence, reasoning, impact) {
    const fatigue = visual.fatigue();
    const factor = 1 - fatigue * 0.3;
    const finalConfidence = Math.max(0.1, clamp01(confidence) * factor);
    return { type, confidence: finalConfidence, reasoning, impact };
  }

  // Rule 2 — the drop just landed: this is the payoff moment, spend it.
  if (lastEvent === 'drop') {
    if (show.hasRole('flash') && visual.cost('flash') < 0.7) {
      const cost = visual.cost('flash');
      return fire(
        'TriggerFlash',
        0.9,
        `Drop just landed and flash cost is only ${cost.toFixed(2)} — cheap enough to hit the payoff hard.`,
        'high'
      );
    }
    if (show.hasRole('impact') && visual.cost('impact') < 0.7) {
      const cost = visual.cost('impact');
      return fire(
        'TriggerImpactFX',
        0.85,
        `Drop just landed; flash is unavailable or too hot, but impact FX cost is ${cost.toFixed(2)} — still cheap enough to sell the moment.`,
        'high'
      );
    }
    return fire(
      'IncreaseEnergy',
      0.7,
      `Drop just landed but flash and impact are both unavailable or too hot — bumping energy instead of forcing an expensive hit.`,
      'medium'
    );
  }

  // Rule 3 — the build fizzled: firing now would spend tension on a payoff
  // that never came.
  if (lastEvent === 'fakebuild') {
    return hold(
      0.8,
      `Build decayed without a drop (fakebuild) — firing now would waste tension that never resolved, holding.`
    );
  }

  // Rule 4 — breakdown just started: strip it back immediately.
  if (lastEvent === 'breakdown') {
    return fire(
      'ReduceDensity',
      0.75,
      `Breakdown just started — pulling density back to match the arrangement.`,
      'medium'
    );
  }

  // Rule 5 — a drop is predicted soon: save the energy. Never fire
  // strobe/impact inside this window; the only allowed actions are getting
  // the next clip ready, or simply holding if that's already done.
  if (prediction && prediction.event === 'drop' && prediction.beatsUntil <= 8 && prediction.confidence >= 0.5) {
    const transitionHeat = visual.heat('transition');
    if (transitionHeat < 0.3) {
      return fire(
        'PrepareNextClip',
        clamp01(prediction.confidence),
        `Drop predicted in ${prediction.beatsUntil} beats at ${prediction.confidence.toFixed(2)} confidence and transition heat is only ${transitionHeat.toFixed(2)} — cueing the next clip while saving energy for the drop.`,
        'low'
      );
    }
    return hold(
      clamp01(prediction.confidence),
      `Drop predicted in ${prediction.beatsUntil} beats (confidence ${prediction.confidence.toFixed(2)}) and the next clip is already primed (transition heat ${transitionHeat.toFixed(2)}) — holding for the predicted drop.`
    );
  }

  // Rule 6 — inside a build: escalate to strobe right at the phrase
  // boundary if it's cheap, nudge energy if the visuals are lagging the
  // music, or just let it breathe.
  if (section === 'build') {
    const lastTwoBars = phrasePos >= phraseLen - 2;
    if (metrics.tension > 0.6 && lastTwoBars && show.hasRole('strobe') && visual.cost('strobe') < 0.5) {
      const cost = visual.cost('strobe');
      return fire(
        'TriggerStrobe',
        0.85,
        `Build tension is ${metrics.tension.toFixed(2)} in the last two bars of the phrase (pos ${phrasePos}/${phraseLen}) and strobe cost is only ${cost.toFixed(2)} — escalating.`,
        'high'
      );
    }
    const visualTension = visual.tension;
    if (visualTension < metrics.tension - 0.3) {
      const gap = metrics.tension - visualTension;
      return fire(
        'IncreaseEnergy',
        0.65,
        `Build tension (${metrics.tension.toFixed(2)}) is running ${gap.toFixed(2)} ahead of visual tension (${visualTension.toFixed(2)}) — nudging energy up to catch up.`,
        'medium'
      );
    }
    return hold(
      0.6,
      `Build in progress (tension ${metrics.tension.toFixed(2)}, phrase pos ${phrasePos}/${phraseLen}) with visuals already tracking it — letting the build breathe.`
    );
  }

  // Rule 7 — sitting in a breakdown with a real vocal moment: go intimate
  // with a camera move rather than staying static, but only if it's cheap.
  if (section === 'breakdown' && msInSection > 8000 && metrics.vocal > 0.6) {
    const cost = visual.cost('camerafx');
    if (cost < 0.4) {
      return fire(
        'TriggerCameraFX',
        0.75,
        `${Math.round(msInSection / 1000)}s into the breakdown with vocal at ${metrics.vocal.toFixed(2)} and camerafx cost only ${cost.toFixed(2)} — leaning into the intimate moment.`,
        'medium'
      );
    }
    return hold(
      0.55,
      `Breakdown vocal moment (vocal ${metrics.vocal.toFixed(2)}) but camerafx cost is ${cost.toFixed(2)} — too hot to use again, holding.`
    );
  }

  // Rule 8 — sustained groove: mostly maintenance decisions timed to
  // phrase boundaries so nothing feels arbitrary.
  if (section === 'sustain') {
    const dwell = visual.deckDwellMs();
    if (dwell > 8 * 60 * 1000 && phrasePos === 0) {
      return fire(
        'SwitchDeck',
        0.8,
        `Deck has been live for ${Math.round(dwell / 60000)} min and we're at a phrase boundary (pos 0) — this is the right moment to switch.`,
        'low'
      );
    }
    const clipHeat = visual.heat('clip');
    if (phrasePos === 0 && phraseLen >= 16 && clipHeat < 0.2) {
      return fire(
        'PrepareTransition',
        0.65,
        `Fresh phrase (pos 0 of ${phraseLen}) and clip heat is only ${clipHeat.toFixed(2)} — visuals are stale, prepping a transition.`,
        'low'
      );
    }
    const fatigue = visual.fatigue();
    if (fatigue > 0.7) {
      return fire(
        'ReduceDensity',
        0.7,
        `Audience fatigue is ${fatigue.toFixed(2)} — pulling density back to give the room a breather.`,
        'low'
      );
    }
    return hold(
      0.5,
      `Sustained section, nothing due (phrase pos ${phrasePos}/${phraseLen}, dwell ${Math.round(dwell)}ms, fatigue ${fatigue.toFixed(2)}) — holding.`
    );
  }

  // Rule 9 — default: nothing in the current section/event state calls for
  // action.
  return hold(
    0.6,
    `Section '${section}' with no actionable event, prediction or threshold crossed — nothing musically actionable.`
  );
}
