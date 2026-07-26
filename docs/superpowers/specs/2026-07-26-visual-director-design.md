# Autonomous AI Visual Director — architecture (v1)

Date: 2026-07-26. Additive only: no existing ROGGER behavior changes; the Director ships
disabled, in suggest-only mode, behind its own page.

## Layering (who decides WHAT vs HOW)

```
audio → agent/rogger_agent.py (music intelligence, extended)
             │ /rogger/agent/* OSC (existing protocol + phrase/metrics/predict)
             ▼
src/renderer/js/director/
  music-state.js    — MusicState: bpm/beat/phrase/section/energy/tension/bass/
                      density/vocal/confidence + drop predictions
  show-model.js     — semantic composition model built from live inspection
                      (rogger.inspectComposition → Resolume REST, read-only);
                      roles: hero/background/camerafx/strobe/impact/particles/
                      text/logo/transition/atmosphere; PROTECTED layer registry
  visual-state.js   — rolling show memory: action heat (strobe/flash/impact/…),
                      clip usage, deck dwell, fatigue, visual tension
  policy.js         — pure decision engine: (music, visual, show) → Intent
                      {type, confidence, reasoning, impact}; do-nothing bias,
                      cost gating, save-for-the-drop suppression
  director.js       — orchestration: ingests events, ticks each downbeat,
                      logs every decision, executes via intent-executor
  intent-executor.js— the ONLY place intents become ROGGER sends; resolves
                      semantic targets from the show model; refuses protected
                      layers; suggest mode = display only
  decision-log.js   — ring buffer of scored decisions (exportable)
src/renderer/js/director-page.js — DIRECTOR page: gauges, intent feed with
                      confidence + reasoning, AUTOPILOT arm (boots off),
                      suggest/auto mode, show-model viewer
```

Intents: HoldCurrentVisual · PrepareTransition · IncreaseEnergy · ReduceDensity ·
TriggerImpactFX · TriggerStrobe · TriggerFlash · TriggerCameraFX · SwitchDeck ·
PrepareNextClip.

## Music intelligence additions (sidecar, protocol-compatible)

New messages (existing ones unchanged):
- `/rogger/agent/phrase  bar:int posInPhrase:int phraseLen:int` (each downbeat)
- `/rogger/agent/metrics energy tension bass density vocal :float×5` (~5 Hz)
- `/rogger/agent/predict event:str beatsUntil:int conf:float` (build → phrase-
  boundary drop prediction, before it happens)
- `/rogger/agent/event fakebuild` (build that decayed without a drop)

## Safety invariants

1. Protected layers (TC/PB*, TIMER, LFV*, AB, SYNC, AUDIO, INPUT, operator list in
   `config.director.protectedPatterns`) are never targeted; the executor checks every
   resolved target against the registry.
2. The Director boots DISARMED and in `suggest` mode; `auto` requires the page toggle.
3. All sends go through the existing `rogger.send` path (the Rogger controller);
   policy/state modules are pure and cannot emit OSC.
4. Composition inspection is read-only (REST GET); model auto-rebuilds every 60 s and
   on demand, tolerating missing/renamed clips.
5. Reliability: every module tolerates absent data (no sidecar, no webserver, empty
   comp) by degrading to HoldCurrentVisual.

## Build plan

Pure modules (visual-state, policy, show-model) + their node tests are built by
lower-tier agents from exact contracts; integration, sidecar, UI, IPC and final
verification stay with the architect. Tests: `test/director-*.test.js` join `npm test`.
