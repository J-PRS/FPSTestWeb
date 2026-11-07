# Sidecar bench: Python (numba) ports of maplab/gen.ts's heavy passes,
# timed on the same 449² grid so we can compare with the JS profile dump.
# Reference JS times (449², from Alt+Q dump):
#   synthField 496ms · smooth 34.6 · stream 563 · erode 0.8 · glacier 175 · talus 304
import math
import numpy as np
from numba import njit, prange

N = 449
WORLD = 1500.0
SEED = 7

# ---------------- synth (lattice value-noise fBm + warp) ----------------

@njit(cache=True)
def lattice(ix, iz, oct_, seed):
    s = math.sin(ix * 127.1 + iz * 311.7 + oct_ * 74.7 + seed * 19.3) * 43758.5453
    return s - math.floor(s)

@njit(cache=True)
def fade(t):
    return t * t * (3 - 2 * t)

@njit(cache=True)
def noise(u, v, cells, oct_, seed):
    x = u * cells
    z = v * cells
    x0 = int(math.floor(x)) % cells
    z0 = int(math.floor(z)) % cells
    x1 = (x0 + 1) % cells
    z1 = (z0 + 1) % cells
    fx = fade(x - math.floor(x))
    fz = fade(z - math.floor(z))
    return (lattice(x0, z0, oct_, seed) * (1 - fx) * (1 - fz) +
            lattice(x1, z0, oct_, seed) * fx * (1 - fz) +
            lattice(x0, z1, oct_, seed) * (1 - fx) * fz +
            lattice(x1, z1, oct_, seed) * fx * fz)

@njit(cache=True)
def fbm_at(u, v, elong, detail, seed, OCT, AMP):
    h = 0.0
    for i in range(5):
        h += noise(u * elong, v, OCT[i], i, seed) * AMP[i]
    return h

@njit(cache=True)
def synth(N, seed, freq, detail, elong, tilt, warp, bowlR, bowlDepth, plateauR, plateauLift, seaR, seaDepth):
    OCT = np.empty(5, np.int64)
    AMP = np.empty(5, np.float64)
    for i, c in enumerate([4, 9, 20, 44, 88]):
        OCT[i] = max(1, round(c * freq))
    for i, a in enumerate([1.0, 0.62, 0.38, 0.22, 0.12]):
        AMP[i] = a * (1.0 if i == 0 else detail)
    h = np.empty(N * N, np.float32)
    for z in range(N):
        for x in range(N):
            u = x / N
            v = z / N
            wu, wv = u, v
            if warp > 0:
                e = 0.02
                cx = (noise(u + 1.7, v + 9.2 + e, 4, 11, seed) - noise(u + 1.7, v + 9.2 - e, 4, 11, seed)) / (2 * e)
                cz = -((noise(u + 1.7 + e, v + 9.2, 4, 11, seed) - noise(u + 1.7 - e, v + 9.2, 4, 11, seed)) / (2 * e))
                cl = math.hypot(cx, cz) or 1.0
                offX = noise(u + 1.7, v + 9.2, 4, 11, seed) - 0.5
                offZ = noise(u + 8.3, v + 2.8, 4, 12, seed) - 0.5
                wu = u + warp * (offX * 0.25 + (cx / cl) * 0.0)  # curl=0 → offset warp only
                wv = v + warp * (offZ * 0.25 + (cz / cl) * 0.0)
            hh = fbm_at(wu, wv, elong, detail, seed, OCT, AMP)
            hh += tilt * (u - 0.5)
            wx = (u - 0.5) * WORLD + (noise(u + 1.7, v + 9.2, 3, 7, seed) - 0.5) * 2 * 45
            wz = (v - 0.5) * WORLD + (noise(u + 5 + 1.7, v + 3 + 9.2, 3, 7, seed) - 0.5) * 2 * 45
            dx = abs(wx)
            dz = abs(wz)
            tdist = math.hypot(min(dx, WORLD - dx), min(dz, WORLD - dz))
            if bowlR > 0:
                t = max(0.0, 1 - tdist / bowlR)
                hh -= bowlDepth * t * t * (3 - 2 * t)
            if plateauR > 0:
                t = min(1.0, max(0.0, (plateauR - tdist) / 60))
                hh += plateauLift * t * t * (3 - 2 * t)
            if seaR > 0:
                t = min(1.0, max(0.0, (tdist - seaR) / 90))
                hh -= seaDepth * t
            h[z * N + x] = hh
    mn, mx = h.min(), h.max()
    h = (h - mn) / max(1e-6, mx - mn)
    return h

