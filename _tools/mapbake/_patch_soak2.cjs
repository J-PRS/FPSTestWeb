const fs = require('fs');
let c = fs.readFileSync('_tools/mapbake/terrainrate.js','utf8');
const old = "      x = (x + vx * SOAK_DT + N * texel) % (N * texel) / texel;\n      z = (z + vz * SOAK_DT + N * texel) % (N * texel) / texel;\n      if (grounded) { y = at(H, Math.round(x), Math.round(z)) + 0.4; } else { y += vy * SOAK_DT; const gh2 = at(H, Math.round(x), Math.round(z)); if (y < gh2 + 0.4) { y = gh2 + 0.4; vy = 0; grounded = true; } }";
const neu = "      const xm = (x * texel + vx * SOAK_DT + 1500) % 1500;\n      const zm = (z * texel + vz * SOAK_DT + 1500) % 1500;\n      x = xm / texel; z = zm / texel;\n      const gh2 = at(H, Math.round(x), Math.round(z));\n      if (grounded) { y = gh2 + 0.4; } else { y += vy * SOAK_DT; if (y < gh2 + 0.4) { y = gh2 + 0.4; vy = 0; grounded = true; } }";
if (!c.includes(old)) { console.error('old not found'); process.exit(1); }
c = c.replace(old, neu);
// also fix initial position: x,z in cells, y = H + 0.7 (already). gh = at(H, x, z) where x,z are cells - fine.
fs.writeFileSync('_tools/mapbake/terrainrate.js', c);
console.log('patched');