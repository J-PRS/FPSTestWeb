# School content filters — what actually blocks KRIBES

Reference for "will school Chromebooks block us?" — researched 2026-10-12
against GoGuardian, Securly, and the io-game proxy literature. The
question that started it: does the word "kill(s)" in the page get a
game filtered?

## TL;DR

Filters block the **domain and the category**, not the vocabulary. A
full-screen WebGL canvas + FPS HUD is categorized "Games" by AI page
analysis no matter what the DOM strings say. "Kill" is not a trigger —
if it were, Wikipedia and news sites would nuke. Renaming visible
strings is cheap insurance against *naive keyword rules* but won't beat
the real gate.

## How the big filters actually decide

**GoGuardian**
- Smart Alerts analyze "content and context across a page" with AI —
  categories: Explicit / Proxy / **Games**. Actions include page block
  (`blocked.goguardian.com/x3`) and admin notification.
- URL rules are wildcard-based on domains/hosts/paths (`*unblocked*games*`
  is a stock recommendation for blocking io-game mirrors). GoGuardian
  itself warns against short keywords like `*games*` — they false-positive
  on educational sites, so admins avoid broad content keywords.
- Keyword rules match the URL, not page text.

**Securly Filter**
- Keyword scanning is applied to *searches* (Google, Bing, YouTube,
  Wikipedia) — it flags queries, not pages.
- **PageScan** does real-time LLM analysis of page text, metadata,
  images, and structure for *unknown* sites, then files them into
  categories (adult, gambling, social media, proxies, games…).
  Focus is adult content first; a game page gets caught under the games
  category, not under "violence vocabulary."
- Block decisions then apply per-category policy.

**Lightspeed/iboss** — same shape: category databases + on-the-fly
page classification + admin keyword overrides. Keyword overrides are
school-configured and usually target proxy/self-harm/adult terms, not
"kill."

## Why "kill" specifically is safe

- No documented case of a game being filtered for the word in its DOM.
- "Kill" appears on an enormous fraction of the web (news, sports,
  gaming journalism, Wikipedia). Any keyword rule that blocked it would
  be unadminable — this is exactly the false-positive problem GoGuardian
  warns admins about.
- Krunker.io — the game we're explicitly benchmarking against — says
  "KILLS" in its UI and is blocked by *domain*, not content. The io
  ecosystem's actual countermeasure is rotating proxy domains
  (browserfps.com, 30+ Shellshockers mirrors), never word swaps.

## What does and doesn't matter

| Thing | Matters? |
|---|---|
| "KILLS"/"fragged" in HUD/DOM text | Marginally — only against a hand-rolled `*kill*` content rule, which is rare and breaks the web. Cheap to hedge anyway. |
| Domain categorized "games" | **The real gate.** Decided by database history + AI page scan. |
| URL keywords (`unblocked`, `games`, `io`) in domain/path | Yes — wildcard rules match these. Our `/s/<room>` path is clean already. |
| Page `<title>` + meta description | Yes — PageScan reads metadata for categorization. |
| Game canvas + HUD visible | Yes — AI categorization doesn't need text. |
| HTTPS | Irrelevant to this question — filters run on the managed device/extension, so TLS doesn't hide page content from them. |

## Recommendations for KRIBES

1. **Do the string pass anyway** — it's cheap and strictly nonnegative.
   User-visible `KILLS`/`KILL` → `ELIMS`/`FRAGGED` in the kill feed,
   scoreboard, death/frag messages. Code identifiers stay as-is.
   ("Frag" contains no problematic substring — `fragged` = f-r-a-g-g-e-d.)
2. **Keep metadata bland.** `<title>` and meta description should read
   as generic as honest ("KRIBES — browser arena shooter" is fine; don't
   stuff kill/death vocabulary into head tags).
3. **If blocking becomes a real problem, the io-game answer is a second
   alias domain**, not softer words. A clean alternate host serving the
   same app is what Krunker/Shellshockers actually do.
4. **Don't contort game vocabulary for filters.** "Fragged" is already
   standard; chasing a hypothetical keyword block further than that is
   theater.

## Case study: how Shell Shockers actually stayed unblocked

Blue Wizard Digital's playbook — the most successful school-evasion
strategy in the genre, official and sustained for years:

1. **Rotating developer-operated mirror domains.** 40+ alternate URLs
   (`algebra.best`, `geometry.report`, `mathlete.pro`, `biologyclass.club`,
   `mathdrills.info`, `humanorganising.org`, `egghead.institute`,
   `deathegg.life`, `scrambled.best`, `yolk.life`…) — all pointing at the
   *same* game backend and accounts. When a school adds one to its deny
   list, players just take the next. This is a burn-rate game: mirrors
   get burned continuously, new ones rotate in continuously.

2. **The domain names are the trick — not page content.** Mirrors are
   themed to look *educational*: `math-`, `geometry-`, `algebra-`,
   `biology-`, `mathlete`, `mathdrills`, plus benign TLDs (.club, .pro,
   .vip, .best, .monster, .report, .institute). This defeats URL keyword
   rules (`*game*`, `*unblocked*` never appear) AND, more importantly,
   gives a fresh domain no "games" categorization history — a filter
   scanning an *unknown* educational-looking URL may allow it at first
   pass or even file it as educational until someone reports it.

3. **Owned distribution for new mirrors.** Burned domains are useless if
   players can't find replacements. Blue Wizard publishes alternates via
   The New Yolker newsletter, Discord, Twitter, and a dedicated
   `/unblocked` page on the main domain listing current proxies.

4. **Third-party portals as free cover.** crazygames, ioground,
   classroom6x, and similar portals host the game — the *portal's* domain
   is often allowed even when the game's isn't, because portals are
   categorized (or already blocked/allowed) independently.

5. **No vocabulary games.** They never softened in-game text to dodge
   filters — the whole strategy is infrastructure, not word choice.
   Confirms the main finding: the gate is the domain's category, and the
   countermeasure is having more domains.

**Applied to KRIBES:** if school availability ever matters, the pattern
is — same app, additional bland/educational-sounding domains serving the
static client (WS endpoint can stay on the game domain or share the
mirror's origin; the static host is the cheap part), plus a player-facing
channel that lists current mirrors. Cheap to spin up: it's a static site +
one DNS record per mirror.

## Sources

- GoGuardian Smart Alerts (AI categories: Explicit/Proxy/Games):
  https://docs.goguardian.com/products/admin/configure-smart-alert-triggers
- GoGuardian URL wildcard rules (+ their own short-keyword warning):
  https://goguardian.my.site.com/support/s/article/Best-Practices-Advanced-Filtering-Tips-1629765148235
- Securly keyword scanning (search-scope, not page-scope):
  https://support.securly.com/hc/en-us/articles/360051470053
- Securly PageScan (LLM page categorization):
  https://support.securly.com/hc/en-us/articles/28207790568343
- io-game proxy pattern (Krunker's real countermeasure):
  https://ioground.com/play/Krunker-io
- Shell Shockers official unblocked page + mirror list (Blue Wizard):
  https://bluewizard.com/shell-shockers-unblocked/
- Shell Shockers wiki: full alternate-URL history:
  https://shellshockers.fandom.com/wiki/Alternate_URLs
