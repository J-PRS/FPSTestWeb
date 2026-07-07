#!/usr/bin/env python3
"""
Demo stats utility - parses .demo binary files and prints stats.

Binary format (all little-endian):
  Header:
    uint8   magic (0x44)
    int32   formatVersion
    uint16  gameVersionLen + UTF-8 bytes
    float64 timestamp (epoch ms)
    float32 duration (seconds)
    uint32  totalFrames
    uint32  projectileEventCount
    uint32  targetEventCount
    uint32  checksum (CRC32)
    uint16  descriptionLen + UTF-8 bytes
    float32 startPosX/Y/Z
    float32 startYaw, startPitch
    float32 startVelX/Y/Z
  Frames: uint32 count + count * 48 bytes
  Projectile events: uint32 count + count * 59 bytes
  Target events: uint32 count + count * 49 bytes

Usage:
    python demo_stats.py                    # stats for all demos in ../server_bun/demos
    python demo_stats.py <file.demo>        # detailed stats for one file
    python demo_stats.py --dir <path>       # stats for all demos in custom dir
"""

import struct
import sys
import os
import glob
import math
from datetime import datetime

DEMO_MAGIC = 0x44
FRAME_SIZE = 48
PROJECTILE_EVENT_SIZE = 59
TARGET_EVENT_SIZE = 49

PROJ_EVENT_NAMES = {0: "Fired", 1: "Bounce", 2: "Hit", 3: "Destroyed"}
TARGET_EVENT_NAMES = {0: "Spawned", 1: "Bounce", 2: "Hit", 3: "Destroyed", 4: "StateChanged"}

ROCKET_SPEED = 100.0  # from config.ts
DISC_SPEED = 80.0     # from config.ts
GRAVITY = -30.0       # from config.ts (negative = downward)


def read_string(data, offset):
    """Read uint16 length + UTF-8 string. Returns (string, new_offset)."""
    (length,) = struct.unpack_from("<H", data, offset)
    offset += 2
    s = data[offset:offset + length].decode("utf-8", errors="replace")
    return s, offset + length


def parse_header(data):
    """Parse demo header. Returns dict + offset to frames section."""
    offset = 0
    magic = data[offset]; offset += 1
    if magic != DEMO_MAGIC:
        raise ValueError(f"Bad magic: 0x{magic:02x}")

    (format_version,) = struct.unpack_from("<i", data, offset); offset += 4
    game_version, offset = read_string(data, offset)
    (timestamp,) = struct.unpack_from("<d", data, offset); offset += 8
    (duration,) = struct.unpack_from("<f", data, offset); offset += 4
    (total_frames,) = struct.unpack_from("<I", data, offset); offset += 4
    (proj_count,) = struct.unpack_from("<I", data, offset); offset += 4
    (target_count,) = struct.unpack_from("<I", data, offset); offset += 4
    (checksum,) = struct.unpack_from("<I", data, offset); offset += 4
    description, offset = read_string(data, offset)
    (start_x,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_y,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_z,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_yaw,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_pitch,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_vx,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_vy,) = struct.unpack_from("<f", data, offset); offset += 4
    (start_vz,) = struct.unpack_from("<f", data, offset); offset += 4

    return {
        "magic": magic,
        "format_version": format_version,
        "game_version": game_version,
        "timestamp": timestamp,
        "duration": duration,
        "total_frames": total_frames,
        "proj_event_count": proj_count,
        "target_event_count": target_count,
        "checksum": checksum,
        "description": description,
        "start_pos": (start_x, start_y, start_z),
        "start_yaw": start_yaw,
        "start_pitch": start_pitch,
        "start_vel": (start_vx, start_vy, start_vz),
        "_offset": offset,
    }


def parse_frames(data, offset, count):
    """Parse count frames. Returns list of dicts."""
    frames = []
    for _ in range(count):
        (frame_num,) = struct.unpack_from("<H", data, offset); offset += 2
        (ts,) = struct.unpack_from("<f", data, offset); offset += 4
        px, py, pz, vx, vy, vz, yaw, pitch = struct.unpack_from("<8f", data, offset)
        offset += 32
        (input_flags,) = struct.unpack_from("<B", data, offset); offset += 1
        (mouse_dx,) = struct.unpack_from("<h", data, offset); offset += 2
        (mouse_dy,) = struct.unpack_from("<h", data, offset); offset += 2
        (jet_flags,) = struct.unpack_from("<B", data, offset); offset += 1
        (jet_fuel,) = struct.unpack_from("<f", data, offset); offset += 4
        frames.append({
            "frame": frame_num, "ts": ts,
            "pos": (px, py, pz), "vel": (vx, vy, vz),
            "yaw": yaw, "pitch": pitch,
            "input": input_flags, "jet": jet_flags, "fuel": jet_fuel,
        })
    return frames


