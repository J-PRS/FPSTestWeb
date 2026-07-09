import { FRAG_MESSAGE_DURATION, FRAG_MESSAGE_FADE } from '../core/config.js';

export class FragMessages {
  private scoreDiv: HTMLDivElement;

  constructor() {
    this.scoreDiv = document.createElement('div');
    this.scoreDiv.style.cssText = `
      position:absolute; top:calc(50% - 60px); left:50%; transform:translate(-50%,-100%);
      font-family:sans-serif; font-size:1rem; color:#fff;
      text-shadow:1px 1px 3px #000;
      pointer-events:none; text-align:center; white-space:pre; line-height:1.5;
      opacity:0; transition:opacity ${FRAG_MESSAGE_FADE}ms ease;
    `;
    document.body.appendChild(this.scoreDiv);
  }

  show(msg: string): void {
    this.scoreDiv.textContent = msg;
    this.scoreDiv.style.transition = 'none';
    this.scoreDiv.style.opacity = '1';
    clearTimeout((this.scoreDiv as any)._t);
    (this.scoreDiv as any)._t = setTimeout(() => {
      this.scoreDiv.style.transition = `opacity ${FRAG_MESSAGE_FADE}ms ease`;
      this.scoreDiv.style.opacity = '0';
    }, FRAG_MESSAGE_DURATION);
  }
}
