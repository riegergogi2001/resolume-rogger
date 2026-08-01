#!/usr/bin/env python3
"""ROGGER AI VJ agent — realtime audio analysis → OSC events.

Captures audio (DJ mixer line-in or BlackHole loopback), tracks beats/tempo
(BeatNet ML model when available, DSP fallback otherwise), detects musical
sections (build / drop / breakdown) and streams events to ROGGER's OSC input:

    /rogger/agent/ping      seq:int              1 Hz heartbeat
    /rogger/agent/engine    name:str             beatnet | dsp | demo
    /rogger/agent/bpm       bpm:float conf:float on change
    /rogger/agent/beat      beatInBar:int bpm:f  every beat
    /rogger/agent/downbeat  bar:int              every bar
    /rogger/agent/bands     sub bass mid high:f  ~15 Hz, 0..1
    /rogger/agent/state     state:str            idle|build|drop|sustain|breakdown
    /rogger/agent/event     name:str             buildstart|drop|breakdown|steady|fakebuild
    /rogger/agent/phrase    bar:int pos:int len:int   each downbeat (pos 0-based in phrase)
    /rogger/agent/metrics   energy tension bass density vocal:f  ~5 Hz, 0..1
    /rogger/agent/predict   event:str beatsUntil:int conf:float  drop forecast in builds
    /rogger/agent/onset     name:str strength:f  kick|snare|hat transient hits

Usage:
    python3 rogger_agent.py --list-devices
    python3 rogger_agent.py --device "BlackHole"          # live analysis
    python3 rogger_agent.py --demo                        # no audio needed
    python3 rogger_agent.py --engine dsp --device 1

ROGGER shows everything on the AGENT page and fires the armed cue macros.
"""
import argparse
import contextlib
import math
import socket
import struct
import sys
import threading
import time

SR = 44100            # replaced by the input device's native rate at startup
FRAME = 2048          # analysis window
HOP = 1024            # ~23 ms at 44.1k
HOP_HZ = SR / HOP
PHRASE_LEN = 16       # bars per phrase (EDM standard; drops land on boundaries)
INPUT_HINT = 'Scarlett'   # preferred input when --device is omitted (all engines)
BPM_MIN, BPM_MAX = 70.0, 180.0   # plausible dance range — octave-fold into it
SILENCE_RMS_OFF = 1.2e-3  # smoothed RMS below → silence (~ -58 dBFS)
SILENCE_RMS_ON = 3.0e-3   # smoothed RMS above → music again (hysteresis)

# ---------------------------------------------------------------- OSC out

def _pad(b):
    return b + b'\0' * ((4 - len(b) % 4) % 4)


def osc_message(address, args):
    out = _pad(address.encode() + b'\0')
    tags = ','
    payload = b''
    for a in args:
        if isinstance(a, bool):
            a = int(a)
        if isinstance(a, int):
            tags += 'i'
            payload += struct.pack('>i', a)
        elif isinstance(a, float):
            tags += 'f'
            payload += struct.pack('>f', a)
        else:
            tags += 's'
            payload += _pad(str(a).encode() + b'\0')
    return out + _pad(tags.encode() + b'\0') + payload


class OscOut:
    def __init__(self, host, port):
        self.addr = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(self, address, *args):
        try:
            self.sock.sendto(osc_message(address, args), self.addr)
        except OSError:
            pass


# ---------------------------------------------------------------- features

class Ema:
    """Exponential moving average with a time constant in seconds."""

    def __init__(self, seconds, rate_hz, value=0.0):
        self.a = 1.0 - math.exp(-1.0 / max(1e-6, seconds * rate_hz))
        self.v = value

    def push(self, x):
        self.v += self.a * (x - self.v)
        return self.v


