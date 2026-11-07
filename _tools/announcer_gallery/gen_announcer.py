# Announcer gallery: base renders (edge + kokoro) then FX chains over every
# dir in raw/. Output: out/<base>-<chain>/*.wav + ref-warlord/*.ogg copies.
# Run: python gen_announcer.py
import asyncio, glob, json, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, 'raw')
OUT = os.path.join(ROOT, 'out')
LINES = json.load(open(os.path.join(ROOT, 'lines.json'), encoding='utf-8'))['lines']
os.makedirs(RAW, exist_ok=True)

# ---- 1. edge-tts base renders (mp3) --------------------------------------
async def edge():
    import edge_tts
    for voice, slug in [('en-US-GuyNeural', 'edge-guy'), ('en-US-ChristopherNeural', 'edge-chris'),
                        ('en-US-AriaNeural', 'edge-aria')]:
        d = os.path.join(RAW, slug)
        os.makedirs(d, exist_ok=True)
        for l in LINES:
            out = os.path.join(d, l['chord'] + '.mp3')
            if os.path.exists(out):
                continue
            text = (l.get('alt') or {}).get('edge', l['text'])
            for attempt in range(3):
                try:
                    await edge_tts.Communicate(text.replace('!', ''), voice, rate='-15%').save(out)
                    break
                except Exception as e:
                    if attempt == 2:
                        print('EDGE FAIL', voice, l['chord'], type(e).__name__)
                    await asyncio.sleep(2 + attempt * 3)
        print('edge done', voice)

# ---- 2. kokoro base renders (wav) ----------------------------------------
def kokoro():
    from kokoro_onnx import Kokoro
    import soundfile as sf
    model = r'C:\Users\JPrice\.paseo\models\local-speech\kokoro-en-v0_19\model.onnx'
    voices = os.path.join(ROOT, '..', 'vgs_gallery', 'voices.bin')
    k = Kokoro(model, os.path.abspath(voices))
    for voice in ['am_michael', 'af_bella']:
        d = os.path.join(RAW, 'kokoro-' + voice)
        os.makedirs(d, exist_ok=True)
        for l in LINES:
            outp = os.path.join(d, l['chord'] + '.wav')
            if os.path.exists(outp):
                continue
            alt = (l.get('alt') or {}).get('kokoro')
            if alt and alt.startswith('ipa:'):
                s, sr = k.create(alt[4:], voice=voice, speed=0.92, is_phonemes=True)
            else:
                s, sr = k.create((alt or l['text']).replace('!', ''), voice=voice, speed=0.92)
            sf.write(outp, s, sr)
        print('kokoro done', voice)

# ---- 3. FX chains ---------------------------------------------------------
def fxpass():
    import numpy as np, soundfile as sf
    from pedalboard import (Pedalboard, PitchShift, Reverb, Compressor,
                            Distortion, LowpassFilter, HighpassFilter,
                            Gain, Limiter, Bitcrush, Chorus, Delay)

    FEMALE = {'kokoro-af_bella', 'sapi-zira', 'sapi-hazel', 'edge-aria'}

    CHAINS = {
        # Booth voice: pitched down, slow, plate reverb, crushed peaks.
        'booth': Pedalboard([
            PitchShift(semitones=-5), Reverb(room_size=0.55, wet_level=0.30, dry_level=0.8),
            Compressor(threshold_db=-18, ratio=6), Gain(gain_db=3), Limiter(threshold_db=-1.5),
        ]),
        # PA / stadium: bandpass-y grit + short echo, keep pitch natural.
        'pa': Pedalboard([
            HighpassFilter(cutoff_frequency_hz=300), LowpassFilter(cutoff_frequency_hz=3400),
            Distortion(drive_db=10), Bitcrush(bit_depth=10),
            Reverb(room_size=0.35, wet_level=0.22, dry_level=0.85),
            Compressor(threshold_db=-16, ratio=5), Limiter(threshold_db=-2),
        ]),
        # Demon drop: -8 semitones, darker reverb, heavy comp.
        'demon': Pedalboard([
            PitchShift(semitones=-8), LowpassFilter(cutoff_frequency_hz=6000),
            Reverb(room_size=0.7, wet_level=0.35, dry_level=0.75),
            Compressor(threshold_db=-20, ratio=8), Limiter(threshold_db=-1.5),
        ]),
        # Angelic/ethereal: +5st, chorus shimmer, cathedral tail — female
        # bases only (FEMALE set gates it below).
        'angel': Pedalboard([
            PitchShift(semitones=5), Chorus(rate_hz=1.2, depth=0.25, mix=0.4),
            Reverb(room_size=0.92, wet_level=0.5, dry_level=0.7, damping=0.25, width=1.0),
            Delay(delay_seconds=0.25, feedback=0.3, mix=0.18),
            Compressor(threshold_db=-20, ratio=4), Limiter(threshold_db=-1.5),
        ]),
    }
    for rawdir in sorted(os.listdir(RAW)):
        for ext in ('*.wav', '*.mp3'):
            for f in glob.glob(os.path.join(RAW, rawdir, ext)):
                try:
                    samples, sr = sf.read(f, dtype='float32')
                except Exception as e:
                    print('skip unreadable', f, e); continue
                if samples.ndim > 1:
                    samples = samples.mean(axis=1)
                for name, board in CHAINS.items():
                    if name == 'angel' and rawdir not in FEMALE:
                        continue
                    out = board(samples, sr)
                    peak = float(np.abs(out).max()) or 1.0
                    out = out / peak * 0.95
                    d = os.path.join(OUT, f'{rawdir}-{name}')
                    os.makedirs(d, exist_ok=True)
                    sf.write(os.path.join(d, os.path.splitext(os.path.basename(f))[0] + '.wav'), out, sr)
        print('fx done', rawdir)

# ---- 4. reference WARLORD clips -------------------------------------------
def warlord():
    src = r'C:\TEMP\_WEB\FPSWebTest\client\public\sfx'
    d = os.path.join(OUT, 'ref-warlord')
    os.makedirs(d, exist_ok=True)
    names = {'firstblood':'announce_firstblood.ogg','double':'announce_double.ogg',
             'triple':'announce_triple.ogg','killshot':'announce_killshot.ogg',
             'rampage':'announce_rampage.ogg','dominating':'announce_dominating.ogg',
             'unstoppable':'announce_unstoppable.ogg','godlike':'announce_eradication.ogg',
             'wickedsick':'announce_annihilation.ogg','annihilation':'announce_annihilation.ogg',
             'precision':'announce_precision.ogg'}
    for chord, f in names.items():
        p = os.path.join(src, f)
        if os.path.exists(p):
            shutil.copy(p, os.path.join(d, chord + '.ogg'))
    print('ref warlord copied')

if __name__ == '__main__':
    if os.environ.get('SKIP_EDGE') != '1':
        asyncio.run(edge())
    try:
        kokoro()
    except Exception as e:
        print('kokoro skipped:', e)
    subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                    '-File', os.path.join(ROOT, 'gen_sapi.ps1')], check=False)
    fxpass()
    warlord()
    print('ALL DONE')
