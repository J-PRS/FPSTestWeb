# Kokoro local TTS renders — wav per line per voice.
# Per-line alt overrides: 'ipa:<phonemes>' feeds is_phonemes=True, anything
# else is respelled text. Skips existing files — delete to re-render.
# Run: python gen_kokoro.py  (from _tools/vgs_gallery)
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
try:
    from kokoro_onnx import Kokoro
except ImportError:
    sys.exit('kokoro-onnx not installed')

MODEL = r'C:\Users\JPrice\.paseo\models\local-speech\kokoro-en-v0_19\model.onnx'
VOICES = os.path.join(ROOT, 'voices.bin')
if not os.path.exists(VOICES):
    import urllib.request
    url = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'
    print('downloading voices.bin...')
    urllib.request.urlretrieve(url, VOICES)

def text_for(l):
    alt = (l.get('alt') or {}).get('kokoro')
    if alt and alt.startswith('ipa:'):
        return alt[4:], True
    return (alt or l['text']).replace('!', ''), False

kokoro = Kokoro(MODEL, VOICES)
LINES = json.load(open(os.path.join(ROOT, 'lines.json'), encoding='utf-8'))['lines']
import soundfile as sf
for voice in ['am_michael', 'af_bella']:
    d = os.path.join(ROOT, 'out', 'kokoro-' + voice)
    os.makedirs(d, exist_ok=True)
    for l in LINES:
        out = os.path.join(d, l['chord'] + '.wav')
        if os.path.exists(out):
            continue
        text, is_ph = text_for(l)
        try:
            samples, sr = kokoro.create(text, voice=voice, speed=1.0, is_phonemes=is_ph)
        except Exception as e:
            print('FAIL', voice, l['chord'], e)
            samples, sr = kokoro.create(l['text'].replace('!', ''), voice=voice, speed=1.0)
        sf.write(out, samples, sr)
        print(' ', voice, l['chord'])
    print('done', voice)