class Features:
    """FFT band energies + spectral-flux onset envelope (numpy)."""

    BANDS = ((20, 60), (60, 250), (250, 2000), (2000, 16000))

    def __init__(self, np):
        self.np = np
        self.window = np.hanning(FRAME).astype('float32')
        freqs = np.fft.rfftfreq(FRAME, 1.0 / SR)
        self.bins = [(freqs >= lo) & (freqs < hi) for lo, hi in self.BANDS]
        self.vocal_bin = (freqs >= 300) & (freqs < 3400)   # vocal-presence band
        # percussive classes for onset detection: kick = sub+bass, snare = mid,
        # hat = high — coarse, but enough to route hits to different cues
        self.perc_bins = [self.bins[0] | self.bins[1], self.bins[2], self.bins[3]]
        self.band_flux = [0.0, 0.0, 0.0]
        self.prev_mag = None
        self.peak = [1e-6] * 4          # running per-band peak, slow decay
        self.onset = []                 # onset envelope, HOP_HZ rate
        self.max_onset = 1e-6
        self.vocal = Ema(1.0, HOP_HZ)   # smoothed vocal-band energy ratio
        self.rms = Ema(0.3, HOP_HZ)     # smoothed loudness (silence gate)

    def process(self, frame):
        np = self.np
        self.rms.push(float(np.sqrt(np.mean(frame * frame))))
        mag = np.abs(np.fft.rfft(frame * self.window))
        bands = []
        for i, mask in enumerate(self.bins):
            e = float(np.sqrt(np.mean(mag[mask] ** 2)))
            self.peak[i] = max(e, self.peak[i] * 0.9998)
            bands.append(min(1.0, e / self.peak[i]))
        flux = 0.0
        if self.prev_mag is not None:
            d = mag - self.prev_mag
            pos = np.where(d > 0, d, 0.0)
            flux = float(np.sum(pos))
            self.band_flux = [float(np.sum(pos[m])) for m in self.perc_bins]
        else:
            self.band_flux = [0.0, 0.0, 0.0]
        self.prev_mag = mag
        total = float(np.sum(mag ** 2)) + 1e-9
        ratio = float(np.sum(mag[self.vocal_bin] ** 2)) / total
        # 300-3400 Hz share above the typical instrumental floor → 0..1 presence
        self.vocal.push(min(1.0, max(0.0, (ratio - 0.25) * 3.0)))
        self.max_onset = max(flux, self.max_onset * 0.9995)
        norm_flux = flux / self.max_onset if self.max_onset > 0 else 0.0
        self.onset.append(norm_flux)
        if len(self.onset) > int(HOP_HZ * 12):
            del self.onset[: len(self.onset) - int(HOP_HZ * 12)]
        return bands, norm_flux


# ---------------------------------------------------------------- onsets