# ---------------- smooth (laplacian diffusion) ----------------

@njit(cache=True)
def smooth_nb(h, N, iters):
    src = np.empty_like(h)
    for _ in range(iters):
        src[:] = h
        for z in range(N):
            for x in range(N):
                i = z * N + x
                l = src[z * N + (x - 1 + N) % N]
                r = src[z * N + (x + 1) % N]
                u = src[((z - 1 + N) % N) * N + x]
                d = src[((z + 1 + N) % N) * N + x]
                h[i] = src[i] + (l + r + u + d - src[i] * 4) * 0.12

def smooth_np(h, N, iters):
    g = h.reshape(N, N)
    for _ in range(iters):
        l = np.roll(g, 1, 1); r = np.roll(g, -1, 1)
        u = np.roll(g, 1, 0); d = np.roll(g, -1, 0)
        g += (l + r + u + d - g * 4) * 0.12

# ---------------- talus (thermal, steepest of 4 neighbours) ----------------

@njit(cache=True)
def talus_nb(h, N, iters, angle):
    src = np.empty_like(h)
    DX = (1, -1, 0, 0)
    DZ = (0, 0, 1, -1)
    for _ in range(iters):
        src[:] = h
        for z in range(N):
            for x in range(N):
                i = z * N + x
                worst = 0.0
                wn = -1
                for k in range(4):
                    ni = (((z + DZ[k]) % N + N) % N) * N + (((x + DX[k]) % N + N) % N)
                    d = src[i] - src[ni]
                    if d > worst:
                        worst = d
                        wn = ni
                if worst > angle and wn >= 0:
                    move = (worst - angle) * 0.5
                    h[i] -= move
                    h[wn] += move

@njit(cache=True, parallel=True)
def smooth_par(h, N, iters):
    src = np.empty_like(h)
    for _ in range(iters):
        src[:] = h
        for z in prange(N):
            for x in range(N):
                i = z * N + x
                l = src[z * N + (x - 1 + N) % N]
                r = src[z * N + (x + 1) % N]
                u = src[((z - 1 + N) % N) * N + x]
                d = src[((z + 1 + N) % N) * N + x]
                h[i] = src[i] + (l + r + u + d - src[i] * 4) * 0.12

