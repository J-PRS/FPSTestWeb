// Clip-feed boot route: /clips = the queue, /clips/<file> = deep-link that
// starts the feed on that clip (the server's OG shell points here).
// ?feed[=<file>] mirrors it for dev hosts where /clips isn't routed.
// Tests stub a partial window — location may be absent there too.
const loc = typeof window === 'undefined' ? undefined : window.location;
const seg = loc?.pathname?.match(/^\/clips(?:\/([\w.-]+))?$/) ?? null;
const q = new URLSearchParams(loc?.search ?? '');
const requested = seg?.[1] ?? (q.get('feed') || null);
const demoStartAt = (req: string | null): string | null => {
  if (req === null) {return null;}
  return req.endsWith('.demo') ? req : `${req}.demo`;
};
// Touch-device auto-route removed (undercooked): phones/tablets boot the
// game like everything else. The feed stays opt-in via /clips or ?feed.
export const feedMode = {
  on: (seg !== null || q.has('feed')),
  // Pinned false: exit lands on / — the game, not a ?play bounce.
  auto: false,
  // Deep-link target: a demo filename with or without the .demo suffix.
  startAt: demoStartAt(requested),
};
