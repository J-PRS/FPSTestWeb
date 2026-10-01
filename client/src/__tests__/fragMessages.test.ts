import { describe, expect, it } from 'vitest';
import { FragMessages } from '../ui/FragMessages.js';
import { feedShot } from '../ui/shotFeed.js';

// The DOM stub (setup.ts) covers createElement/appendChild — innerHTML
// stores the composed string, which is exactly what needs pinning.
const inner = (fm: FragMessages) =>
  (fm as unknown as { scoreDiv: { innerHTML: string } }).scoreDiv.innerHTML;

describe('FragMessages', () => {
  it('escapes markup in the headline and subtitle', () => {
    const fm = new FragMessages();
    fm.show('<img onerror=x> FRAGGED <b>x</b>\nwith <script>');
    const html = inner(fm);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script>'); // esc() strips < only — a bare &lt; can't reopen markup
  });

  it('first line is the headline, the rest joins with a middot', () => {
    const fm = new FragMessages();
    fm.show('YOU DIED\ncrawler\nspinfusor');
    const html = inner(fm);
    expect(html).toContain('YOU DIED');
    expect(html).toContain('crawler · spinfusor');
  });

  it('airtime tiers scale the score fonts — longer air, bigger slab', () => {
    const fm = new FragMessages();
    fm.showScore('84.2\n+8', 0.3);
    const small = inner(fm);
    fm.showScore('84.2\n+8', 2.5);
    const big = inner(fm);
    expect(big).toContain('2.2rem');
    expect(small).toContain('0.85rem');
    expect(big).not.toBe(small);
  });
});

describe('feedShot', () => {
  it('caps the stack at MAX_ENTRIES oldest-out', () => {
    for (let i = 0; i < 8; i++) feedShot(i, 1.5);
    // The feed container is the module-cached div stamped with
    // column-reverse styling — find it in the stub's creation registry.
    const all = (document as unknown as { _all: { style: { cssText?: string }; children: unknown[] }[] })._all;
    const feed = all.find((el) => el.style.cssText?.includes('column-reverse'))!;
    expect(feed).toBeDefined();
    expect(feed.children.length).toBe(5);
  });
});
