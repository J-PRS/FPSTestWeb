# Pronunciation experiments: each variant dir becomes a gallery column.
# Only renders problem chords — delete a dir and rerun to try more.
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
from kokoro_onnx import Kokoro
MODEL = r'C:\Users\JPrice\.paseo\models\local-speech\kokoro-en-v0_19\model.onnx'
VOICES = os.path.join(ROOT, 'voices.bin')
kokoro = Kokoro(MODEL, VOICES)

# {suffix: {chord: (text, is_phonemes)}}
VARIANTS = {
    'x1': {'VGS': ('shaz bot', False), 'combo1': ('I am the shaz bot', False)},
    'x2': {'VGS': ('shazz bot', False), 'combo1': ('I am the shazz bot', False)},
    'x3': {'VGS': ('shahz baht', False), 'combo1': ('I am the shahz baht', False)},
    'x4': {'VGS': ('shazbott', False), 'combo1': ('I am the shazbott', False)},
    'x5': {'VGS': ('ʃˈæzbˌɑːt', True), 'combo1': ('aɪ æm ðə ʃˈæzbˌɑːt', True)},
    'x6': {'VGS': ('SHAZ-BOT', False), 'combo1': ('I am the SHAZ-BOT', False)},
    'x7': {'VGS': ('Chaz Bot', False), 'combo1': ('I am the Chaz Bot', False)},
    'x8': {'VGS': ('ʃˈæz bɑːt', True), 'combo1': ('aɪ æm ðə ʃˈæz bɑːt', True)},
}

import soundfile as sf
for voice in ['am_michael', 'af_bella']:
    for sfx, lines in VARIANTS.items():
        d = os.path.join(ROOT, 'out', f'kokoro-{voice}-{sfx}')
        os.makedirs(d, exist_ok=True)
        for chord, (text, is_ph) in lines.items():
            out = os.path.join(d, chord + '.wav')
            if os.path.exists(out):
                continue
            try:
                s, sr = kokoro.create(text, voice=voice, speed=1.0, is_phonemes=is_ph)
            except Exception as e:
                print('FAIL', voice, sfx, chord, repr(e))
                continue
            sf.write(out, s, sr)
    print('done', voice)
