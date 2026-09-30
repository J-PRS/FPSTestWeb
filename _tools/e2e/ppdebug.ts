/** ppdebug.ts — probe the composer path: canvas sizes + GL pixel probe. */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=ppdebug&bots=0&postpro=on'));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await new Promise(r => setTimeout(r, 4000));
  const info = await client.page.evaluate(`(() => {
    const out = [];
    for (const c of document.querySelectorAll('canvas')) {
      const rec = { canvas: [c.width, c.height, c.clientWidth, c.clientHeight], display: c.style.display };
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        const px = new Uint8Array(4);
        gl.readPixels(Math.floor(gl.drawingBufferWidth/2), Math.floor(gl.drawingBufferHeight/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        rec.centerPx = [...px];
        rec.drawingBuf = [gl.drawingBufferWidth, gl.drawingBufferHeight];
        rec.glErr = gl.getError();
        rec.halfFloatCB = !!gl.getExtension('EXT_color_buffer_half_float') || !!gl.getExtension('EXT_color_buffer_float');
      }
      out.push(rec);
    }
    const rs = window.__test.rendererSetup;
    if (rs) {
      out.push({
        needsComposer: rs.needsComposer(),
        postpro: rs.isPostProcessingEnabled(),
        bloom: rs.isBloomEnabled(),
        passes: rs.composer.passes.map(p => p.constructor.name + ':' + p.enabled),
        bufSize: [rs.composer.inputBuffer.width, rs.composer.inputBuffer.height],
      });
      // Force a manual composer render and read back.
      try {
        const info1 = rs.renderer.info;
        info1.autoReset = false;
        info1.reset();
        rs.composer.render(0.016);
        out.push({ composerRender: { calls: info1.render.calls, tris: info1.render.triangles } });
        info1.reset();
        rs.renderer.render(window.__test.scene, window.__test.camera || rs.composer.passes[0].camera);
        out.push({ directRender: { calls: info1.render.calls, tris: info1.render.triangles } });
        info1.autoReset = true;
        out.push({ manualRender: 'ok' });
        // Read the composer's input buffer — is RenderPass drawing anything?
        const ib = rs.composer.inputBuffer;
        const px = new Float32Array(4);
        rs.renderer.readRenderTargetPixels(ib, ib.width >> 1, ib.height >> 1, 1, 1, px);
        out.push({ inputBufCenterPx: [...px], inputBufType: ib.texture.type });
        // Same-tick canvas readback — valid only inside the render's JS turn.
        const mc = [...document.querySelectorAll('canvas')].find(c => c.width === 800);
        const g2 = mc && (mc.getContext('webgl2') || mc.getContext('webgl'));
        if (g2) {
          const sp = new Uint8Array(4);
          g2.readPixels(400, 300, 1, 1, g2.RGBA, g2.UNSIGNED_BYTE, sp);
          out.push({ screenPxSameTick: [...sp] });
        }
        // Control: straight renderer.render into the same input target.
        rs.renderer.setRenderTarget(ib);
        rs.renderer.render(window.__test.scene, rs.composer.passes[0].camera);
        rs.renderer.setRenderTarget(null);
        const px2 = new Float32Array(4);
        rs.renderer.readRenderTargetPixels(ib, ib.width >> 1, ib.height >> 1, 1, 1, px2);
        out.push({ directRenderCenterPx: [...px2] });
      } catch (e) {
        out.push({ manualRender: 'threw', err: String(e && e.stack || e).slice(0, 500) });
      }
    }
    return out;
  })()`);
  console.log(JSON.stringify(info));
} finally {
  await closeClient(client);
  stack.down();
}
