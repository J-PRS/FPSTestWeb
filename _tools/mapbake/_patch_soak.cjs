const fs = require('fs');
const code = fs.readFileSync('_tools/mapbake/terrainrate.js', 'utf8');
const insert = [
  "  // BALL SOAK - drop N balls, ski for 10s, report speed percentiles.",
  "  const SOAK_N = 500, SOAK_DT = 1/60, SOAK_T = 10, SOAK_STEPS = Math.round(SOAK_T / SOAK_DT);",
  "  const soakSpeeds = []; let soakMoved = 0;",
  "  const rng2 = mulberry32(999);",
  "  for (let k = 0; k < SOAK_N; k += 1) {",
  "    let x = Math.floor(rng2() * N), z = Math.floor(rng2() * N);",
  "    let y = H[z * N + x] + 0.7;",
  "    let vx = 0, vy = 0, vz = 0, grounded = true;",
  "    for (let s = 0; s < SOAK_STEPS; s += 1) {",
  "      const gh = at(H, x, z);",
  "      if (y - 0.4 <= gh + 0.6) { grounded = true; y = gh + 0.4; vy = 0; } else { grounded = false; }",
  "      if (grounded) {",
  "        const gx = (at(H, x + 1, z) - at(H, x - 1, z)) / (2 * texel);",
  "        const gz = (at(H, x, z + 1) - at(H, x, z - 1)) / (2 * texel);",
  "        const glen = Math.hypot(gx, gz);",
  "        if (glen > 1e-4) {",
  "          const sinT = glen / Math.sqrt(1 + glen * glen);",
  "          const ax = -(gx / glen) * 9.81 * sinT;",
  "          const az = -(gz / glen) * 9.81 * sinT;",
  "          vx += ax * SOAK_DT; vz += az * SOAK_DT;",
  "        } else { vx *= 0.9; vz *= 0.9; }",
  "        const sp = Math.hypot(vx, vz);",
  "        if (sp > 80) { vx = vx / sp * 80; vz = vz / sp * 80; }",
  "      } else { vy -= 9.81 * SOAK_DT; }",
  "      x = (x + vx * SOAK_DT + N * texel) % (N * texel) / texel;",
  "      z = (z + vz * SOAK_DT + N * texel) % (N * texel) / texel;",
  "      if (grounded) { y = at(H, Math.round(x), Math.round(z)) + 0.4; } else { y += vy * SOAK_DT; const gh2 = at(H, Math.round(x), Math.round(z)); if (y < gh2 + 0.4) { y = gh2 + 0.4; vy = 0; grounded = true; } }",
  "    }",
  "    const sp = Math.hypot(vx, vy, vz);",
  "    soakSpeeds.push(sp);",
  "    if (sp > 5) { soakMoved += 1; }",
  "  }",
  "  soakSpeeds.sort((a, b) => a - b);",
  "  const soakPctl = (p) => soakSpeeds[Math.min(soakSpeeds.length - 1, Math.floor(soakSpeeds.length * p))];",
  "  const soakMean = soakSpeeds.reduce((a, v) => a + v, 0) / soakSpeeds.length;",
].join('\n');
const marker = '  let walk = 0, flat = 0;';
if (!code.includes(marker)) { console.error('marker not found'); process.exit(1); }
let newCode = code.replace(marker, insert + '\n' + marker);
const retMarker = 'walk: walk / (N * N), flat: flat / (N * N), km2,';
const soakRet = 'walk: walk / (N * N), flat: flat / (N * N), km2, soakP10: soakPctl(0.1), soakP25: soakPctl(0.25), soakP50: soakPctl(0.5), soakP75: soakPctl(0.75), soakP90: soakPctl(0.9), soakMean, soakMovedPct: soakMoved / SOAK_N,';
if (!newCode.includes(retMarker)) { console.error('ret marker not found'); process.exit(1); }
newCode = newCode.replace(retMarker, soakRet);
fs.writeFileSync('_tools/mapbake/terrainrate.js', newCode);
console.log('patched');
