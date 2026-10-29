// useProgram probe — hook the GL call before three boots; on the first
// invalid-program call, capture a stack trace to name the caller.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=uprb&map=bastion&bots=0&net=ws'),
    { preload: `(() => {
      const orig = WebGL2RenderingContext.prototype.useProgram;
      let reported = 0;
      WebGL2RenderingContext.prototype.useProgram = function (p) {
        // A deleted program is non-null but isProgram() lies — catch it.
        if (p && !this.isProgram(p) && reported++ < 3) {
          console.log('USEPROG_STALE', new Error('x').stack);
        }
        if (!p && reported++ < 3) { console.log('USEPROG_NULL', new Error('x').stack); }
        return orig.call(this, p);
      };
      window.__useprog = true; })()` });
  await c.waitFor('window.__test && window.__test.networkManager', 90000);
  await new Promise(r => setTimeout(r, 20000));
  await closeClient(c);
} finally { await stack.down(); }