class OnsetDetector:
    """Per-band transient hits → discrete onset events (kick/snare/hat).

    Positive spectral flux per percussive band compared against an adaptive
    threshold (median + K·MAD over a trailing window), a per-class refractory
    period so one hit fires once, and a floor relative to the running flux
    peak so near-silent noise never counts. Pure Python — no numpy — so the
    hot path stays allocation-light and the logic is trivially testable.
    """

    NAMES = ('kick', 'snare', 'hat')
    K = (2.5, 3.0, 3.0)                 # threshold: median + K * MAD
    REFRACTORY = (0.10, 0.12, 0.06)     # seconds a class stays quiet after a hit
    FLOOR = 0.15                        # min flux as a share of the running peak

    def __init__(self, rate_hz):
        self.window = max(8, int(rate_hz * 1.5))    # trailing flux samples
        self.warmup = max(4, int(rate_hz * 0.5))    # need a baseline first
        self.hist = [[], [], []]
        self.last = [-1e9, -1e9, -1e9]
        self.peak = [1e-9, 1e-9, 1e-9]

    def push(self, fluxes, now):
        """Feed one hop's per-band flux; returns [(name, strength), ...]."""
        events = []
        for i, f in enumerate(fluxes):
            h = self.hist[i]
            h.append(f)
            if len(h) > self.window:
                h.pop(0)
            self.peak[i] = max(f, self.peak[i] * 0.9995)
            if len(h) < self.warmup:
                continue
            srt = sorted(h)
            med = srt[len(srt) // 2]
            mad = sorted(abs(x - med) for x in h)[len(h) // 2]
            thr = med + self.K[i] * max(mad, med * 0.05, 1e-9)
            if (f > thr and f > self.peak[i] * self.FLOOR
                    and now - self.last[i] >= self.REFRACTORY[i]):
                self.last[i] = now
                events.append((self.NAMES[i], min(1.0, f / self.peak[i])))
        return events


# ---------------------------------------------------------------- sections

class SectionTracker:
    """Build / drop / breakdown state machine over band energies."""

    def __init__(self):
        self.state = 'idle'
        self.bass_fast = Ema(0.25, HOP_HZ)
        self.bass_slow = Ema(8.0, HOP_HZ)
        self.total_fast = Ema(0.25, HOP_HZ)
        self.total_slow = Ema(8.0, HOP_HZ)
        self.dens_fast = Ema(0.5, HOP_HZ)
        self.dens_slow = Ema(8.0, HOP_HZ)
        self.cond_since = None
        self.state_since = time.monotonic()
        self.warm = 0

    def _set(self, state, events, event=None):
        if state != self.state:
            self.state = state
            self.state_since = time.monotonic()
            events.append(('state', state))
            if event:
                events.append(('event', event))

    def metrics(self, vocal):
        """(energy, tension, bass, density, vocal) — all 0..1 heuristics."""
        base = min(1.0, self.dens_fast.v / (self.dens_slow.v * 2 + 1e-9))
        ramp = (min(1.0, (time.monotonic() - self.state_since) / 12.0)
                if self.state == 'build' else 0.0)
        tension = min(1.0, 0.6 * base + 0.4 * ramp)
        return (min(1.0, self.total_fast.v), tension, min(1.0, self.bass_fast.v),
                min(1.0, self.dens_fast.v), min(1.0, max(0.0, vocal)))

    def push(self, bands, flux):
        events = []
        now = time.monotonic()
        sub, bass, mid, high = bands
        self.bass_fast.push(sub * 0.6 + bass * 0.4)
        bs = self.bass_slow.push(self.bass_fast.v)
        self.total_fast.push(sum(bands) / 4.0)
        ts = self.total_slow.push(self.total_fast.v)
        self.dens_fast.push(flux)
        ds = self.dens_slow.push(self.dens_fast.v)
        b, t, d = self.bass_fast.v, self.total_fast.v, self.dens_fast.v
        self.warm += 1
        if self.warm < HOP_HZ * 5 or ts < 0.02:
            return events               # need baseline / silence

        # riser: energy + onset density up while the bass pulls away
        building = t > ts * 1.10 and d > ds * 1.25 and b < bs * 0.75
        dropping = b > bs * 1.35 and t > ts * 1.05
        quiet = t < ts * 0.45

        # steady music from a cold start settles into sustain (no event) —
        # without this, sustain-phase decisions never engage until a build.
        if self.state == 'idle' and t > ts * 0.7 and now - self.state_since > 10.0:
            self._set('sustain', events)

        if self.state in ('idle', 'sustain'):
            if building:
                if self.cond_since is None:
                    self.cond_since = now
                elif now - self.cond_since > 1.2:
                    self._set('build', events, 'buildstart')
                    self.cond_since = None
            else:
                self.cond_since = None
            if quiet and now - self.state_since > 4.0:
                if self.cond_since is None:
                    self.cond_since = now
                elif now - self.cond_since > 2.0:
                    self._set('breakdown', events, 'breakdown')
                    self.cond_since = None
        elif self.state == 'build':
            if dropping:
                self._set('drop', events, 'drop')
            elif (t < ts * 0.85 and d < ds and now - self.state_since > 4.0):
                # the riser fizzled without a payoff — a fake build
                self._set('sustain', events, 'fakebuild')
            elif now - self.state_since > 30.0:
                self._set('sustain', events, 'steady')
        elif self.state == 'drop':
            if now - self.state_since > 1.5:
                self._set('sustain', events)
        elif self.state == 'breakdown':
            if dropping and now - self.state_since > 2.0:
                self._set('drop', events, 'drop')
            elif t > ts * 0.9 and now - self.state_since > 4.0:
                self._set('sustain', events, 'steady')
        return events


# ---------------------------------------------------------------- tempo lock

class TempoTracker:
    """Octave-folded BPM clustering with hysteresis.

    Raw estimates (BeatNet inter-beat gaps or DSP autocorrelation peaks) are
    folded into BPM_MIN..BPM_MAX by halving/doubling — toward the locked
    tempo when both octaves fit — so 87↔174 flips collapse onto one value.
    The lock itself is a median over on-lock observations and only jumps when
    JUMP_AFTER consecutive observations agree on a different tempo.
    """

    LOCK_TOL = 0.04          # ±4% counts as "the same tempo"
    JUMP_AFTER = 6           # consecutive off-lock observations to re-lock

    def __init__(self):
        self.bpm = 0.0       # locked tempo (0 = not locked yet)
        self.history = []    # recent on-lock observations (median → lock)
        self.rebels = []     # consecutive off-lock observations

    def fold(self, bpm):
        """Halve/double into range, preferring the locked tempo's octave."""
        if bpm <= 0:
            return 0.0
        while bpm < BPM_MIN:
            bpm *= 2.0
        while bpm > BPM_MAX:
            bpm /= 2.0
        if self.bpm:
            for cand in (bpm * 0.5, bpm * 2.0):
                if BPM_MIN <= cand <= BPM_MAX and abs(cand - self.bpm) < abs(bpm - self.bpm):
                    bpm = cand
        return bpm

    def observe(self, bpm):
        """Feed one raw estimate; returns the (possibly updated) locked BPM."""
        bpm = self.fold(bpm)
        if bpm <= 0:
            return self.bpm
        if not self.bpm:
            self.bpm = bpm
        if abs(bpm - self.bpm) <= self.bpm * self.LOCK_TOL:
            self.rebels.clear()
            self.history.append(bpm)
            if len(self.history) > 16:
                self.history.pop(0)
            self.bpm = sorted(self.history)[len(self.history) // 2]
        else:
            self.rebels.append(bpm)
            if len(self.rebels) > self.JUMP_AFTER:
                self.rebels.pop(0)
            mid = sorted(self.rebels)[len(self.rebels) // 2]
            if (len(self.rebels) >= self.JUMP_AFTER
                    and all(abs(r - mid) <= mid * self.LOCK_TOL for r in self.rebels)):
                self.bpm = mid          # the music really did change tempo
                self.history = list(self.rebels)
                self.rebels.clear()
        return self.bpm

    def consistency(self):
        """0..1: how tightly recent observations sit on the locked tempo."""
        if len(self.history) < 4 or not self.bpm:
            return 0.0
        mad = sum(abs(h - self.bpm) for h in self.history) / len(self.history)
        return max(0.0, min(1.0, 1.0 - (mad / self.bpm) / self.LOCK_TOL))


# ---------------------------------------------------------------- beats (DSP)

class DspBeats:
    """Autocorrelation tempo + comb phase over the onset envelope."""

    def __init__(self, np):
        self.np = np
        self.bpm = 0.0
        self.conf = 0.0
        self.tempo = TempoTracker()     # octave-folded BPM lock
        self.period = None              # seconds
        self.next_beat = None
        self.beat_in_bar = 0
        self.bar = 0
        self.last_analysis = 0.0
        self.last_poll = time.monotonic()

    def analyse(self, onset):
        np = self.np
        need = int(HOP_HZ * 6)
        if len(onset) < need:
            return
        env = np.asarray(onset[-need:], dtype='float32')
        env = env - env.mean()
        ac = np.correlate(env, env, 'full')[env.size - 1:]
        lo = int(HOP_HZ * 60 / BPM_MAX)
        hi = int(HOP_HZ * 60 / BPM_MIN)
        if hi >= ac.size:
            return
        seg = ac[lo:hi]
        peak = int(seg.argmax())
        lag = lo + peak
        # prefer the base period over its half (double-tempo mistakes)
        if lag * 2 < hi and ac[lag * 2] > ac[lag] * 0.8:
            lag *= 2
        peak_conf = float(max(0.0, min(1.0, seg[peak] / (ac[0] + 1e-9) * 3)))
        prev_period = self.period
        bpm = self.tempo.observe(60.0 * HOP_HZ / lag)
        if bpm <= 0:
            return
        self.bpm = bpm
        self.period = 60.0 / bpm
        # confidence: autocorrelation peak strength × tempo-lock stability
        self.conf = max(0.0, min(1.0, 0.5 * peak_conf + 0.5 * self.tempo.consistency()))
        # phase: best comb offset over the recent envelope, at the locked lag
        now = time.monotonic()
        lag = max(1, int(round(HOP_HZ * 60.0 / bpm)))
        span = int(lag * 8)
        tail = env[-span:] if env.size >= span else env
        best, best_off = -1e9, 0
        for off in range(lag):
            s = float(tail[off::lag].sum())
            if s > best:
                best, best_off = s, off
        ago = (tail.size - 1 - best_off) % lag
        proposed = now + self.period - (ago / HOP_HZ) % self.period
        if (self.next_beat is None or prev_period is None
                or abs(self.period - prev_period) > prev_period * 0.1):
            self.next_beat = proposed   # first lock / genuine tempo change
        else:
            # PLL: nudge the clock toward the measured phase — one noisy
            # one-second window can no longer teleport the beat grid
            err = ((proposed - self.next_beat + self.period / 2) % self.period
                   - self.period / 2)
            self.next_beat += 0.3 * err

    def poll(self, onset, audible=True):
        """Return beat events due now: [('beat', n, bpm) | ('downbeat', bar)]."""
        now = time.monotonic()
        dt, self.last_poll = now - self.last_poll, now
        out = []
        if not audible:
            # silence: park the clock and drain confidence instead of
            # free-running phantom beats over nothing
            self.conf = max(0.0, self.conf - 0.6 * dt)
            self.next_beat = None
            return out
        if now - self.last_analysis > 1.0:
            self.last_analysis = now
            self.analyse(onset)
        if self.period and self.next_beat and now >= self.next_beat:
            self.next_beat += self.period
            self.beat_in_bar = self.beat_in_bar % 4 + 1
            out.append(('beat', self.beat_in_bar, self.bpm))
            if self.beat_in_bar == 1:
                self.bar += 1
                out.append(('downbeat', self.bar))
        return out


# ---------------------------------------------------------------- BeatNet

class BeatNetBeats:
    """BeatNet online beat/downbeat tracking (opens its own capture stream).

    bn.process() in stream mode is a blocking loop that discards per-frame
    returns, but its particle filter accumulates detections on
    bn.estimator.path as [time, type] rows (1 = downbeat, 2 = beat) — we run
    the loop in a daemon thread and tail that array. path[0] is an init row.
    """

    def __init__(self, np, tee=None):
        # numpy 2.x compatibility shims for BeatNet 1.1.1 internals
        if not hasattr(np, 'in1d'):
            np.in1d = np.isin
        if not hasattr(np, 'float'):
            np.float = float
        if not hasattr(np, 'int'):
            np.int = int
        # BeatNet opens the system-default input; steer it to the house
        # interface instead by injecting input_device_index into its open().
        import pyaudio
        if not getattr(pyaudio.PyAudio, '_rogger_patched', False):
            orig_open = pyaudio.PyAudio.open

            def patched_open(pa, *a, **kw):
                if kw.get('input') and 'input_device_index' not in kw:
                    try:
                        for i in range(pa.get_device_count()):
                            info = pa.get_device_info_by_index(i)
                            if (INPUT_HINT.lower() in info['name'].lower()
                                    and info['maxInputChannels'] > 0):
                                kw['input_device_index'] = i
                                break
                    except Exception:
                        pass  # fall back to the default input
                return orig_open(pa, *a, **kw)

            pyaudio.PyAudio.open = patched_open
            pyaudio.PyAudio._rogger_patched = True
        from BeatNet.BeatNet import BeatNet  # probes availability
        self.np = np
        # model 1 = GTZAN-trained; PF = particle-filter online inference
        self.bn = BeatNet(1, mode='stream', inference_model='PF',
                          plot=[], thread=False)
        if tee is not None:
            # Two PortAudio clients on one device fight (PaMacCore err -50),
            # so the feature engine taps BeatNet's capture instead of opening
            # its own stream: wrap stream.read and copy every hop out.
            orig_read = self.bn.stream.read

            def teed_read(n, *a, **kw):
                data = orig_read(n, *a, **kw)
                try:
                    tee(np.frombuffer(data, dtype=np.float32))
                except Exception:
                    pass
                return data

            self.bn.stream.read = teed_read
        self.bpm = 0.0
        self.conf = 0.2                 # dynamic: IBI stability + grid agreement
        self.bar = 0
        self.beat_in_bar = 0
        self.seen = 1
        self.prev_t = None
        self.tempo = TempoTracker()     # octave-folded BPM lock
        # beats are EMITTED from a predicted grid, phase-nudged by BeatNet
        # detections — a missed detection no longer skips a beat and a false
        # one no longer inserts an extra (grid times live in stream seconds)
        self.grid_t = None              # predicted next grid beat, stream time
        self.grid_n = 0                 # absolute beat index on the grid
        self.bar_off = 0                # grid_n % 4 that counts as beat 1
        self.down_votes = []            # recent downbeat bar-phase votes
        self.agree = []                 # last ~8 detections: on-grid or not
        self.miss_run = 0               # consecutive off-grid detections
        self.offset = None              # stream-time → monotonic mapping (EMA)
        self.last_poll = time.monotonic()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            self.bn.process()           # blocks while the stream is active
        except Exception as e:          # keep the sidecar alive; DSP still runs
            print(f'[beatnet] stopped: {e}', file=sys.stderr)

    def _consume(self, t, kind, now):
        """Fold one raw BeatNet detection into the tempo lock + phase grid."""
        # stream-time → monotonic mapping (constant model latency + poll
        # jitter; the EMA keeps predicted beats firing at a steady offset)
        off = now - t
        self.offset = off if self.offset is None else self.offset + 0.15 * (off - self.offset)
        if self.prev_t is not None and 0.25 < t - self.prev_t < 2.0:
            # octave folding also rescues skipped-beat gaps (2× the period)
            self.bpm = self.tempo.observe(60.0 / (t - self.prev_t))
        self.prev_t = t
        if not self.tempo.bpm:
            return
        period = 60.0 / self.tempo.bpm
        if self.grid_t is None:
            self.grid_t = t + period
            self.miss_run = 0
            return
        # phase error to the nearest grid line, wrapped to ±half a period
        err = (t - self.grid_t + period / 2) % period - period / 2
        on_grid = abs(err) < period * 0.2
        self.agree.append(on_grid)
        if len(self.agree) > 8:
            self.agree.pop(0)
        if on_grid:
            self.miss_run = 0
            self.grid_t += 0.25 * err   # PLL: small nudge, never a hard reset
        else:
            self.miss_run += 1
            if self.miss_run >= 4:      # the grid really is wrong — resync
                self.grid_t = t + period
                self.miss_run = 0
        if kind == 1:                   # downbeat: vote for the bar phase —
            # two agreeing votes realign beat 1 instead of every detection
            # yanking the bar counter around
            k = self.grid_n + int(round((t - self.grid_t) / period))
            self.down_votes.append(k % 4)
            if len(self.down_votes) > 3:
                self.down_votes.pop(0)
            if (len(self.down_votes) >= 2
                    and self.down_votes[-1] == self.down_votes[-2]
                    and self.down_votes[-1] != self.bar_off):
                self.bar_off = self.down_votes[-1]
        # confidence: tempo-lock tightness + detections landing on the grid
        hits = sum(self.agree) / len(self.agree) if self.agree else 0.0
        target = max(0.05, min(0.98, 0.5 * self.tempo.consistency() + 0.5 * hits))
        self.conf += 0.25 * (target - self.conf)

    def poll(self, _onset, audible=True):
        out = []
        now = time.monotonic()
        dt, self.last_poll = now - self.last_poll, now
        path = getattr(self.bn.estimator, 'path', None)
        if path is None or not hasattr(path, 'shape'):
            return out
        n = path.shape[0]
        if not audible:
            # silence: discard detections made from noise, park the grid and
            # drain confidence — the tempo lock survives short pauses
            self.seen = n
            self.grid_t = None
            self.prev_t = None
            self.agree.clear()
            self.miss_run = 0
            self.conf = max(0.0, self.conf - 0.6 * dt)
            return out
        while self.seen < n:
            t, kind = float(path[self.seen][0]), int(path[self.seen][1])
            self.seen += 1
            self._consume(t, kind, now)
        if self.grid_t is not None and self.offset is not None and self.tempo.bpm:
            period = 60.0 / self.tempo.bpm
            behind = now - (self.grid_t + self.offset)
            if behind > 4 * period:     # long stall — jump, don't machine-gun
                skip = int(behind / period)
                self.grid_n += skip
                self.grid_t += skip * period
            while self.grid_t + self.offset <= now:
                self.beat_in_bar = (self.grid_n - self.bar_off) % 4 + 1
                out.append(('beat', self.beat_in_bar, self.bpm))
                if self.beat_in_bar == 1:
                    self.bar += 1
                    out.append(('downbeat', self.bar))
                self.grid_n += 1
                self.grid_t += period
        return out


# ---------------------------------------------------------------- demo mode

def run_demo(osc):
    """Scripted 128-BPM build/drop cycle — full protocol, no audio device."""
    print('demo mode: 128 BPM build/drop loop → %s:%d' % osc.addr)
    bpm = 128.0
    beat_period = 60.0 / bpm
    seq = 0
    bar = 0
    beat = 0
    next_beat = time.monotonic()
    next_ping = 0.0
    next_bands = 0.0
    osc.send('/rogger/agent/engine', 'demo')
    osc.send('/rogger/agent/bpm', bpm, 0.99)
    osc.send('/rogger/agent/state', 'sustain')
    # timeline in bars: sustain 16 → build 8 → drop+sustain 16 → breakdown 8
    while True:
        now = time.monotonic()
        cycle = bar % 48
        phase = ('sustain' if cycle < 16 else
                 'build' if cycle < 24 else
                 'sustain' if cycle < 32 else
                 'build' if cycle < 36 else
                 'sustain' if cycle < 40 else 'breakdown')
        if now >= next_beat:
            beat = beat % 4 + 1
            if beat == 1:
                bar += 1
                new_cycle = bar % 48
                if new_cycle == 16 or new_cycle == 32:
                    osc.send('/rogger/agent/state', 'build')
                    osc.send('/rogger/agent/event', 'buildstart')
                elif new_cycle == 24:
                    osc.send('/rogger/agent/state', 'drop')
                    osc.send('/rogger/agent/event', 'drop')
                elif new_cycle == 25:
                    osc.send('/rogger/agent/state', 'sustain')
                elif new_cycle == 36:
                    # a riser that fizzles: build without payoff
                    osc.send('/rogger/agent/state', 'sustain')
                    osc.send('/rogger/agent/event', 'fakebuild')
                elif new_cycle == 40:
                    osc.send('/rogger/agent/state', 'breakdown')
                    osc.send('/rogger/agent/event', 'breakdown')
                    osc.send('/rogger/agent/event', 'vocalstart')
                elif new_cycle == 0:
                    osc.send('/rogger/agent/state', 'sustain')
                    osc.send('/rogger/agent/event', 'steady')
                    osc.send('/rogger/agent/event', 'vocalend')
                osc.send('/rogger/agent/downbeat', bar)
                pos = (bar - 1) % PHRASE_LEN
                osc.send('/rogger/agent/phrase', bar, pos, PHRASE_LEN)
                if pos == 0:
                    osc.send('/rogger/agent/event', 'phrasestart')
                if new_cycle == 22:      # two bars before the demo drop
                    osc.send('/rogger/agent/event', 'dropimminent')
            osc.send('/rogger/agent/beat', beat, bpm)
            if phase != 'breakdown':
                osc.send('/rogger/agent/onset', 'kick',
                         1.0 if phase == 'drop' else 0.75)
                if beat in (2, 4):
                    osc.send('/rogger/agent/onset', 'snare', 0.7)
            if phase == 'build' and cycle < 24:
                pos = (bar - 1) % PHRASE_LEN
                beats_until = (PHRASE_LEN - 1 - pos) * 4 + (5 - beat)
                osc.send('/rogger/agent/predict', 'drop', beats_until,
                         min(0.9, 0.4 + (24 - cycle) * -0.05 + 0.5))
            next_beat += beat_period
        if now >= next_bands:
            t = now * 2.0
            pump = 0.5 + 0.5 * math.sin(t * 2 * math.pi * bpm / 120.0)
            lvl = {'sustain': 0.8, 'build': 0.55, 'drop': 1.0, 'breakdown': 0.25}[phase]
            rise = ((cycle - 16) / 8.0 if phase == 'build' and cycle < 24 else
                    (cycle - 32) / 4.0 if phase == 'build' else 0.0)
            osc.send('/rogger/agent/bands',
                     max(0.0, lvl * pump * (1 - rise)),
                     max(0.0, lvl * pump * (1 - rise * 0.8)),
                     min(1.0, lvl * 0.7 + rise * 0.3),
                     min(1.0, lvl * 0.6 + rise * 0.5))
            osc.send('/rogger/agent/metrics',
                     lvl, min(1.0, 0.3 + rise * 0.7), max(0.0, lvl * pump),
                     min(1.0, 0.4 + rise * 0.5),
                     0.7 if phase == 'breakdown' else 0.2)
            next_bands = now + 1 / 15
        if now >= next_ping:
            seq += 1
            osc.send('/rogger/agent/ping', seq)
            osc.send('/rogger/agent/engine', 'demo')
            next_ping = now + 1.0
        time.sleep(0.005)


# ---------------------------------------------------------------- live mode

def run_live(osc, args):
    global SR, HOP_HZ
    import numpy as np
    import sounddevice as sd

    if args.list_devices:
        print(sd.query_devices())
        return

    # Use the input device's native rate/channels — forcing 44.1k mono makes
    # CoreAudio reject some interfaces (PaMacCore err -50).
    device = None
    if args.device is not None:
        device = int(args.device) if args.device.isdigit() else args.device
    else:
        # no explicit device: prefer the house interface over the system default
        for i, d in enumerate(sd.query_devices()):
            if INPUT_HINT.lower() in d['name'].lower() and d['max_input_channels'] > 0:
                device = i
                break
    dev_info = sd.query_devices(device, 'input')
    SR = int(dev_info['default_samplerate'])
    HOP_HZ = SR / HOP
    channels = min(2, max(1, int(dev_info['max_input_channels'])))

    lock = threading.Lock()
    hops = []

    def push_samples(mono):
        with lock:
            hops.append(mono)

    engine_name = 'dsp'
    beats = None
    if args.engine in ('auto', 'beatnet'):
        try:
            beats = BeatNetBeats(np, tee=push_samples)
            engine_name = 'beatnet'
        except Exception as e:
            if args.engine == 'beatnet':
                print(f'BeatNet unavailable: {e}', file=sys.stderr)
                sys.exit(2)
            print(f'BeatNet unavailable ({e.__class__.__name__}: {e}), falling back to DSP')
    if beats is None:
        beats = DspBeats(np)

    stream = None
    if engine_name == 'beatnet':
        # single capture: the feature engine taps BeatNet's 22050 Hz stream
        SR = 22050
        HOP_HZ = SR / HOP
        print(f'listening via BeatNet capture (input hint: {INPUT_HINT}, else system default) '
              f'@ {SR} Hz → {osc.addr[0]}:{osc.addr[1]} · engine=beatnet')
    else:
        def callback(indata, frames, t, status):
            mono = indata.mean(axis=1) if indata.ndim > 1 else indata[:, 0]
            push_samples(mono.copy())

        stream = sd.InputStream(samplerate=SR, blocksize=HOP, device=device,
                                channels=channels, dtype='float32', callback=callback)
        dev_name = sd.query_devices(stream.device)['name']
        print(f'listening on "{dev_name}" @ {SR} Hz ×{channels}ch → '
              f'{osc.addr[0]}:{osc.addr[1]} · engine={engine_name}')
    osc.send('/rogger/agent/engine', engine_name)

    feats = Features(np)
    sections = SectionTracker()
    onsets = OnsetDetector(HOP_HZ)
    ring = np.zeros(FRAME, dtype='float32')

    seq = 0
    next_ping = 0.0
    next_bands = 0.0
    next_metrics = 0.0
    last_bpm_sent = 0.0
    last_conf_sent = -1.0
    last_bpm_at = 0.0
    audible = False                     # RMS gate: no beats/conf over silence
    last_bands = None
    cur_bar = 0
    cur_beat = 1
    vocal_on = False
    vocal_flip = 0.0
    imminent_sent = False
    buf = np.zeros(0, dtype='float32')
    with (stream if stream is not None else contextlib.nullcontext()):
        while True:
            with lock:
                chunks, hops[:] = hops[:], []
            for c in chunks:
                buf = np.concatenate([buf, c])
            while buf.size >= HOP:
                hop, buf = buf[:HOP], buf[HOP:]
                ring = np.concatenate([ring[HOP:], hop])
                bands, flux = feats.process(ring)
                last_bands = bands
                for ev in sections.push(bands, flux):
                    osc.send(f'/rogger/agent/{ev[0]}', *ev[1:])
                    print('  '.join(str(x) for x in ev))
                if audible:
                    for name, strength in onsets.push(feats.band_flux,
                                                      time.monotonic()):
                        osc.send('/rogger/agent/onset', name, float(strength))
            if audible and feats.rms.v < SILENCE_RMS_OFF:
                audible = False
            elif not audible and feats.rms.v > SILENCE_RMS_ON:
                audible = True
            for ev in beats.poll(feats.onset, audible):
                if ev[0] == 'beat':
                    cur_beat = int(ev[1])
                    osc.send('/rogger/agent/beat', cur_beat, float(ev[2]))
                    # drop forecast: builds resolve on 16-bar phrase boundaries
                    if sections.state == 'build' and cur_bar > 0:
                        pos = (cur_bar - 1) % PHRASE_LEN
                        beats_until = (PHRASE_LEN - 1 - pos) * 4 + (5 - cur_beat)
                        secs = time.monotonic() - sections.state_since
                        conf = min(0.9, 0.3 + min(0.3, secs / 10 * 0.3) +
                                   (0.3 if beats_until <= 16 else 0.1))
                        osc.send('/rogger/agent/predict', 'drop', beats_until, conf)
                        # one-shot climax cue: the last two bars into the drop
                        if beats_until <= 8 and not imminent_sent:
                            imminent_sent = True
                            osc.send('/rogger/agent/event', 'dropimminent')
                    if sections.state != 'build':
                        imminent_sent = False
                else:
                    cur_bar = int(ev[1])
                    osc.send('/rogger/agent/downbeat', cur_bar)
                    pos = (cur_bar - 1) % PHRASE_LEN
                    osc.send('/rogger/agent/phrase', cur_bar, pos, PHRASE_LEN)
                    if pos == 0:
                        osc.send('/rogger/agent/event', 'phrasestart')
            now = time.monotonic()
            if now >= next_bands and last_bands is not None:
                osc.send('/rogger/agent/bands', *[float(x) for x in last_bands])
                next_bands = now + 1 / 15
            if now >= next_metrics:
                osc.send('/rogger/agent/metrics',
                         *[float(x) for x in sections.metrics(feats.vocal.v)])
                next_metrics = now + 1 / 5
                # vocal presence events with hysteresis (0.45 on / 0.25 off)
                if not vocal_on and feats.vocal.v > 0.45 and now - vocal_flip > 3.0:
                    vocal_on = True
                    vocal_flip = now
                    osc.send('/rogger/agent/event', 'vocalstart')
                elif vocal_on and feats.vocal.v < 0.25 and now - vocal_flip > 3.0:
                    vocal_on = False
                    vocal_flip = now
                    osc.send('/rogger/agent/event', 'vocalend')
            # resend on bpm OR confidence movement (plus a slow heartbeat) so
            # a steady tempo doesn't leave the app holding stale confidence
            if beats.bpm > 0 and (abs(beats.bpm - last_bpm_sent) > 0.5
                                  or abs(beats.conf - last_conf_sent) > 0.1
                                  or now - last_bpm_at > 5.0):
                last_bpm_sent, last_conf_sent, last_bpm_at = beats.bpm, beats.conf, now
                osc.send('/rogger/agent/bpm', float(beats.bpm), float(beats.conf))
            if now >= next_ping:
                seq += 1
                osc.send('/rogger/agent/ping', seq)
                osc.send('/rogger/agent/engine', engine_name)
                next_ping = now + 1.0
            time.sleep(0.005)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--target', default='127.0.0.1:7001',
                    help='ROGGER OSC input host:port (default 127.0.0.1:7001)')
    ap.add_argument('--device', default=None,
                    help='input device name substring or index (see --list-devices)')
    ap.add_argument('--engine', choices=('auto', 'beatnet', 'dsp'), default='dsp',
                    help='dsp (default; fastest, tightest tempo lock) | beatnet (ML '
                         'downbeats, slower to settle) | auto (beatnet with dsp fallback)')
    ap.add_argument('--demo', action='store_true',
                    help='scripted build/drop loop, no audio device needed')
    ap.add_argument('--list-devices', action='store_true')
    args = ap.parse_args()

    host, _, port = args.target.partition(':')
    osc = OscOut(host or '127.0.0.1', int(port or 7001))
    try:
        if args.demo:
            run_demo(osc)
        else:
            run_live(osc, args)
    except KeyboardInterrupt:
        print('\nbye')


if __name__ == '__main__':
    main()