@njit(cache=True, parallel=True)
def synth_par(N, seed, freq, detail, elong, tilt, warp, bowlR, bowlDepth, plateauR, plateauLift, seaR, seaDepth):
    OCT = np.empty(5, np.int64)
    AMP = np.empty(5, np.float64)
    for i, c in enumerate([4, 9, 20, 44, 88]):
        OCT[i] = max(1, round(c * freq))
    for i, a in enumerate([1.0, 0.62, 0.38, 0.22, 0.12]):
        AMP[i] = a * (1.0 if i == 0 else detail)
    h = np.empty(N * N, np.float32)
    for z in prange(N):
        for x in range(N):
            u = x / N
            v = z / N
            wu, wv = u, v
            if warp > 0:
                e = 0.02
                cx = (noise(u + 1.7, v + 9.2 + e, 4, 11, seed) - noise(u + 1.7, v + 9.2 - e, 4, 11, seed)) / (2 * e)
                cz = -((noise(u + 1.7 + e, v + 9.2, 4, 11, seed) - noise(u + 1.7 - e, v + 9.2, 4, 11, seed)) / (2 * e))
                cl = math.hypot(cx, cz) or 1.0
                offX = noise(u + 1.7, v + 9.2, 4, 11, seed) - 0.5
                offZ = noise(u + 8.3, v + 2.8, 4, 12, seed) - 0.5
                wu = u + warp * (offX * 0.25 + (cx / cl) * 0.0)
                wv = v + warp * (offZ * 0.25 + (cz / cl) * 0.0)
            hh = fbm_at(wu, wv, elong, detail, seed, OCT, AMP)
            hh += tilt * (u - 0.5)
            wx = (u - 0.5) * WORLD + (noise(u + 1.7, v + 9.2, 3, 7, seed) - 0.5) * 2 * 45
            wz = (v - 0.5) * WORLD + (noise(u + 5 + 1.7, v + 3 + 9.2, 3, 7, seed) - 0.5) * 2 * 45
            dx = abs(wx)
            dz = abs(wz)
            tdist = math.hypot(min(dx, WORLD - dx), min(dz, WORLD - dz))
            if bowlR > 0:
                t = max(0.0, 1 - tdist / bowlR)
                hh -= bowlDepth * t * t * (3 - 2 * t)
            if plateauR > 0:
                t = min(1.0, max(0.0, (plateauR - tdist) / 60))
                hh += plateauLift * t * t * (3 - 2 * t)
            if seaR > 0:
                t = min(1.0, max(0.0, (tdist - seaR) / 90))
                hh -= seaDepth * t
            h[z * N + x] = hh
    mn, mx = h.min(), h.max()
    h = (h - mn) / max(1e-6, mx - mn)
    return h

# ---------------- D8 drainage + stream power ----------------

@njit(cache=True)
def priority_flood(h, N):
    f = h.copy()
    done = np.zeros(N * N, np.uint8)
    # Two-array min-heap (height, idx) — the JS version packs h*1e7+i into
    # one number which corrupts the index once a filled cell hits ≥1.0.
    CAP = N * N * 9
    heap_h = np.empty(CAP, np.float64)
    heap_i = np.empty(CAP, np.int64)
    hn = 0
    lo = 0
    for i in range(1, N * N):
        if f[i] < f[lo]:
            lo = i
    done[lo] = 1
    heap_h[0] = f[lo]
    heap_i[0] = lo
    hn = 1
    DX = (1, -1, 0, 0, 1, 1, -1, -1)
    DZ = (0, 0, 1, -1, 1, -1, 1, -1)
    while hn > 0:
        i = heap_i[0]
        ih = heap_h[0]
        hn -= 1
        heap_h[0] = heap_h[hn]
        heap_i[0] = heap_i[hn]
        i0 = 0
        while True:
            l, r = i0 * 2 + 1, i0 * 2 + 2
            s = i0
            if l < hn and heap_h[l] < heap_h[s]:
                s = l
            if r < hn and heap_h[r] < heap_h[s]:
                s = r
            if s == i0:
                break
            heap_h[s], heap_h[i0] = heap_h[i0], heap_h[s]
            heap_i[s], heap_i[i0] = heap_i[i0], heap_i[s]
            i0 = s
        ih = f[i]
        x = i % N
        z = i // N
        for k in range(8):
            nx = ((x + DX[k]) % N + N) % N
            nz = ((z + DZ[k]) % N + N) % N
            ni = nz * N + nx
            if done[ni]:
                continue
            done[ni] = 1
            if f[ni] < ih:
                f[ni] = ih + 1e-6
            # push
            heap_h[hn] = f[ni]
            heap_i[hn] = ni
            j = hn
            hn += 1
            while j > 0:
                pp = (j - 1) // 2
                if heap_h[pp] <= heap_h[j]:
                    break
                heap_h[pp], heap_h[j] = heap_h[j], heap_h[pp]
                heap_i[pp], heap_i[j] = heap_i[j], heap_i[pp]
                j = pp
    return f