def parse_proj_events(data, offset, count):
    """Parse projectile events. Returns list of dicts."""
    events = []
    for _ in range(count):
        (event_type,) = struct.unpack_from("<B", data, offset); offset += 1
        (ts,) = struct.unpack_from("<f", data, offset); offset += 4
        px, py, pz, vx, vy, vz = struct.unpack_from("<6f", data, offset)
        offset += 24
        (proj_id,) = struct.unpack_from("<H", data, offset); offset += 2
        (weapon_type,) = struct.unpack_from("<B", data, offset); offset += 1
        snx, sny, snz = struct.unpack_from("<3f", data, offset)
        offset += 12
        (target_id,) = struct.unpack_from("<H", data, offset); offset += 2
        (has_peak,) = struct.unpack_from("<B", data, offset); offset += 1
        pkx, pky, pkz = struct.unpack_from("<3f", data, offset)
        offset += 12
        events.append({
            "type": PROJ_EVENT_NAMES.get(event_type, f"Unknown({event_type})"),
            "ts": ts, "pos": (px, py, pz), "vel": (vx, vy, vz),
            "proj_id": proj_id, "weapon": weapon_type,
            "target_id": target_id, "has_peak": bool(has_peak),
        })
    return events


def parse_target_events(data, offset, count):
    """Parse target events. Returns list of dicts."""
    events = []
    for _ in range(count):
        (event_type,) = struct.unpack_from("<B", data, offset); offset += 1
        (ts,) = struct.unpack_from("<f", data, offset); offset += 4
        px, py, pz, vx, vy, vz = struct.unpack_from("<6f", data, offset)
        offset += 24
        (target_id,) = struct.unpack_from("<H", data, offset); offset += 2
        (target_type,) = struct.unpack_from("<B", data, offset); offset += 1
        (health,) = struct.unpack_from("<f", data, offset); offset += 4
        (has_peak,) = struct.unpack_from("<B", data, offset); offset += 1
        pkx, pky, pkz = struct.unpack_from("<3f", data, offset)
        offset += 12
        events.append({
            "type": TARGET_EVENT_NAMES.get(event_type, f"Unknown({event_type})"),
            "ts": ts, "pos": (px, py, pz), "vel": (vx, vy, vz),
            "target_id": target_id, "target_type": target_type,
            "health": health, "has_peak": bool(has_peak),
        })
    return events


def parse_demo(filepath):
    """Parse a .demo file. Returns dict with all data."""
    with open(filepath, "rb") as f:
        data = f.read()

    header = parse_header(data)
    offset = header["_offset"]

    (frame_count,) = struct.unpack_from("<I", data, offset); offset += 4
    frames = parse_frames(data, offset, frame_count)
    offset += frame_count * FRAME_SIZE

    (proj_count,) = struct.unpack_from("<I", data, offset); offset += 4
    proj_events = parse_proj_events(data, offset, proj_count)
    offset += proj_count * PROJECTILE_EVENT_SIZE

    (target_count,) = struct.unpack_from("<I", data, offset); offset += 4
    target_events = parse_target_events(data, offset, target_count)
    offset += target_count * TARGET_EVENT_SIZE

    return {
        "header": header,
        "frames": frames,
        "proj_events": proj_events,
        "target_events": target_events,
        "file_size": len(data),
    }


def parse_lifetime_from_desc(desc):
    """Extract projectile lifetime from description string."""
    import re
    m = re.search(r"([\d.]+)s air", desc)
    return float(m.group(1)) if m else None


def compute_airtime_verification(demo):
    """Match Fired->Hit events by proj_id and verify airtime.
    Returns list of dicts with verification info."""
    proj_events = demo["proj_events"]
    fired = {}   # proj_id -> event
    results = []

    for e in proj_events:
        if e["type"] == "Fired":
            fired[e["proj_id"]] = e
        elif e["type"] in ("Hit", "Destroyed"):
            f = fired.get(e["proj_id"])
            if not f:
                continue
            airtime_ts = e["ts"] - f["ts"]
            fp = f["pos"]
            hp = e["pos"]
            dx = hp[0] - fp[0]
            dy = hp[1] - fp[1]
            dz = hp[2] - fp[2]
            dist = math.sqrt(dx*dx + dy*dy + dz*dz)
            speed = math.sqrt(f["vel"][0]**2 + f["vel"][1]**2 + f["vel"][2]**2)
            # Expected airtime (straight-line, no gravity): dist / speed
            expected_air = dist / speed if speed > 0 else 0
            # For rockets with gravity, actual path is longer (parabolic)
            # so expected_air is a lower bound. Real airtime >= expected_air.
            weapon = "rocket" if f["weapon"] == 0 else "disc"
            results.append({
                "proj_id": e["proj_id"],
                "weapon": weapon,
                "fired_ts": f["ts"],
                "hit_ts": e["ts"],
                "airtime_ts": airtime_ts,
                "distance": dist,
                "speed": speed,
                "expected_air": expected_air,
                "hit_type": e["type"],
                "target_id": e["target_id"],
                "fired_pos": fp,
                "hit_pos": hp,
            })
    return results


