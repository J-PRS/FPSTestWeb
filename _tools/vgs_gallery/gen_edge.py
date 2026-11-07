# edge-tts renders — mp3 per line per neural voice. alt['edge'] respell wins.
# Skips existing files. Run: python gen_edge.py  (from _tools/vgs_gallery)
import asyncio, json, os, re
import edge_tts

ROOT = os.path.dirname(os.path.abspath(__file__))
LINES = json.load(open(os.path.join(ROOT, 'lines.json'), encoding='utf-8'))['lines']
VOICES = ['en-US-GuyNeural', 'en-US-ChristopherNeural', 'en-AU-WilliamNeural']

async def render(voice, text, out):
    await edge_tts.Communicate(text.replace('!', ''), voice).save(out)

async def main():
    for v in VOICES:
        d = os.path.join(ROOT, 'out', 'edge-' + re.sub(r'[^A-Za-z0-9]', '', v))
        os.makedirs(d, exist_ok=True)
        for l in LINES:
            out = os.path.join(d, l['chord'] + '.mp3')
            if os.path.exists(out):
                continue
            text = (l.get('alt') or {}).get('edge', l['text'])
            await render(v, text, out)
            print(' ', v, l['chord'])
        print('done', v)

asyncio.run(main())
