# Chatterbox VGS renders: raw voice + radio-processed variant.
# Run: python gen_chatterbox.py  (from _tools/vgs_gallery)
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
LINES = json.load(open(os.path.join(ROOT, 'lines.json'), encoding='utf-8'))['lines']

import torch, numpy as np, soundfile as sf
from chatterbox.tts import ChatterboxTTS
model = ChatterboxTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')

for tag, ex in [('chatterbox', 0.4), ('chatterbox-hype', 0.8)]:
    d = os.path.join(ROOT, 'out', tag)
    os.makedirs(d, exist_ok=True)
    for l in LINES:
        out = os.path.join(d, l['chord'] + '.wav')
        if os.path.exists(out):
            continue
        text = (l.get('alt') or {}).get('chatterbox', l['text'])
        wav = model.generate(text.replace('!', ''), exaggeration=ex, cfg_weight=0.5)
        sf.write(out, wav.squeeze(0).cpu().numpy(), model.sr)
        print(' ', tag, l['chord'])
    print('done', tag)

# radio chain: human voice through the battlesuit comm wrapper
from pedalboard import (Pedalboard, HighpassFilter, LowpassFilter,
                        Compressor, Distortion, Reverb, Limiter, Gain)
RADIO = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=450), LowpassFilter(cutoff_frequency_hz=2800),
    Compressor(threshold_db=-20, ratio=8),
    Distortion(drive_db=6),
    Reverb(room_size=0.12, wet_level=0.10, dry_level=0.95),
    Gain(gain_db=2), Limiter(threshold_db=-2),
])
for tag in ['chatterbox', 'chatterbox-hype']:
    src = os.path.join(ROOT, 'out', tag)
    dst = os.path.join(ROOT, 'out', tag + '-radio')
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(src):
        if not f.endswith('.wav'):
            continue
        s, sr = sf.read(os.path.join(src, f), dtype='float32')
        if s.ndim > 1:
            s = s.mean(axis=1)
        out = RADIO(s, sr)
        peak = float(np.abs(out).max()) or 1.0
        sf.write(os.path.join(dst, f), out / peak * 0.95, sr)
    print('radio done', tag)