def print_summary(filepath):
    """Print summary stats for one demo file."""
    demo = parse_demo(filepath)
    h = demo["header"]
    lifetime = parse_lifetime_from_desc(h["description"])

    print(f"\n{'=' * 60}")
    print(f"File: {os.path.basename(filepath)}")
    print(f"Size: {demo['file_size']:,} bytes")
    print(f"{'─' * 60}")
    print(f"  Format version:  {h['format_version']}")
    print(f"  Game version:    {h['game_version']}")
    print(f"  Duration:        {h['duration']:.2f}s")
    print(f"  Lifetime (air):  {lifetime:.3f}s" if lifetime else "  Lifetime:        N/A")
    print(f"  Description:     {h['description']}")
    print(f"  Timestamp:       {datetime.fromtimestamp(h['timestamp'] / 1000).strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Start pos:       ({h['start_pos'][0]:.1f}, {h['start_pos'][1]:.1f}, {h['start_pos'][2]:.1f})")
    print(f"  Start vel:       ({h['start_vel'][0]:.1f}, {h['start_vel'][1]:.1f}, {h['start_vel'][2]:.1f})")
    print(f"  {'─' * 56}")
    print(f"  Frames:          {len(demo['frames'])}")
    print(f"  Proj events:     {len(demo['proj_events'])}")
    print(f"  Target events:   {len(demo['target_events'])}")

    # Event breakdown
    if demo["proj_events"]:
        proj_types = {}
        for e in demo["proj_events"]:
            proj_types[e["type"]] = proj_types.get(e["type"], 0) + 1
        print(f"  Proj breakdown:  {proj_types}")

    if demo["target_events"]:
        tgt_types = {}
        for e in demo["target_events"]:
            tgt_types[e["type"]] = tgt_types.get(e["type"], 0) + 1
        print(f"  Target breakdown: {tgt_types}")

    # Unique projectile IDs
    proj_ids = set(e["proj_id"] for e in demo["proj_events"])
    target_ids = set(e["target_id"] for e in demo["target_events"])
    print(f"  Unique proj IDs: {len(proj_ids)}")
    print(f"  Unique tgt IDs:  {len(target_ids)}")

    # Frame rate
    if len(demo["frames"]) > 1:
        first_ts = demo["frames"][0]["ts"]
        last_ts = demo["frames"][-1]["ts"]
        frame_dur = last_ts - first_ts
        if frame_dur > 0:
            fps = len(demo["frames"]) / frame_dur
            print(f"  Avg frame rate:  {fps:.1f} fps")

    # Airtime verification
    verifications = compute_airtime_verification(demo)
    if verifications:
        print(f"  {'─' * 56}")
        print(f"  Airtime Verification (Fired->Hit matched by proj_id):")
        for v in verifications:
            flag = ""
            if lifetime and v["hit_type"] == "Hit":
                # Compare description lifetime to timestamp-based airtime
                diff = abs(lifetime - v["airtime_ts"])
                if diff > 0.5:
                    flag = f"  *** MISMATCH: desc={lifetime:.2f}s vs ts={v['airtime_ts']:.2f}s (diff={diff:.2f}s)"
            print(f"    id={v['proj_id']:5d} {v['weapon']:6s} {v['hit_type']:10s} "
                  f"air={v['airtime_ts']:6.3f}s  dist={v['distance']:7.1f}m  "
                  f"speed={v['speed']:5.1f}  exp_air={v['expected_air']:6.3f}s  "
                  f"tgt={v['target_id']}{flag}")
        if lifetime:
            # Find the Hit event with longest airtime (should match description)
            hits = [v for v in verifications if v["hit_type"] == "Hit"]
            if hits:
                best = max(hits, key=lambda v: v["airtime_ts"])
                print(f"  -> Desc claims {lifetime:.2f}s, best Hit airtime={best['airtime_ts']:.3f}s "
                      f"(dist={best['distance']:.1f}m, {best['weapon']})")

    print(f"{'=' * 60}")


