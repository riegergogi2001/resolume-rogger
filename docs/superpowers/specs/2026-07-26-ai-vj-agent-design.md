# AI VJ agent — realtime audio → OSC cues (design)

Date: 2026-07-26 · Decisions: lives **inside ROGGER** (new AGENT page); engine = **BeatNet ML
sidecar** with automatic DSP fallback.

## Shape

```
DJ mixer / system audio (BlackHole or line-in)
        │  CoreAudio
        ▼
agent/rogger_agent.py  (Python 3.11 venv)
  ├─ capture: sounddevice, mono 44.1k
  ├─ features: numpy FFT → sub/bass/mid/high energies, spectral flux onset envelope
  ├─ beats:  BeatNet (online beat/downbeat/tempo) when importable,
  │          else autocorrelation tempo + onset phase (DSP fallback)
  ├─ sections: build/drop/breakdown state machine (bass withdrawal + energy slope
  │          + onset density → BUILD; bass re-entry spike → DROP; energy floor → BREAKDOWN)
  └─ OSC out (vendored encoder) → 127.0.0.1:<ROGGER listenPort>
        │   /rogger/agent/ping|engine|bpm|beat|downbeat|bands|state|event
        ▼
ROGGER renderer — AGENT page (page 6)
  ├─ link lamp (ping watchdog), engine badge (BEATNET / DSP), BPM + confidence
  ├─ canvas: band meters + energy history, beat pulse, state badge
  ├─ event log (last 24)
  ├─ rules: event → OSC macro to Resolume; per-rule enable, cooldown, pulse
  │        (auto-zero after pulseMs, like fx-grid macro release), TEST button
  └─ ARM master — nothing fires while disarmed (TEST works disarmed)
        │  existing rogger.send()
        ▼
Resolume (same composition: FLASH MASTER clips, ColorMorph, columns…)
```

The sidecar sends to ROGGER's existing OSC listen port, so **no main-process changes**:
`engine` already forwards every inbound message to the renderer.

## OSC protocol (sidecar → ROGGER)

| address | args | rate |
|---|---|---|
| `/rogger/agent/ping` | seq:int | 1 Hz |
| `/rogger/agent/engine` | name:str (`beatnet`/`dsp`/`demo`) | on start + with ping |
| `/rogger/agent/bpm` | bpm:float, confidence:float | on change |
| `/rogger/agent/beat` | beatInBar:int(1-4), bpm:float | every beat |
| `/rogger/agent/downbeat` | bar:int | every bar |
| `/rogger/agent/bands` | sub,bass,mid,high:float 0..1 | ~15 Hz |
| `/rogger/agent/state` | state:str (idle/build/drop/sustain/breakdown) | on change |
| `/rogger/agent/event` | name:str (buildstart/drop/breakdown/steady) | one-shot |

## Config (config-store)

`agent: { feedBeatClock:false, rules:[…] }` — rules merge **by id** (same policy as
colorTargets). Rule = `{ id, label, event, enabled, cooldownMs, pulseMs, macro:[{address,values}] }`.
Defaults wired to this composition:

- `drop` → launch FLASH MASTER (`layers/12/clips/3/connect`), pulse 600 ms, cooldown 8 s
- `buildstart` → launch SLICE STROBE (`layers/12/clips/9/connect`), pulse 4 s, cooldown 12 s
- `breakdown` → ColorMorph bypass on, cooldown 12 s
- `downbeat` → empty macro, disabled (placeholder for user cues)

ARM state is page-local and always boots **disarmed** — an autonomous cue-firing agent must
be opt-in per session.

## Sidecar packaging

`agent/` — `rogger_agent.py` (single file, argparse: `--list-devices --device --target
--engine auto|beatnet|dsp --demo`), `requirements.txt` (BeatNet chain needs Python ≤3.11),
`README.md` (venv, BlackHole vs line-in, Resolume unchanged). `--demo` emits a scripted
128-BPM build/drop cycle with no audio device — UI/rules testable end-to-end anywhere.

## Testing

- node --test: agent defaults + merge-by-id.
- Browser mode: `__emitOscIn` simulates the protocol → page renders, rules respect
  arm/cooldown, macro sends appear in `__oscLog`.
- Live: `--demo` against the real UDP port, then real audio on the Mac rig.