@njit(cache=True)
def drainage(h, N):
    f = priority_flood(h, N)
    rec = np.full(N * N, -1, np.int64)
    acc = np.ones(N * N, np.float64)
    DX = (1, -1, 0, 0, 1, 1, -1, -1)
    DZ = (0, 0, 1, -1, 1, -1, 1, -1)
    DD = (1.0, 1.0, 1.0, 1.0, math.sqrt(2.0), math.sqrt(2.0), math.sqrt(2.0), math.sqrt(2.0))
    for z in range(N):
        for x in range(N):
            i = z * N + x
            worst = 0.0
            wn = -1
            for k in range(8):
                ni = (((z + DZ[k]) % N + N) % N) * N + (((x + DX[k]) % N + N) % N)
                d = (f[i] - f[ni]) / DD[k]
                if d > worst:
                    worst = d
                    wn = ni
            rec[i] = wn
    order = np.argsort(-f)
    for i in order:
        r = rec[i]
        if r >= 0:
            acc[r] += acc[i]
    return acc, rec

@njit(cache=True)
def stream_power(h, N, stream, iters):
    for _ in range(iters):
        acc, rec = drainage(h, N)
        src = h.copy()
        for i in range(N * N):
            r = rec[i]
            if r < 0:
                continue
            dx = (i % N) - (r % N)
            dz = (i // N) - (r // N)
            if dx > N // 2:
                dx -= N
            elif dx < -N // 2:
                dx += N
            if dz > N // 2:
                dz -= N
            elif dz < -N // 2:
                dz += N
            dist = math.hypot(dx, dz)
            slope = (src[i] - src[r]) / dist
            cut = stream * math.sqrt(acc[i]) * max(0.0, slope) * 0.02
            h[i] = max(src[r], src[i] - cut)

# ---------------- glacier (windowed min toward drainage spine) ----------------

@njit(cache=True)
def glacier_nb(h, N, g):
    acc, _ = drainage(h, N)
    acc_max = acc.max()
    src = h.copy()
    for z in range(N):
        for x in range(N):
            i = z * N + x
            t = (acc[i] / acc_max) ** 0.3
            if t < 0.08:
                continue
            w = round(2 + t * 7)
            lo = 1e30
            for dz in range(-w, w + 1):
                for dx in range(-w, w + 1):
                    v = src[(((z + dz) % N + N) % N) * N + (((x + dx) % N + N) % N)]
                    if v < lo:
                        lo = v
            h[i] = src[i] + (lo - src[i]) * g * t

# ---------------- droplet erosion ----------------

@njit(cache=True)
def erode_nb(h, N, droplets, inertia, erode_rate, deposit_rate, evap, capacity, talus_angle, seed):
    s = np.uint32(seed * 265536491 & 0xFFFFFFFF or 1)
    for _ in range(droplets):
        # mulberry32
        s = np.uint32(s + np.uint32(0x6D2B79F5))
        t = s
        t = np.uint32((t ^ (t >> np.uint32(15))) * np.uint32(t | np.uint32(1)) & 0xFFFFFFFF)
        t = np.uint32(t ^ (t + np.uint32((t ^ (t >> np.uint32(7))) * np.uint32(61) & 0xFFFFFFFF)))
        r1 = ((t ^ (t >> np.uint32(14))) & 0xFFFFFFFF) / 0x100000000
        s = np.uint32(s + np.uint32(0x6D2B79F5))
        t = s
        t = np.uint32((t ^ (t >> np.uint32(15))) * np.uint32(t | np.uint32(1)) & 0xFFFFFFFF)
        t = np.uint32(t ^ (t + np.uint32((t ^ (t >> np.uint32(7))) * np.uint32(61) & 0xFFFFFFFF)))
        r2 = ((t ^ (t >> np.uint32(14))) & 0xFFFFFFFF) / 0x100000000
        x, z = r1 * N, r2 * N
        dx = dz = 0.0
        vel, water, sed = 1.0, 1.0, 0.0
        for _step in range(60):
            def at(xx, zz):
                return h[int(math.floor(zz)) % N * N + int(math.floor(xx)) % N]
            gx = at(x + 1, z) - at(x - 1, z)
            gz = at(x, z + 1) - at(x, z - 1)
            dx = dx * inertia - gx * (1 - inertia)
            dz = dz * inertia - gz * (1 - inertia)
            dl = math.hypot(dx, dz) or 1.0
            dx /= dl
            dz /= dl
            px, pz = x, z
            x += dx
            z += dz
            if x < 0 or x >= N - 1 or z < 0 or z >= N - 1:
                break
            dh = at(px, pz) - at(x, z)
            cap = max(dh, talus_angle) * vel * water * capacity
            if sed > cap or dh > 0:
                dep = min(dh, sed) if dh > 0 else (sed - cap) * deposit_rate
                sed -= dep
                # spread
                x0, z0 = int(math.floor(px)), int(math.floor(pz))
                fx, fz = px - x0, pz - z0
                for (wx, wz, wgt) in ((0, 0, (1-fx)*(1-fz)), (1, 0, fx*(1-fz)), (0, 1, (1-fx)*fz), (1, 1, fx*fz)):
                    xi = ((x0 + wx) % N + N) % N
                    zi = ((z0 + wz) % N + N) % N
                    h[zi * N + xi] += dep * wgt
            else:
                take = min((cap - sed) * erode_rate, -dh)
                sed += take
                x0, z0 = int(math.floor(px)), int(math.floor(pz))
                fx, fz = px - x0, pz - z0
                for (wx, wz, wgt) in ((0, 0, (1-fx)*(1-fz)), (1, 0, fx*(1-fz)), (0, 1, (1-fx)*fz), (1, 1, fx*fz)):
                    xi = ((x0 + wx) % N + N) % N
                    zi = ((z0 + wz) % N + N) % N
                    h[zi * N + xi] -= take * wgt
            vel = math.sqrt(max(0.0, vel * vel + dh * 4))
            water *= 1 - evap
            if water < 0.05:
                break

# ---------------- bench ----------------

if __name__ == '__main__':
    import time

    def bench(name, fn, *args, reps=1):
        # warm up JIT once (compile excluded), then time best of reps
        fn(*args)
        best = 1e30
        for _ in range(reps):
            t = time.perf_counter()
            fn(*args)
            best = min(best, time.perf_counter() - t)
        print(f'{name:>14}: {best * 1000:8.1f} ms')
        return best

    h0 = np.random.default_rng(1).random(N * N).astype(np.float32)

    print(f'--- numba, N={N} (JS reference: synth 496 · smooth 34.6 · stream 563 · glacier 175 · talus 304 ms)')
    bench('synthField', synth, N, SEED, 1.0, 1.0, 1.0, 0.0, 0.6, 0.0, 0.4, 0.0, 0.5, 0.0, 0.5)

    h = h0.copy()
    bench('smooth x40', smooth_nb, h, N, 40)

    h = h0.copy()
    bench('talus x16', talus_nb, h, N, 16, 0.02)

    h = h0.copy()
    bench('stream x3', stream_power, h, N, 1.5, 3)

    h = h0.copy()
    bench('glacier', glacier_nb, h, N, 0.2)

    h = h0.copy()
    bench('erode 50k', erode_nb, h, N, 50_000, 0.3, 0.35, 0.3, 0.02, 4.0, 0.02, SEED)

    print('--- numba parallel (all cores)')
    bench('synth par', synth_par, N, SEED, 1.0, 1.0, 1.0, 0.0, 0.6, 0.0, 0.4, 0.0, 0.5, 0.0, 0.5)
    h = h0.copy()
    bench('smooth par x40', smooth_par, h, N, 40)

    print('--- numpy vectorized where possible')
    g = h0.reshape(N, N).copy()
    t = time.perf_counter()
    smooth_np(g.ravel(), N, 40)
    print(f'{"smooth np x40":>14}: {(time.perf_counter() - t) * 1000:8.1f} ms')

    from scipy.ndimage import minimum_filter
    g2 = h0.reshape(N, N).copy()
    t = time.perf_counter()
    minimum_filter(g2, size=19, mode='wrap')
    print(f'{"glacier w9 min":>14}: {(time.perf_counter() - t) * 1000:8.1f} ms  (scipy min-filter, the w-loop)')
