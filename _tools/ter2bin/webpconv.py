"""Re-encode baked map PNGs to WebP and repoint the manifests.

Runs over every maps/t2/<map>/ directory:
  albedo.png    -> albedo.webp   (spec terrainTex path updated)
  tiles/*.png   -> .webp         (mats.json tiles[] paths updated)
  sky/*.png     -> .webp         (client loader tries .webp, then .png)

Sources are deleted after a successful encode — the VL2 + this script
regenerate them; keeping both copies doubles the shipped payload.
"""
import json, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
T2 = ROOT / "maps" / "t2"
SPECS = ROOT / "maps"

Q = {"albedo": 90, "tiles": 92, "sky": 88}

def conv(src: Path, q: int) -> tuple[int, int]:
    dst = src.with_suffix(".webp")
    Image.open(src).save(dst, "WEBP", quality=q, method=6)
    old, new = src.stat().st_size, dst.stat().st_size
    src.unlink()
    return old, new

def main() -> None:
    tot_old = tot_new = 0
    for mdir in sorted(p for p in T2.iterdir() if p.is_dir()):
        old = new = 0
        alb = mdir / "albedo.png"
        if alb.exists():
            o, n = conv(alb, Q["albedo"]); old += o; new += n
        for tdir, q in ((mdir / "tiles", Q["tiles"]), (mdir / "sky", Q["sky"])):
            if tdir.is_dir():
                for f in sorted(tdir.glob("*.png")):
                    o, n = conv(f, q); old += o; new += n
        mats = mdir / "mats.json"
        if mats.exists():
            m = json.loads(mats.read_text(encoding="utf8"))
            if m.get("tiles") and any(t.endswith(".png") for t in m["tiles"]):
                m["tiles"] = [t[:-4] + ".webp" if t.endswith(".png") else t for t in m["tiles"]]
                mats.write_text(json.dumps(m), encoding="utf8")
        if old:
            print(f"{mdir.name:20s} {old/1e6:7.2f}MB -> {new/1e6:6.2f}MB")
            tot_old += old; tot_new += new
    # Spec terrainTex paths carry the filename verbatim — repoint them.
    for spec in SPECS.glob("*.json"):
        s = spec.read_text(encoding="utf8")
        if 'albedo.png' in s:
            spec.write_text(s.replace('albedo.png', 'albedo.webp'), encoding="utf8")
            print(f"spec {spec.name}: terrainTex -> .webp")
    print(f"{'TOTAL':20s} {tot_old/1e6:7.2f}MB -> {tot_new/1e6:6.2f}MB")

if __name__ == "__main__":
    sys.exit(main())
