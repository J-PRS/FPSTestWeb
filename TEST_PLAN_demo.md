# Test plan — demo auto-recording + cool-shot playback (HEADLESS)

GUI is unavailable (Windows session locked, no creds). Approach: puppeteer-core
+ installed Chrome `--headless=new` at http://localhost:5302 (vite dev server).

Temp hook added to main.ts (to be reverted): `window.__test = { demoManager,
player, entities, world, rendererCanvas }`.

Pointer lock doesn't exist headless → stub before page load
(evaluateOnNewDocument): mutable `__locked` flag; override
`Document.prototype.pointerLockElement` getter to return the canvas when
`__locked`; patch `Element.prototype.requestPointerLock`/`document.exitPointerLock`
to flip the flag and dispatch `pointerlockchange`. This exercises the real
Krunker-style "lock exit → menu" path including handleEscapeKey.

## Tests (all verified via page.evaluate + page.screenshot)

1. **Load + auto-recording**: `__test.demoManager.isRecording === true`,
   canvas non-blank screenshot, no console errors.
2. **Hit → auto-clip**: aim `player.yaw/pitch` at a live ball (predicted
   intercept, 15-60m so airtime>0.2s), dispatch `mousedown` (input.ts gate
   passes with fake lock). Repeat until console `[CoolShot] ... hit ball`.
   Then wait ~7s → `demoManager.getCoolShots().length >= 1`.
   Also verify DOM: `#cool-shots-top .cool-shot-item` exists (ESC overlay
   renders list).
3. **ESC menu**: dispatch Escape → fake unlock → `overlay.style.display==='flex'`,
   cool-shot item visible in DOM.
4. **Playback start (session change)**: click `.cool-shot-item` →
   `overlay.style.display==='none'`, fake-lock re-engaged, `demoManager.isPlaying===true`,
   `#demo-ui` visible (`display:flex`), `world.playbackMode===true`,
   time label advances, timeline markers present.
   Screenshots at t≈1s and t≈3s must differ (replay renders/moves).
5. **Controls**: ArrowRight→+2s; ArrowLeft→-2s; ArrowDown→restart≈0;
   Space→pause (time frozen), Space→resume. Assert via
   `demoManager.currentTime` + `isPlaying` after each keydown/keyup.
6. **ESC-stop (session change)**: Escape during playback → `isPlaying===false`,
   `#demo-ui` hidden, overlay `display:flex`, `world.playbackMode===false`,
   `isRecording===true` again (restart on stop), then "click overlay backdrop"
   (dispatch click on overlay, target===overlay) → live play (lock stub
   re-engages, overlay closes).
7. **v3 format**: check `DemoSerializer` version — serialize current recording
   clip (or a saved .demo) and confirm version field === 3; if an older fixture
   exists in repo (demo/ dir), load via `demoManager.loadDemoFile` and play.
8. **Console hygiene**: collect console errors + pageerrors; filter expected
   offline noise (ws connect fail, /demos fetch fail, audio autoplay).

Evidence dir: C:\TEMP\_WEB\headless-test\shots\*.png + console.log dump.
