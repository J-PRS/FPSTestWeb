// _gunprobe.ts — solve the mannequin hand-gun mount numerically.
// Fast path: posedump's RAW clip mode (no PlayerModel, no retarget bake —
// UAL_Pistol_Shoot is a native mannequin clip) poses the skeleton at t=
// and freezes. We read DEF-handR's world quat, derive the rig's real
// facing from hand−spine (never trust the -Z comment), and compute the
// LOCAL quat that aims prop +Z down that facing with +Y up.
//
// --write patches the mannequin `mount:` entry in playerClips.ts.
import { launchClient, closeClient } from './browser.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'bun';

const vite = spawn([process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', '--port', '5456', '--strictPort'],
  { cwd: 'client', stdout: 'ignore', stderr: 'ignore' });
try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch('http://localhost:5456/')).ok) {break;} } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const client = await launchClient(
    'http://localhost:5456/posedump.html?glb=mannequin_opt&clip=UAL_Pistol_Shoot&t=0.5', {});
  // waitFor() gates on window.__test which posedump never sets — poll raw.
  await client.page.waitForFunction('window.__ready === true && !!window.__mdl', { timeout: 60000 });
  console.log('clips:', await client.page.evaluate('window.__clips'));
  const row = await client.page.evaluate(`(() => {
    const mdl = window.__mdl;
    const V = () => mdl.position.clone();
    let bone = null, shoL = null, shoR = null;
    mdl.traverse((o) => {
      const nb = (o.name || '').replace(/[^a-z]/gi, '').toLowerCase();
      if (o.isBone) {
        if (nb === 'defhandr' || nb === 'handr' || nb === 'palm2r' || nb === 'fistr') { bone = bone || o; }
        if (/defshoulderl|defupperarml|shoulderl/.test(nb)) { shoL = shoL || o; }
        if (/defshoulderr|defupperarmr|shoulderr/.test(nb)) { shoR = shoR || o; }
      }
    });
    const foot = mdl.getObjectByName('DEF-footL') || mdl.getObjectByName('DEF-footR');
    const toe = mdl.getObjectByName('DEF-toeL') || mdl.getObjectByName('DEF-toeR');
    if (!bone || !shoL || !shoR || !foot || !toe) {
      return { err: 'bones not found', bone: bone?.name, shoL: shoL?.name, shoR: shoR?.name, foot: foot?.name, toe: toe?.name };
    }
    mdl.updateMatrixWorld(true);
    const hp = V(); bone.getWorldPosition(hp);
    const pl = V(); shoL.getWorldPosition(pl);
    const pr = V(); shoR.getWorldPosition(pr);
    // Shoulder line gives the lateral axis but not the face direction —
    // foot->toe does. Facing = lateral axis, signed so it agrees with toes.
    const toes = V(); toe.getWorldPosition(toes).sub(foot.getWorldPosition(V())); toes.y = 0;
    const fwd = V().subVectors(pl, pr).cross(V().set(0, 1, 0)); fwd.y = 0;
    if (fwd.dot(toes) < 0) { fwd.negate(); }
    fwd.normalize();
    // Desired world rot: +Z_prop → fwd, +Y → up, +X → up×fwd.
    const m = mdl.matrixWorld.clone().makeBasis(
      V().set(fwd.z, 0, -fwd.x), V().set(0, 1, 0), fwd.clone());
    const want = mdl.quaternion.clone().setFromRotationMatrix(m);
    const bq = mdl.quaternion.clone(); bone.getWorldQuaternion(bq);
    const local = bq.clone().invert().multiply(want).normalize();
    const seatW = hp.clone().addScaledVector(fwd, 0.1);
    const seatL = bone.worldToLocal(seatW.clone());
    const s = V(); bone.getWorldScale(s);
    return { clip: 'UAL_Pistol_Shoot@0.5', bone: bone.name, shoL: shoL.name, shoR: shoR.name,
      facingXZ: [fwd.x, fwd.z].map((v) => +v.toFixed(3)),
      toesXZ: [toes.x, toes.z].map((v) => +v.toFixed(3)),
      quat: [local.x, local.y, local.z, local.w].map((v) => +v.toFixed(4)),
      seat: [seatL.x, seatL.y, seatL.z].map((v) => +v.toFixed(3)),
      boneWS: [s.x, s.y, s.z].map((v) => +v.toFixed(4)) };
  })()`);
  console.log(JSON.stringify(row, null, 1));

  // Visual check needs the real PlayerModel+prop — pmodel path (slower:
  // it waits on the kevdev bake). Side-on camera so barrel direction reads.
  const shot = await launchClient(
    'http://localhost:5456/posedump.html?pmodel=mannequin&state=idle&weapon=3&t=0.5', {});
  await shot.page.waitForFunction('window.__ready === true', { timeout: 120000 });
  // Solve the mount at the LIVE retargeted pose — the raw clip and the
  // baked clip pose the hand differently, so solving raw was the bug.
  const solved = await shot.page.evaluate(`(() => {
    const mdl = window.__pm.object3D;
    let bone = null;
    mdl.traverse((o) => { if (o.isBone && /defhandr|handr|palm2r|fistr/.test((o.name || '').replace(/[^a-z]/gi, '').toLowerCase())) { bone = bone || o; } });
    if (!bone) return { err: 'hand bone not found' };
    mdl.updateMatrixWorld(true);
    const V = () => new mdl.position.constructor();
    const Q = () => new mdl.quaternion.constructor();
    const face = V().set(0, 0, 1).applyQuaternion(mdl.getWorldQuaternion(Q()));
    const up = V().set(0, 1, 0);
    const right = V().crossVectors(up, face).negate(); // x = face x up
    const m = mdl.matrixWorld.clone().identity().makeBasis(V().crossVectors(face, up), up, face);
    const want = Q().setFromRotationMatrix(m);
    const bq = Q(); bone.getWorldQuaternion(bq);
    const local = bq.clone().invert().multiply(want).normalize();
    const bs = V(); bone.getWorldScale(bs);
    const seatW = V(); bone.getWorldPosition(seatW).addScaledVector(face, 0.06 * bs.x);
    const seatL = bone.worldToLocal(seatW.clone());
    return { bone: bone.name,
      quat: [local.x, local.y, local.z, local.w].map((v) => +v.toFixed(4)),
      seat: [seatL.x, seatL.y, seatL.z].map((v) => +v.toFixed(3)) };
  })()`);
  console.log('solved(live):', JSON.stringify(solved));
  // Measure the live prop: +Z of the gun group is the baked muzzle axis.
  for (let i = 0; i < 8; i += 1) {
    const live = await shot.page.evaluate(`(() => {
      const g = window.__pm.gun, mdl = window.__pm.object3D;
      if (!g) return { err: 'no gun group' };
      g.updateMatrixWorld(true);
      const fwd = g.getWorldDirection(new g.position.constructor());
      const mq = new g.quaternion.constructor(); mdl.getWorldQuaternion(mq);
      const face = new g.position.constructor(0, 0, 1).applyQuaternion(mq);
      return { barrel: [fwd.x, fwd.y, fwd.z].map((v) => +v.toFixed(3)),
        deg: +(Math.acos(Math.max(-1, Math.min(1, fwd.dot(face)))) * 180 / Math.PI).toFixed(1) };
    })()`);
    console.log('live:', JSON.stringify(live));
    await new Promise((r) => setTimeout(r, 250));
  }
  // Aim-pin check: pitch the model up — barrel must tilt up with it.
  await shot.page.evaluate('window.__pm.setRotation(0, 0.8, 0)');
  await new Promise((r) => setTimeout(r, 1000));
  const pitched = await shot.page.evaluate(`(() => {
    const g = window.__pm.gun; if (!g) return { err: 'no gun' };
    g.updateMatrixWorld(true);
    const fwd = g.getWorldDirection(new g.position.constructor());
    return { barrel: [fwd.x, fwd.y, fwd.z].map((v) => +v.toFixed(3)) };
  })()`);
  console.log('pitched(0.8 up):', JSON.stringify(pitched), '(y should be ~+0.7)');
  // Profile view: model faces authored +Z, so pure +X reads barrel vs body.
  await shot.page.evaluate(`(() => {
    const p = window.__pm.object3D.position, cam = window.__cam;
    cam.position.set(p.x + 2.4, p.y + 1.2, p.z);
    cam.lookAt(p.x, p.y + 1.0, p.z);
    return true; })()`);
  await shot.page.screenshot({ path: '_tools/e2e/shots/gunprobe-side.png' });
  console.log('shot: _tools/e2e/shots/gunprobe-side.png');
  await closeClient(shot);

  if (process.argv.includes('--write') && solved?.quat) {
    const mount = `mount: { quat: [${solved.quat.join(', ')}], pos: [${solved.seat.join(', ')}] }`;
    const path = 'client/src/entities/playerClips.ts';
    const src = readFileSync(path, 'utf8');
    const re = /(mannequin:\s*\{[\s\S]*?)mount:\s*\{[^}]*\}/;
    if (!re.test(src)) { console.log('write: no mannequin mount entry found'); }
    else {
      writeFileSync(path, src.replace(re, `$1${mount}`));
      console.log('write: mannequin mount <-', mount);
    }
  }
  await closeClient(client);
} finally { vite.kill(); }
