const fs = require('fs');
const buf = fs.readFileSync('maps/mirage.bin');
const w = buf.readUInt32LE(0);
const data = buf.subarray(8);
const s = JSON.parse(fs.readFileSync('maps/mirage.json','utf8'));
const hs = s.heightScale;
const tile = s.tileSize || 1500;
const texel = tile / w;
const mPerByte = 125 * hs / 255;
const H = new Float64Array(w*w);
for (let i=0;i<w*w;i++) H[i] = data[i]*mPerByte;
function at(F,x,y){ return F[((((y%w)+w)%w))*w + ((((x%w)+w)%w))]; }
let best=0, bx=0, bz=0;
for (let z=20;z<w-20;z++) for (let x=20;x<w-20;x++) {
  const gx=(at(H,x+1,z)-at(H,x-1,z))/(2*texel);
  const gz=(at(H,x,z+1)-at(H,x,z-1))/(2*texel);
  const g=Math.hypot(gx,gz);
  if (g>best){best=g;bx=x;bz=z;}
}
console.log('steepest interior cell:', bx, bz, 'grad', best.toFixed(2));
let x=bx, z=bz;
let y = H[z*w+x] + 0.7;
let vx=0,vy=0,vz=0,grounded=true;
for (let step=0;step<600;step++){
  const gh = at(H, Math.round(x), Math.round(z));
  if (y - 0.4 <= gh + 0.6) { grounded=true; y=gh+0.4; vy=0; } else { grounded=false; }
  if (grounded) {
    const xi=Math.round(x), zi=Math.round(z);
    const gx=(at(H,xi+1,zi)-at(H,xi-1,zi))/(2*texel);
    const gz=(at(H,xi,zi+1)-at(H,xi,zi-1))/(2*texel);
    const glen=Math.hypot(gx,gz);
    if (glen>1e-4) {
      const sinT=glen/Math.sqrt(1+glen*glen);
      vx += -(gx/glen)*9.81*sinT*(1/60);
      vz += -(gz/glen)*9.81*sinT*(1/60);
    } else { vx*=0.9; vz*=0.9; }
    const sp=Math.hypot(vx,vz);
    if (sp>80){vx=vx/sp*80;vz=vz/sp*80;}
  } else { vy -= 9.81/60; }
  const xm=(x*texel + vx/60 + 1500)%1500;
  const zm=(z*texel + vz/60 + 1500)%1500;
  x=xm/texel; z=zm/texel;
  const gh2=at(H, Math.round(x), Math.round(z));
  if (grounded){y=gh2+0.4;}else{y+=vy/60;if(y<gh2+0.4){y=gh2+0.4;vy=0;grounded=true;}}
}
console.log('final speed:', Math.hypot(vx,vy,vz).toFixed(1));