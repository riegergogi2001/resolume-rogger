#!/usr/bin/env python3
"""Self-test for the onset trigger layer — run with `python3 test_onset.py`.

The OnsetDetector part is pure Python and always runs; the Features part
needs numpy and is skipped (with a note) when it is missing.
"""
import sys

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import rogger_agent as ra


def test_onset_detector():
    rate = 43.0                       # ~HOP_HZ at 44.1k
    det = ra.OnsetDetector(rate)
    base = [0.10, 0.05, 0.02]         # steady per-band flux floor

    # warm up on jittered baseline: no events allowed
    t = 0.0
    for i in range(int(rate * 2)):
        jitter = 1.0 + 0.1 * ((i % 7) - 3) / 3.0
        evs = det.push([b * jitter for b in base], t)
        assert evs == [], f'baseline fired {evs} at {t:.2f}s'
        t += 1.0 / rate

    # a kick-band spike fires exactly one kick
    evs = det.push([base[0] * 8, base[1], base[2]], t)
    assert [n for n, _ in evs] == ['kick'], f'expected kick, got {evs}'
    assert 0.0 < evs[0][1] <= 1.0, f'strength out of range: {evs}'

    # a second spike inside the refractory window is swallowed
    t += 1.0 / rate
    evs = det.push([base[0] * 8, base[1], base[2]], t)
    assert evs == [], f'refractory leak: {evs}'

    # after the refractory it fires again (history has decayed spikes in it,
    # so give it a beat of baseline first)
    for _ in range(int(rate * 0.5)):
        t += 1.0 / rate
        det.push(base, t)
    t += 1.0 / rate
    evs = det.push([base[0] * 8, base[1], base[2]], t)
    assert [n for n, _ in evs] == ['kick'], f'no re-fire after refractory: {evs}'

    # snare and hat bands route to their own names, and can fire together
    for _ in range(int(rate * 0.5)):
        t += 1.0 / rate
        det.push(base, t)
    t += 1.0 / rate
    evs = det.push([base[0], base[1] * 8, base[2] * 8], t)
    assert sorted(n for n, _ in evs) == ['hat', 'snare'], f'band routing: {evs}'
    print('OnsetDetector: OK')


def test_features_band_flux():
    try:
        import numpy as np
    except ImportError:
        print('Features band flux: SKIP (numpy not installed)')
        return
    feats = ra.Features(np)
    silence = np.zeros(ra.FRAME, dtype='float32')
    for _ in range(4):
        feats.process(silence)
    assert feats.band_flux == [0.0, 0.0, 0.0], 'silence must have zero flux'

    # a 100 Hz burst is a kick-band transient: band 0 flux dominates
    n = np.arange(ra.FRAME)
    burst = (0.8 * np.sin(2 * np.pi * 100.0 * n / ra.SR)).astype('float32')
    feats.process(burst)
    kick, snare, hat = feats.band_flux
    assert kick > 0, 'kick-band flux missing on a bass burst'
    assert kick > snare * 5 and kick > hat * 5, \
        f'bass burst leaked across bands: {feats.band_flux}'
    print('Features band flux: OK')


if __name__ == '__main__':
    test_onset_detector()
    test_features_band_flux()
    print('all onset tests passed')
