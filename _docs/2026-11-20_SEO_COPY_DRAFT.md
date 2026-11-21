# SEO copy deck — awaiting JP approval

One file holding every piece of written copy the SEO plan needs. Approve
whole blocks or line-edit; once approved each snippet gets pasted into
its target untouched. Nothing in here ships until you sign off.

Related: `2026-11-20_SEO_AUDIT.md` (findings + plan).

---

## 1. `<title>` tag — `client/index.html`

Options (keep ~60 chars; brand SERP wants the name first):

- `Anabatic — Free Browser FPS: Ski, Jetpack, Frag`  ← recommended
- `Anabatic — Free Online FPS`
- `Anabatic`  (keep as-is; weakest)

## 2. Meta description — `index.html` `<head>`

```html
<meta name="description" content="Anabatic is a free multiplayer arena FPS that runs in your browser. Ski down slopes, jetpack up, and frag with a spinfusor — no download, no account. Play now." />
```

(154 chars.)

## 3. Open Graph + Twitter — `index.html` `<head>`

```html
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Anabatic" />
<meta property="og:title" content="Anabatic — Free Browser FPS" />
<meta property="og:description" content="Ski, jetpack, frag. A free multiplayer arena FPS in a browser tab — no download, no account." />
<meta property="og:url" content="https://anabatic.gg/" />
<meta property="og:image" content="https://anabatic.gg/og.png" />
<meta name="twitter:card" content="summary_large_image" />
```

`og.png` = 1200×630 gameplay frame, still to be captured.

## 4. JSON-LD VideoGame schema — `index.html` `<head>`

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "VideoGame",
  "name": "Anabatic",
  "url": "https://anabatic.gg/",
  "description": "Free multiplayer arena FPS playable in a browser. Skiing, jetpacks and explosive projectile combat.",
  "genre": ["First-person shooter", "Arena shooter"],
  "playMode": "MultiPlayer",
  "applicationCategory": "Game",
  "operatingSystem": "Any",
  "gamePlatform": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }
}
</script>
```

## 5. `site.webmanifest` — `client/public/site.webmanifest`

```json
{
  "name": "Anabatic",
  "short_name": "Anabatic",
  "start_url": "/",
  "display": "fullscreen",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "/favicon.ico", "sizes": "48x48", "type": "image/x-icon" },
    { "src": "/assets/icons/icon_star.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

plus `<link rel="manifest" href="/site.webmanifest" />` in the head.

## 6. Crawl-visible body block (P1) — `index.html` `<body>`

Hidden real estate the crawler indexes and the game paints over after
boot. No player ever reads it.

```html
<main id="seo-copy">
  <h1>Anabatic — free browser FPS</h1>
  <p>
    Anabatic is a free multiplayer first-person shooter that runs entirely
    in your web browser. Build speed by skiing downhill, take to the air
    with a jetpack, and fight with explosive projectile weapons — spinfusor
    discs, mortars, grenades. No download, no install, no account: open the
    page and play.
  </p>
  <h2>How to play</h2>
  <p>
    WASD to move, mouse to aim, hold space to ski, right mouse button to
    jet. Pick a light, medium or heavy loadout and join a match — capture
    the flag, deathmatch and bot modes included.
  </p>
</main>
```

(Game swaps it off-screen at boot — display:none removal on first frame,
or it sits behind the full-viewport canvas. Decide which when approved.)

## 7. Portal listing copy (itch.io / Newgrounds)

Short blurb:

> Anabatic is a free multiplayer arena FPS that runs in your browser.
> Ski for speed, jet for height, land the disc. No download — click
> play.

Tags: `fps` `multiplayer` `arena` `tribes` `browser` `webgl` `free`
`shooter` `jetpack` `skiing`

---

## Approval

- [ ] title tag option chosen
- [ ] meta description
- [ ] OG/Twitter copy (+ og.png capture)
- [ ] JSON-LD
- [ ] webmanifest
- [ ] crawl-visible body block (P1)
- [ ] portal blurb + tags
