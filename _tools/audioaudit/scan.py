import subprocess, sys, os, csv, numpy as np

ROOTS = sys.argv[1:]
EXTS = ('.wav', '.ogg', '.mp3', '.flac')
OUT = os.path.join(os.path.dirname(__file__), 'audit.csv')

def files():
    for root in ROOTS:
        for dp, _, names in os.walk(root):
            if '.git' in dp or '__MACOSX' in dp:
                continue
            for n in names:
                if n.lower().endswith(EXTS):
                    yield os.path.join(dp, n)

def analyze(path):
    try:
        p = subprocess.run(
            ['ffmpeg', '-v', 'quiet', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', '22050', '-'],
            capture_output=True, timeout=30)
        if not p.stdout:
            return None
        x = np.frombuffer(p.stdout, dtype=np.float32)
        if len(x) < 220:  # <10ms
            return None
        dur = len(x) / 22050.0
        peak = float(np.abs(x).max())
        rms = float(np.sqrt(np.mean(x ** 2)))
        # spectral centroid + rough band split via FFT on first 2s
        seg = x[:44100]
        w = np.hanning(len(seg))
        spec = np.abs(np.fft.rfft(seg * w))
        freqs = np.fft.rfftfreq(len(seg), 1 / 22050.0)
        mag = spec + 1e-9
        centroid = float((freqs * mag).sum() / mag.sum())
        low = float(mag[(freqs < 300)].sum() / mag.sum())
        mid = float(mag[(freqs >= 300) & (freqs < 3000)].sum() / mag.sum())
        high = float(mag[freqs >= 3000].sum() / mag.sum())
        crest = peak / (rms + 1e-9)
        # attack time: ms to reach 90% of peak envelope
        env = np.abs(x[:22050])
        k = np.maximum(env.size // 200, 1)
        sm = np.convolve(env, np.ones(k) / k, 'same')
        atk = float(np.argmax(sm >= 0.9 * sm.max()) / 22050.0) if sm.max() > 0 else 0
        return dur, peak, rms, crest, centroid, low, mid, high, atk
    except Exception:
        return None

KW = [
    ('explos', 'explosion'), ('boom', 'explosion'), ('bang', 'explosion'), ('blast', 'explosion'),
    ('grenade', 'explosion'), ('rocket', 'shot'), ('shot', 'shot'), ('shoot', 'shot'), ('fire', 'shot'),
    ('gun', 'shot'), ('laser', 'shot'), ('plasma', 'shot'), ('rail', 'shot'), ('zap', 'shot'),
    ('rifle', 'shot'), ('pistol', 'shot'), ('glock', 'shot'), ('machinegun', 'shot'),
    ('hit', 'hit'), ('impact', 'hit'), ('thud', 'hit'), ('punch', 'hit'), ('smack', 'hit'),
    ('jump', 'move'), ('land', 'move'), ('step', 'move'), ('foot', 'move'), ('walk', 'move'),
    ('ski', 'move'), ('slide', 'move'), ('whoosh', 'move'), ('dash', 'move'), ('wind', 'ambience'),
    ('jet', 'loop'), ('engine', 'loop'), ('loop', 'loop'), ('ambient', 'ambience'), ('drone', 'ambience'),
    ('pickup', 'ui'), ('coin', 'ui'), ('powerup', 'ui'), ('collect', 'ui'), ('click', 'ui'),
    ('beep', 'ui'), ('bell', 'ui'), ('notif', 'ui'), ('menu', 'ui'), ('select', 'ui'),
    ('teleport', 'misc'), ('alarm', 'misc'), ('gib', 'gore'), ('hurt', 'voice'), ('pain', 'voice'),
    ('death', 'voice'), ('scream', 'voice'), ('growl', 'voice'), ('roar', 'voice'), ('monster', 'voice'),
    ('sword', 'melee'), ('slash', 'melee'), ('swing', 'melee'), ('metal', 'hit'), ('ricochet', 'hit'),
    ('reload', 'misc'), ('charge', 'misc'), ('shield', 'misc'), ('health', 'ui'), ('armor', 'ui'),
]
def cat(path):
    s = (os.path.basename(path) + ' ' + os.path.dirname(path)).lower().replace('\\', '/')
    for k, c in KW:
        if k in s:
            return c
    return 'other'

rows = []
flist = sorted(set(files()))
for i, f in enumerate(flist):
    r = analyze(f)
    if r:
        dur, peak, rms, crest, cent, low, mid, high, atk = r
        rows.append((f, cat(f), f'{dur:.2f}', f'{peak:.3f}', f'{rms:.4f}',
                     f'{crest:.1f}', f'{cent:.0f}', f'{low:.2f}', f'{mid:.2f}', f'{high:.2f}', f'{atk*1000:.0f}'))
    if i % 100 == 0:
        print(f'{i}/{len(flist)}', flush=True)

with open(OUT, 'w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(['path', 'cat', 'dur_s', 'peak', 'rms', 'crest', 'centroid_hz', 'low', 'mid', 'high', 'attack_ms'])
    w.writerows(rows)
print(f'done: {len(rows)} files -> {OUT}')