def print_detailed(filepath):
    """Print detailed event log for one demo file."""
    demo = parse_demo(filepath)
    h = demo["header"]
    lifetime = parse_lifetime_from_desc(h["description"])

    print_summary(filepath)

    print(f"\n  --- Projectile Events ---")
    for e in demo["proj_events"]:
        p = e["pos"]
        v = e["vel"]
        print(f"    [{e['ts']:7.3f}s] {e['type']:10s} id={e['proj_id']:5d} pos=({p[0]:7.1f},{p[1]:7.1f},{p[2]:7.1f}) vel=({v[0]:6.1f},{v[1]:6.1f},{v[2]:6.1f}) tgt={e['target_id']}")

    print(f"\n  --- Target Events ---")
    for e in demo["target_events"]:
        p = e["pos"]
        v = e["vel"]
        print(f"    [{e['ts']:7.3f}s] {e['type']:10s} id={e['target_id']:5d} pos=({p[0]:7.1f},{p[1]:7.1f},{p[2]:7.1f}) vel=({v[0]:6.1f},{v[1]:6.1f},{v[2]:6.1f}) hp={e['health']:.0f} type={e['target_type']}")

    # First and last few frames
    print(f"\n  --- Frames (first 3 + last 3) ---")
    for f in demo["frames"][:3]:
        p = f["pos"]
        print(f"    [{f['ts']:7.3f}s] frame={f['frame']:5d} pos=({p[0]:7.1f},{p[1]:7.1f},{p[2]:7.1f}) yaw={f['yaw']:.3f} pitch={f['pitch']:.3f} input=0x{f['input']:02x}")
    if len(demo["frames"]) > 6:
        print(f"    ...")
    for f in demo["frames"][-3:]:
        p = f["pos"]
        print(f"    [{f['ts']:7.3f}s] frame={f['frame']:5d} pos=({p[0]:7.1f},{p[1]:7.1f},{p[2]:7.1f}) yaw={f['yaw']:.3f} pitch={f['pitch']:.3f} input=0x{f['input']:02x}")


def print_table(demos):
    """Print a summary table for multiple demos."""
    print(f"\n{'=' * 110}")
    print(f"{'File':<52} {'Size':>8} {'Desc':>6} {'Real':>6} {'Match':>6} {'Dist':>7} {'Spd':>5} {'Dur':>6} {'Frames':>7}")
    print(f"{'─' * 110}")

    total_size = 0
    lifetimes = []
    real_airtimes = []
    mismatches = 0

    for filepath in demos:
        try:
            demo = parse_demo(filepath)
            h = demo["header"]
            lifetime = parse_lifetime_from_desc(h["description"]) or 0
            lifetimes.append(lifetime)
            total_size += demo["file_size"]
            name = os.path.basename(filepath)

            # Find real airtime from events
            verifications = compute_airtime_verification(demo)
            hits = [v for v in verifications if v["hit_type"] == "Hit"]
            real_air = max((v["airtime_ts"] for v in hits), default=0)
            real_airtimes.append(real_air)
            best_hit = max(hits, key=lambda v: v["airtime_ts"], default=None)
            dist = best_hit["distance"] if best_hit else 0
            spd = best_hit["speed"] if best_hit else 0
            match = "OK" if abs(lifetime - real_air) < 0.5 else "*** DIFF"
            if abs(lifetime - real_air) >= 0.5:
                mismatches += 1

            print(f"{name:<52} {demo['file_size']:>8,} {lifetime:>6.2f} {real_air:>6.2f} {match:>6} {dist:>7.1f} {spd:>5.0f} {h['duration']:>6.2f} {len(demo['frames']):>7}")
        except Exception as e:
            print(f"{os.path.basename(filepath):<52} ERROR: {e}")

    print(f"{'─' * 110}")
    print(f"{'TOTAL':<52} {total_size:>8,}")
    if lifetimes:
        print(f"  Demos: {len(demos)}  |  Best desc air: {max(lifetimes):.2f}s  |  Best real air: {max(real_airtimes):.2f}s  |  Mismatches: {mismatches}")
    print(f"{'=' * 110}")


def main():
    args = sys.argv[1:]

    if len(args) == 0:
        # Default: all demos in ../server_bun/demos
        demo_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server_bun", "demos")
        demos = sorted(glob.glob(os.path.join(demo_dir, "*.demo")))
        if not demos:
            print(f"No .demo files found in {demo_dir}")
            return
        print_table(demos)

    elif args[0] == "--dir":
        if len(args) < 2:
            print("Usage: python demo_stats.py --dir <path>")
            return
        demos = sorted(glob.glob(os.path.join(args[1], "*.demo")))
        if not demos:
            print(f"No .demo files found in {args[1]}")
            return
        print_table(demos)

    elif args[0] == "--detail" and len(args) == 2:
        print_detailed(args[1])

    elif args[0].endswith(".demo"):
        # Single file: detailed view if --detail flag, otherwise summary
        detailed = "--detail" in args
        if detailed:
            print_detailed(args[0])
        else:
            for f in args:
                if f.endswith(".demo"):
                    print_summary(f)

    else:
        print(__doc__)


if __name__ == "__main__":
    main()
