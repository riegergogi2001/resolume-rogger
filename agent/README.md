# ROGGER AI VJ agent (Mac sidecar)

Listens to the music, tracks beats/tempo and detects **build-ups, drops and
breakdowns**, streaming them as OSC events to ROGGER. The **AGENT page** in
ROGGER visualizes everything and fires your armed cue macros into Resolume.

## Setup (once)

```bash
cd agent
python3.11 -m venv .venv                 # 3.11 required for the ML engine
source .venv/bin/activate
pip install cython && pip install -r requirements.txt
```

If the BeatNet/torch install fails, nothing breaks — the sidecar automatically
uses its built-in DSP beat tracker (`--engine dsp` forces it).

## Audio input

- **DJ mixer / line-in** (recommended): plug the booth/rec out into the
  Focusrite and pick it with `--device "Focusrite"`.
- **System audio**: install [BlackHole 2ch](https://existential.audio/blackhole/),
  set it as the output (or a Multi-Output Device), then `--device "BlackHole"`.
- The BeatNet engine opens its own capture on the **system default input** —
  set that to the same device in Audio MIDI Setup.

## Run

```bash
source .venv/bin/activate
python3 rogger_agent.py --list-devices          # find your input
python3 rogger_agent.py --device "Focusrite"    # live
python3 rogger_agent.py --demo                  # scripted build/drop loop, no audio
```

`--target host:port` points at ROGGER's OSC **listen** port (default
`127.0.0.1:7001` — same machine; use the controller's IP if ROGGER runs on the
Ally). Then open ROGGER → **AGENT** page → **ARM** when you trust it.

## What fires what

Cue rules live in ROGGER's config (`agent.rules`): DROP → FLASH MASTER,
BUILD START → SLICE STROBE, BREAKDOWN → ColorMorph off by default — each with
enable, cooldown and pulse (auto-release). TEST buttons work while disarmed.
