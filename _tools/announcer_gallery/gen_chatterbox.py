# Chatterbox TTS announcer renders — raw wav into raw/chatterbox(-x),
# then run gen_announcer.py's fxpass step separately or call fx() here.
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
LINES = json.load(open(os.path.join(ROOT, 'lines.json'), encoding='utf-8'))['lines']

from chatterbox.tts import ChatterboxTTS
import torch, numpy as np, soundfile as sf

model = ChatterboxTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')

# two exaggeration settings = two "voices" of energy
for tag, ex in [('chatterbox', 0.4), ('chatterbox-hype', 0.8)]:
    d = os.path.join(ROOT, 'raw', tag)
    os.makedirs(d, exist_ok=True)
    for l in LINES:
        out = os.path.join(d, l['chord'] + '.wav')
        if os.path.exists(out):
            continue
        text = (l.get('alt') or {}).get('chatterbox', l['text'])
        wav = model.generate(text.replace('!', ''), exaggeration=ex, cfg_weight=0.5)
        sf.write(out, wav.squeeze(0).cpu().numpy(), model.sr)
    print('done', tag)
