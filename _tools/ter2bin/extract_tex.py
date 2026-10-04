"""Extract every texture PNG a set of difs references, from any vl2 under
T2_BASE, into maps/t2/dif/ next to the difs — dif2glb resolves them by
basename from the dif's own directory."""
import zipfile, os, re, glob, sys

BASE = r"D:\[Games]\Tribes2\GameData\base"
OUT = "maps/t2/dif"
pat = sys.argv[1] if len(sys.argv) > 1 else "*.dif"

names = set()
for p in glob.glob(os.path.join(OUT, pat)):
    data = open(p, "rb").read()
    # dif material refs are extensionless "world/NAME" paths — the vl2s
    # store the actual files as textures/<world>/<NAME>.png
    for s in re.findall(rb"[\x20-\x7e]{4,}", data):
        s = s.decode("latin1").replace("\\", "/")
        if "/" not in s:
            continue
        leaf = s.split("/")[-1].lower()
        if leaf and leaf not in ("null", "origin", "trigger", "forcefield"):
            names.add(leaf)
print("tex refs:", len(names))

found = set()
for root, _, files in os.walk(BASE):
    for fn in files:
        if not fn.lower().endswith(".vl2"):
            continue
        try:
            z = zipfile.ZipFile(os.path.join(root, fn))
            for n in z.namelist():
                low = os.path.basename(n).lower()
                stem = low.rsplit(".", 1)[0]
                if low.endswith(".png") and stem in names and stem not in found:
                    open(os.path.join(OUT, low), "wb").write(z.read(n))
                    found.add(stem)
        except Exception:
            pass
print("extracted:", len(found))
print("missing:", sorted(names - found)[:25])
