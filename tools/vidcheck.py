#!/usr/bin/env python3
"""vidcheck — cheap motion analyzer for rendered demo clips.

Samples one frame per second out of a video and reports how much the
picture actually changes between samples. A real gameplay POV (moving
camera, bots, tracers) diffs hard; a frozen/stuck recording reads ~0.

Usage:
  python tools/vidcheck.py clip.mp4 [--strip dir] [--threshold 2.0]

Prints per-second mean absolute pixel delta (0-255 scale) plus a
summary verdict: OK (moving), SUSPICIOUS (mostly still), FROZEN.
--strip writes the sampled frames to a dir for eyeball comparison.
"""
import argparse
import os
import struct
import subprocess
import sys
import zlib

FFMPEG = r"C:\Python313\Scripts\ffmpeg.exe"
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"


def png_size_and_pixels(path):
    """Decode a PNG (8-bit RGB/RGBA, no interlace) to (w, h, bytearray).
    Minimal decoder — we only need mean abs diff, so filter types are
    unwound manually."""
    with open(path, "rb") as f:
        raw = f.read()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    pos, idat, w, h, depth, ctype = 8, b"", 0, 0, 8, 6
    while pos < len(raw):
        ln, tag = struct.unpack(">I4s", raw[pos:pos + 8])
        data = raw[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", data[:10])
        elif tag == b"IDAT":
            idat += data
        elif tag == b"IEND":
            break
    assert depth == 8 and ctype in (2, 6), f"unsupported png depth={depth} type={ctype}"
    ch = 3 if ctype == 2 else 4
    raw_img = zlib.decompress(idat)
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f0 = raw_img[p]; p += 1
        line = bytearray(raw_img[p:p + stride]); p += stride
        if f0 == 1:  # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f0 == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f0 == 3:  # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f0 == 4:  # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out


def mean_abs_delta(a, b, stride, ch):
    """Mean |a-b| over RGB channels, subsampled every 4th pixel for speed."""
    total, n = 0, 0
    for i in range(0, len(a), stride * 4):
        for c in range(3):
            total += abs(a[i + c] - b[i + c])
            n += 1
    return total / max(1, n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--strip", default="", help="dir to dump sampled frames")
    ap.add_argument("--fps", type=float, default=1.0, help="sample rate (frames/sec)")
    ap.add_argument("--threshold", type=float, default=2.0,
                    help="mean |delta| below which a second counts as still")
    args = ap.parse_args()

    tmp = args.strip or os.path.join(os.path.dirname(os.path.abspath(args.video)), "_vidcheck_frames")
    os.makedirs(tmp, exist_ok=True)
    pat = os.path.join(tmp, "f%04d.png")
    # fps=1 → one frame per second; scale to 160px wide for a fast decode
    r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", args.video,
                        "-vf", f"fps={args.fps},scale=160:-1", pat])
    if r.returncode != 0:
        sys.exit("ffmpeg failed")

    frames = sorted(f for f in os.listdir(tmp) if f.startswith("f") and f.endswith(".png"))
    if len(frames) < 2:
        sys.exit(f"only {len(frames)} frames sampled — is the video playable?")

    prev = None
    deltas = []
    for fn in frames:
        w, h, ch, px = png_size_and_pixels(os.path.join(tmp, fn))
        if prev is not None:
            deltas.append(mean_abs_delta(prev[1], px, w * ch, ch))
        prev = (fn, px)

    still = sum(1 for d in deltas if d < args.threshold)
    print(f"sampled {len(frames)} frames @ {args.fps}/s from {os.path.basename(args.video)}")
    for i, d in enumerate(deltas):
        mark = "  <-- still" if d < args.threshold else ""
        print(f"  t={i + 1}s  mean|d|={d:6.2f}{mark}")
    avg = sum(deltas) / len(deltas)
    print(f"avg motion {avg:.2f} | still seconds {still}/{len(deltas)} (threshold {args.threshold})")
    if avg < args.threshold:
        print("VERDICT: FROZEN — camera/world barely changes, likely a broken or spectator clip")
    elif still > len(deltas) * 0.6:
        print("VERDICT: SUSPICIOUS — over half the clip is still")
    else:
        print("VERDICT: OK — picture is moving")


if __name__ == "__main__":
    main()
