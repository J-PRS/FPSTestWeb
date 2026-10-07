// Clip-feed boot route: /clips = the queue, /clips/<file> = deep-link that
// starts the feed on that clip (the server's OG shell points here).
// ?feed[=<file>] mirrors it for dev hosts where /clips isn't routed.
// Tests stub a partial window — location may be absent there too.
const loc = typeof window === 'undefined' ? undefined : window.location;
const seg = loc?.pathname?.match(/^\/clips(?:\/([\w.-]+))?$/) ?? null;
const q = new URLSearchParams(loc?.search ?? '');
const requested = seg?.[1] ?? (q.get('feed') || null);
export const feedMode = {
  on: seg !== null || q.has('feed'),
  // Deep-link target: a demo filename with or without the .demo suffix.
  startAt: requested ? (requested.endsWith('.demo') ? requested : `${requested}.demo`) : null,
};
