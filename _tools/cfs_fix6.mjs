import fs from 'fs';

function ed(f, from, to) {
  let s = fs.readFileSync(f, 'utf8');
  for (const v of [from, from.replace(/\n/g, '\r\n'), from.replace(/\n/g, '\r\r\n')]) {
    if (s.includes(v)) {
      const nl = v.includes('\r\r\n') ? '\r\r\n' : v.includes('\r\n') ? '\r\n' : '\n';
      fs.writeFileSync(f, s.replace(v, to.replace(/\n/g, nl)));
      console.log('ok', f);
      return;
    }
  }
  console.log('MISS', f);
}

// ---- wire.test.ts: hoist enc, rec, roster, base to module scope (before first describe)
const wt = 'client/src/__tests__/wire.test.ts';
const wtBlocks = [];
ed(wt, `  const enc = (pos: { x: number; y: number; z: number }): Uint8Array<ArrayBufferLike> =>
    encodePosition(pos, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);
`, '');
wtBlocks.push(`const enc = (pos: { x: number; y: number; z: number }): Uint8Array<ArrayBufferLike> =>
  encodePosition(pos, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);`);
ed(wt, `  const rec = (id: string, over: Partial<Parameters<typeof encodeTickPlayer>[0]> = {}): Uint8Array<ArrayBufferLike> =>
    encodeTickPlayer(Object.assign({playerId: id,position: { x: 1, y: 2, z: 3 },rotation: { yaw: 0.5, pitch: -0.5 },velocity: { x: 4, y: 5, z: 6 },health: 300,isDead: false,ping: 55,ski: 1}, over));
`, '');
wtBlocks.push(`const rec = (id: string, over: Partial<Parameters<typeof encodeTickPlayer>[0]> = {}): Uint8Array<ArrayBufferLike> =>
  encodeTickPlayer(Object.assign({playerId: id,position: { x: 1, y: 2, z: 3 },rotation: { yaw: 0.5, pitch: -0.5 },velocity: { x: 4, y: 5, z: 6 },health: 300,isDead: false,ping: 55,ski: 1}, over));`);
ed(wt, `  const roster = (): WireIdRoster => {
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven', 9: 'player_nine' } });
    return r;
  };
`, '');
wtBlocks.push(`const roster = (): WireIdRoster => {
  const r = new WireIdRoster();
  r.feed({ type: 'wireIds', add: { 7: 'player_seven', 9: 'player_nine' } });
  return r;
};`);
ed(wt, `  const base = (): WireTickPlayer => ({
    playerId: '', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0.5, pitch: 0.1 },
    velocity: { x: 10, y: 0, z: 5 }, health: 100, isDead: false, ski: 1, jet: 0, status: 0, sheep: 40, ping: 50,
  });
`, '');
wtBlocks.push(`const base = (): WireTickPlayer => ({
  playerId: '', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0.5, pitch: 0.1 },
  velocity: { x: 10, y: 0, z: 5 }, health: 100, isDead: false, ski: 1, jet: 0, status: 0, sheep: 40, ping: 50,
});`);
ed(wt, `describe('position frame round-trip', (): void => {`,
  wtBlocks.join('\n\n') + `\n\ndescribe('position frame round-trip', (): void => {`);

// ---- wsReconnect: conn -> module scope
const wr = 'client/src/__tests__/wsReconnect.test.ts';
ed(wr, `  const conn = (interval = 1000): WebSocketConnection =>
    new WebSocketConnection({ url: 'ws://x', reconnectInterval: interval });
`, '');
ed(wr, `describe('WebSocketConnection reconnect contract', (): void => {`,
  `const conn = (interval = 1000): WebSocketConnection =>
  new WebSocketConnection({ url: 'ws://x', reconnectInterval: interval });

describe('WebSocketConnection reconnect contract', (): void => {`);

// ---- vmBaked: yieldFrame -> module scope
const vb = 'client/src/entities/vmBaked.ts';
ed(vb, `    const yieldFrame = (): Promise<void> => new Promise<void>((r): NodeJS.Timeout => setTimeout(r, 0));
`, '');
ed(vb, `export class VmBaked {`,
  `const yieldFrame = (): Promise<void> => new Promise<void>((r): NodeJS.Timeout => setTimeout(r, 0));

export class VmBaked {`);

// ---- CoolShotsPanel: bind -> module scope
const cs = 'client/src/ui/CoolShotsPanel.ts';
ed(cs, `    const bind = (id: string, get: () => boolean, set: (on: boolean) => void): void => {
      const btn = document.getElementById(id);
      if (!btn) {return;}
      const sync = (): boolean => btn.classList.toggle('on', get());
      btn.addEventListener('click', (): void => { set(!get()); sync(); });
      sync();
    };
`, '');
ed(cs, `export class CoolShotsPanel {`,
  `const bind = (id: string, get: () => boolean, set: (on: boolean) => void): void => {
  const btn = document.getElementById(id);
  if (!btn) {return;}
  const sync = (): boolean => btn.classList.toggle('on', get());
  btn.addEventListener('click', (): void => { set(!get()); sync(); });
  sync();
};

export class CoolShotsPanel {`);

// ---- posedump: finish -> module scope (before the loader call)
const pd = 'client/src/posedump.ts';
const finishBlock = `  const finish = (): void => {
    // Frame the posed model — bounds AFTER the pose is applied so death/jump
    // clips don't get cropped.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    // Fit the bounding *diagonal* inside the 45° fov with margin — diagonal
    // guarantees the widest clip arc stays in frame.
    const d = (size / 2) / Math.tan(camera.fov * Math.PI / 360) * 1.12;
    camera.position.set(c.x + d * 0.55, c.y + size * 0.14, c.z + d);
    camera.lookAt(c);

    renderer.setAnimationLoop((): void => renderer.render(scene, camera));
    renderer.render(scene, camera);
    window.__ready = true;
  };
`;
ed(pd, finishBlock, '');
ed(pd, `mkGltfLoader().load(url, (gltf): void => {`,
  `const finish = (): void => {
  // Frame the posed model — bounds AFTER the pose is applied so death/jump
  // clips don't get cropped.
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  // Fit the bounding *diagonal* inside the 45° fov with margin — diagonal
  // guarantees the widest clip arc stays in frame.
  const d = (size / 2) / Math.tan(camera.fov * Math.PI / 360) * 1.12;
  camera.position.set(c.x + d * 0.55, c.y + size * 0.14, c.z + d);
  camera.lookAt(c);

  renderer.setAnimationLoop((): void => renderer.render(scene, camera));
  renderer.render(scene, camera);
  window.__ready = true;
};

mkGltfLoader().load(url, (gltf): void => {`);
