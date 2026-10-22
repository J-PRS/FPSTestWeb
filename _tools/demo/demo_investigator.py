#!/usr/bin/env python3
"""
Demo Investigator - Analyzes ER status failures in demo files.

ER status occurs when description lifetime differs by >0.5s from actual airtime.
This script investigates the root cause of these mismatches.

Usage:
    python demo_investigator.py                    # analyze all ER demos
    python demo_investigator.py <file.demo>        # analyze specific demo
    python demo_investigator.py --dir <path>       # analyze demos in custom dir
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

    projectile_lifetime = 0.0
    if format_version >= 2:
        (projectile_lifetime,) = struct.unpack_from("<f", data, offset); offset += 4

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
        "projectile_lifetime": projectile_lifetime,
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
    """Match Fired->Hit events by proj_id and verify airtime."""
    proj_events = demo["proj_events"]
    fired = {}
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
            expected_air = dist / speed if speed > 0 else 0
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


def investigate_demo(filepath):
    """Investigate a single demo file for ER status."""
    demo = parse_demo(filepath)
    h = demo["header"]
    lifetime = parse_lifetime_from_desc(h["description"])
    
    if not lifetime:
        return None, "No lifetime in description"
    
    verifications = compute_airtime_verification(demo)
    hits = [v for v in verifications if v["hit_type"] == "Hit"]
    
    if not hits:
        return None, "No Hit events found"
    
    real_air = max((v["airtime_ts"] for v in hits), default=0)
    best_hit = max(hits, key=lambda v: v["airtime_ts"], default=None)
    
    diff = abs(lifetime - real_air)
    is_er = diff >= 0.5
    
    analysis = {
        "file": os.path.basename(filepath),
        "description": h["description"],
        "lifetime_desc": lifetime,
        "lifetime_real": real_air,
        "diff": diff,
        "is_er": is_er,
        "best_hit": best_hit,
        "all_hits": hits,
        "total_hits": len(hits),
        "total_proj_events": len(demo["proj_events"]),
    }
    
    return analysis, None


def print_investigation(analysis):
    """Print detailed investigation results."""
    print(f"\n{'=' * 80}")
    print(f"INVESTIGATION: {analysis['file']}")
    print(f"{'=' * 80}")
    print(f"Description: {analysis['description']}")
    print(f"Lifetime (desc): {analysis['lifetime_desc']:.3f}s")
    print(f"Lifetime (real): {analysis['lifetime_real']:.3f}s")
    print(f"Difference: {analysis['diff']:.3f}s")
    print(f"Status: {'*** ER ***' if analysis['is_er'] else 'OK'}")
    print(f"Total Hit events: {analysis['total_hits']}")
    print(f"Total proj events: {analysis['total_proj_events']}")
    
    if analysis['best_hit']:
        bh = analysis['best_hit']
        print(f"\n--- BEST HIT (longest airtime) ---")
        print(f"  Projectile ID: {bh['proj_id']}")
        print(f"  Weapon: {bh['weapon']}")
        print(f"  Airtime: {bh['airtime_ts']:.3f}s")
        print(f"  Distance: {bh['distance']:.1f}m")
        print(f"  Speed: {bh['speed']:.1f} m/s")
        print(f"  Expected airtime (straight line): {bh['expected_air']:.3f}s")
        print(f"  Fired pos: ({bh['fired_pos'][0]:.1f}, {bh['fired_pos'][1]:.1f}, {bh['fired_pos'][2]:.1f})")
        print(f"  Hit pos: ({bh['hit_pos'][0]:.1f}, {bh['hit_pos'][1]:.1f}, {bh['hit_pos'][2]:.1f})")
        print(f"  Target ID: {bh['target_id']}")
    
    print(f"\n--- ALL HIT EVENTS (sorted by airtime) ---")
    sorted_hits = sorted(analysis['all_hits'], key=lambda v: v['airtime_ts'], reverse=True)
    for i, hit in enumerate(sorted_hits):
        print(f"  {i+1}. ID={hit['proj_id']:5d} {hit['weapon']:6s} air={hit['airtime_ts']:6.3f}s "
              f"dist={hit['distance']:7.1f}m speed={hit['speed']:5.1f} tgt={hit['target_id']}")
    
    # Analysis of why ER occurred
    if analysis['is_er']:
        print(f"\n--- ER ANALYSIS ---")
        if analysis['total_hits'] == 1:
            print("  Only 1 Hit event - description may be from different projectile")
        else:
            # Check if there are multiple hits with similar airtimes
            airtimes = [h['airtime_ts'] for h in sorted_hits]
            if len(airtimes) > 1:
                gap = airtimes[0] - airtimes[1]
                print(f"  Gap between top 2 airtimes: {gap:.3f}s")
                if gap < 0.5:
                    print("  Multiple hits with similar airtimes - ambiguous which one description refers to")
        
        # Check if description lifetime matches any hit
        matches = [h for h in sorted_hits if abs(h['airtime_ts'] - analysis['lifetime_desc']) < 0.1]
        if matches:
            print(f"  Description lifetime matches {len(matches)} hit(s) within 0.1s tolerance")
            for m in matches:
                print(f"    - ID={m['proj_id']} air={m['airtime_ts']:.3f}s")
        else:
            print(f"  Description lifetime doesn't match any hit event closely")
            closest = min(sorted_hits, key=lambda h: abs(h['airtime_ts'] - analysis['lifetime_desc']))
            print(f"  Closest match: ID={closest['proj_id']} air={closest['airtime_ts']:.3f}s (diff={abs(closest['airtime_ts'] - analysis['lifetime_desc']):.3f}s)")


def main():
    args = sys.argv[1:]

    if len(args) == 0:
        # Default: analyze all ER demos in ../server_bun/demos
        demo_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server_bun", "demos")
        demos = sorted(glob.glob(os.path.join(demo_dir, "*.demo")))
        
        er_demos = []
        for filepath in demos:
            analysis, error = investigate_demo(filepath)
            if analysis and analysis['is_er']:
                er_demos.append(analysis)
        
        print(f"Found {len(er_demos)} ER demos out of {len(demos)} total")
        
        for analysis in er_demos:
            print_investigation(analysis)
            print()

    elif args[0] == "--dir":
        if len(args) < 2:
            print("Usage: python demo_investigator.py --dir <path>")
            return
        demos = sorted(glob.glob(os.path.join(args[1], "*.demo")))
        
        er_demos = []
        for filepath in demos:
            analysis, error = investigate_demo(filepath)
            if analysis and analysis['is_er']:
                er_demos.append(analysis)
        
        print(f"Found {len(er_demos)} ER demos out of {len(demos)} total")
        
        for analysis in er_demos:
            print_investigation(analysis)
            print()

    elif args[0].endswith(".demo"):
        # Single file
        analysis, error = investigate_demo(args[0])
        if error:
            print(f"Error: {error}")
        elif analysis:
            print_investigation(analysis)
        else:
            print("No issues found")

    else:
        print(__doc__)


if __name__ == "__main__":
    main()
