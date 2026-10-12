// Clip-feed boot route: /clips = the queue, /clips/<file> = deep-link that
// starts the feed on that clip (the server's OG shell points here).
// ?feed[=<file>] mirrors it for dev hosts where /clips isn't routed.
// Tests stub a partial window — location may be absent there too.
const loc = typeof window === 'undefined' ? undefined : window.location;
const seg = loc?.pathname?.match(/^\/clips(?:\/([\w.-]+))?$/) ?? null;
const q = new URLSearchParams(loc?.search ?? '');
const requested = seg?.[1] ?? (q.get('feed') || null);
// Touch-only devices can't play — the onboarding gate would bounce them —
// so phones/tablets land on the feed instead. ?play opts back into the
// game for anything with enough input (hybrids, plugged-in peripherals).
const demoStartAt = (req: string | null): string | null => {
  if (req === null) {return null;}
  return req.endsWith('.demo') ? req : `${req}.demo`;
};
const coarse = typeof window === 'undefined' ? false
  : (window.matchMedia?.('(pointer: coarse)').matches ?? false) && navigator.maxTouchPoints > 0;
export const feedMode = {
  on: (seg !== null || q.has('feed') || (coarse && !q.has('play') && !q.has('mode'))),
  // True when the route came from device detection, not a URL flag —
  // exit then lands on /?play so it doesn't loop back into the feed.
  auto: seg === null && !q.has('feed') && coarse,
  // Deep-link target: a demo filename with or without the .demo suffix.
  startAt: demoStartAt(requested),
};
