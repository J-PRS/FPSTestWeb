#!/usr/bin/env python
# Mix analyzer: spectral stats + spectrogram PNG for each WAV in out/.
# Punchy reads: dominant low band, high crest, fast decay, short sustain.
# Ringy/painful reads: sustained narrow mid-high peak, slow decay, high flatness.
import sys, wave, os, subprocess
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), 'out')
FFMPEG = r'C:\Python313\Scripts\ffmpeg.exe'

def analyze(path):
    w = wave.open(path)
    sr = w.getframerate()
    n = w.getnframes()
    x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64) / 32768
    w.close()
    if len(x) < 100: return None
    win = np.hanning(len(x))
    mag = np.abs(np.fft.rfft(x * win))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    def band(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return float(np.sqrt((mag[m] ** 2).sum())) if m.any() else 0
    total = band(20, sr / 2) + 1e-9
    sub, low, mid, high = band(20,120)/total, band(120,500)/total, band(500,2500)/total, band(2500,11000)/total
    centroid = float((freqs * mag).sum() / (mag.sum() + 1e-9))
    peak = float(np.abs(x).max()); rms = float(np.sqrt((x**2).mean()))
    crest = peak / (rms + 1e-9)
    # decay: time for RMS envelope to fall to 10% of its max
    hop = 512
    env = np.sqrt(np.convolve(x**2, np.ones(hop)/hop, 'same'))
    emax = env.max(); above = np.where(env > emax*0.1)[0]
    sustain = (above[-1]-above[0])/sr if len(above) else 0
    return dict(sub=sub, low=low, mid=mid, high=high, centroid=centroid,
                peak=peak, rms=rms, crest=crest, sustain=sustain)

names = sys.argv[1:] or sorted(f[:-4] for f in os.listdir(OUT) if f.endswith('.wav'))
print(f"{'name':22} {'sub':>5} {'low':>5} {'mid':>5} {'high':>5} {'centHz':>6} {'peak':>5} {'rms':>5} {'crest':>5} {'sus':>5}")
for nm in names:
    p = os.path.join(OUT, nm + '.wav')
    if not os.path.exists(p): continue
    s = analyze(p)
    if not s: continue
    png = os.path.join(OUT, 'spec_' + nm + '.png')
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', p,
                    '-lavfi', 'showspectrumpic=s=640x320:legend=1', png])
    print(f"{nm:22} {s['sub']:5.2f} {s['low']:5.2f} {s['mid']:5.2f} {s['high']:5.2f} {s['centroid']:6.0f} {s['peak']:5.2f} {s['rms']:5.3f} {s['crest']:5.1f} {s['sustain']:5.2f}")
