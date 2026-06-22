# Browser FPS Market Reality Report

**Date:** 2026-06-22
**Context:** Market analysis for Tribes-inspired browser FPS game based on current data and competitor research

## Executive Summary

The browser FPS market is smaller than it appears, with even the most successful games having modest player counts. However, a 2-person team can sustain themselves with a successful browser FPS (as demonstrated by Narrow.one). The key is realistic expectations and efficient operations.

## Current Market Leaders

### Krunker

**Player counts (2026):**
- **Web version:** ~430 concurrent players currently, ~1,111 24-hour peak
- **Steam version:** 24-53 average concurrent players (declining from peak of 2,250 in Feb 2021)
- **Estimated DAU:** ~5,000-10,000 (based on concurrent-to-DAU ratio)
- **Steam owners:** 2-5 million (but most play web version)

**Trend:** Declining. Steam version peaked in 2021 and has been declining steadily. Web version maintains modest but stable numbers.

**Success factors:**
- First-to-market with accessible browser FPS
- Advanced movement mechanics (parkour, sliding)
- Moddable with custom maps and items
- Free-to-play with cosmetic monetization

### Narrow.one

**Player counts (2026):**
- **Steam version:** 2 concurrent players currently, peak of 21 (Sept 2025)
- **Web version:** Primary platform (Steam has minimal impact)
- **Estimated DAU:** ~1,000-3,000 (based on developer statements)

**Steam lesson:**
- Steam defeats the purpose of browser FPS (requires download/install, loses 3-second play advantage)
- Steam is not "bonus reach" - it's a different product category entirely
- Narrow.one's Steam version has negligible impact (2 players vs thousands on web)
- Browser-first approach is critical for the 3-second play value proposition

**Team structure:**
- 2 developers (Pelican Party - Jesper and Jurgen)
- Met at Netherlands Film Academy
- Previously made VR games, Nugget Royale, Splix.io

**Success level:**
- "Pay the bills" - successful enough to be their primary income
- Started as simple demo (1 map, 1 bow, no animations) 2+ years ago
- Grew through continuous updates and Poki partnership

**Infrastructure:**
- DigitalOcean servers: $4/month per server
- ~200 players per server
- Auto-scaling server management system

**Key insight:** 2-person team can sustain themselves with 1,000-3,000 DAU browser FPS.

### Shell Shockers

**Player counts (2026):**
- **DAU:** ~25,000 daily active players
- **Lifetime players:** 200+ million total unique players
- **Peak DAU:** 300,000-350,000 (school year peaks)
- **Age:** Launched 2017, nearly 8 years old

**Revenue:**
- **Annual revenue:** "Low seven figures" ($1M-$3M annually)
- **Monetization:** 80-90% ad driven, 10-20% microtransactions
- **Microtransactions:** 50/50 split between cosmetics (hats, weapon skins) and VIP status
- **VIP pricing:** $6.99/month, $14.99/3 months, $49.99/year

**Demographics:**
- **Age:** 10-15 year olds (schoolkids)
- **Platform:** 51% Windows, 39% Chromebooks, 10% mobile
- **Geography:** 47.6% US, 6.4% Canada, rest in Brazil, Spain, Netherlands, Taiwan
- **Behavior:** School-year patterns (lower in summer, higher during school year)

**Key insight:** Shell Shockers is the most successful browser FPS with 25k DAU and low 7-figure revenue, proving the market ceiling for browser FPS is much lower than traditional games but still profitable for small teams.

### Venge.io

**Player counts (2026):**
- **Monthly players:** Claims 3,000,000+ monthly players
- **Website traffic:** ~31,000 daily visitors, 188,000 daily pageviews
- **Estimated DAU:** Likely 50,000-100,000 (based on monthly claim)

**Revenue:**
- **Estimated ad revenue:** $8,580/month (from website analytics)
- **Monetization:** In-game purchases (microtransactions) with creator partner program
- **Partner program:** 25% revenue share for content creators with 1,000+ followers
- **Estimated site value:** $154,000

**Features:**
- 4 different heroes with unique weapons/abilities
- 1,000+ community-created maps
- Custom weapon loadouts, skins, emotes, sprays
- Player market for buying/selling items
- Clan system and leaderboards

**Key insight:** Venge.io claims 3M monthly players, which would make it the largest browser FPS. However, independent verification is limited. Their partner program suggests successful microtransaction monetization.

### War Brokers

**Player counts (2026):**
- **DAU:** ~3,000 daily players
- **Steam version:** 5-9 concurrent players (minimal impact)
- **Age:** Launched 2017, nearly 9 years old

**Features:**
- Large-scale maps with vehicles (APCs, tanks, helicopters)
- Multiple game modes (Team Deathmatch, Battle Royale)
- Cross-platform play (web + Steam)

**Key insight:** War Brokers has maintained a stable but modest player base (~3k DAU) for nearly 9 years, similar to Narrow.one's success level.

### Other Browser FPS

**Bullet Force:**
- No specific DAU data found
- Available on Steam and web
- Developed by Lucas Wilde
- Similar to Forward Assault Remix

**Forward Assault Remix:**
- No specific DAU data found
- From developers of Bullet Force
- Clan system and competitive gameplay
- Available on CrazyGames and other portals

**Voxiom.io:**
- No specific DAU data found
- Voxel-based FPS inspired by Minecraft, Fortnite, CS
- Building/crafting mechanics
- Battle Royale mode

## Failed Browser FPS: Polished But Unsuccessful

### Iron Vice - Browser Game Failure

**What it was:**
- Browser-based FPS game
- Failed due to technical and design issues

**Why it failed:**
- **Always online even in single player:** Devastating for browser players with poor internet
- **Technically demanding:** 40-60 FPS on i7 GTX 660, 20-30 FPS on MacBook Pro
- **Lengthy startup:** 3-5 minute load times
- **Launch bugs:** Black screens, FPS decline, connection issues
- **Rushed deployment:** Released unfinished and buggy

**Key lesson:** Technical competence matters. If the game doesn't run well on typical hardware or has long load times, players will leave immediately and never return.

**Critical note on load times:**
- Iron Vice had 3-5 minute load times (massive failure)
- Successful browser FPS (Krunker, Shell Shockers, Narrow.one) achieve <5 second load times
- The "3-second play" advantage is NOT automatic - it requires optimization
- Bundle size, procedural generation, and efficient code are required
- Many browser games fail to achieve fast load times despite being web-based

### Note on Highguard and Brink

**Important correction:** Highguard (2026) and Brink (2011) are NOT browser FPS games - they are Steam/installed games. They are included here as examples of polished games that failed, but they are not relevant to the browser FPS hypothesis testing.

**Highguard (Steam game):**
- Polished squad-based FPS
- Dead in 46 days despite 100k launch players
- Failed due to: no differentiation, poor marketing, no community building
- Not a browser game

**Brink (Steam game):**
- Parkour shooter from Bethesda
- Failed to retain players despite decent reviews
- Failed due to: lack of content, missing features, mechanics didn't gel
- Not a browser game

**Actual browser FPS failures are harder to find** - most failed browser games are likely not documented or remembered, suggesting that "fast + deep + competent" may indeed be sufficient for browser FPS success, unlike the Steam market where competition is much more brutal.

## Why Polished Games Fail

**Success is NOT inevitable even with:**
- Deep mechanics
- Polished graphics
- Solid technical execution
- Good ideas

**What actually matters:**

**1. Differentiation**
- Must stand out from competitors
- Unique selling proposition that players care about
- Not just "another FPS"

**2. Distribution**
- Need players to actually find the game
- Platform partnerships (Poki, CrazyGames) critical
- Marketing and community building

**3. Community**
- Players need a reason to stay
- Social features, progression, regular updates
- Not just "good enough" gameplay

**4. Technical accessibility**
- Must run well on typical hardware
- Fast load times (3 seconds or less)
- No connection issues for browser players

**5. Content depth**
- Enough maps, modes, and progression
- Reason for players to keep playing
- Roadmap that players believe in

**The brutal reality:**
- Highguard: Polished, solid tech, 100k launch players → dead in 46 days
- Shell Shockers: Egg FPS, 25k DAU, $1M-$3M revenue → 8 years and counting
- Difference: Shell Shockers has unique concept (eggs with guns), school-friendly, accessible

**Conclusion:** Success is not inevitable. Technical polish is the baseline, not the differentiator. You need unique gameplay, effective distribution, community building, and continuous updates. The browser FPS market is brutal - even polished games fail if they don't give players a reason to care.

## Testing the Hypothesis: "Fast + Deep + Competent = Success"

**Hypothesis:** If browser FPS games are fast to open, deep enough, and competently made, they eventually succeed.

**Evidence against this hypothesis (browser FPS specifically):**

**Iron Vice - The only documented browser FPS failure:**
- **Fast to open:** NO (3-5 minute load times)
- **Deep enough:** Unknown (failed before depth could be evaluated)
- **Competently made:** NO (rushed, buggy, technically demanding)
- **Result:** Failed

**Why it failed:**
- Not fast (3-5 minute load times)
- Not competent (always-online even in single player, demanding hardware, launch bugs)
- Cannot test hypothesis because it failed the baseline requirements

**Evidence supporting the hypothesis:**

**Shell Shockers:**
- **Fast to open:** Yes (<5 seconds)
- **Deep enough:** Yes (multiple modes, progression, VIP system)
- **Competently made:** Yes (8 years running, 25k DAU)
- **Result:** Success ($1M-$3M annual revenue)

**Narrow.one:**
- **Fast to open:** Yes (browser-based)
- **Deep enough:** Yes (progression, shop, multiple maps)
- **Competently made:** Yes (2-person team sustains themselves)
- **Result:** Success (1,000-3,000 DAU)

**Krunker:**
- **Fast to open:** Yes (browser-based)
- **Deep enough:** Yes (custom maps, mods, progression)
- **Competently made:** Yes (market leader)
- **Result:** Success (5,000-10,000 DAU)

**Venge.io:**
- **Fast to open:** Yes (browser-based)
- **Deep enough:** Yes (4 heroes, 1,000+ maps, progression)
- **Competently made:** Yes (claims 3M monthly players)
- **Result:** Success (estimated 50k-100k DAU)

**War Brokers:**
- **Fast to open:** Yes (browser-based)
- **Deep enough:** Yes (vehicles, multiple modes)
- **Competently made:** Yes (9 years running, 3k DAU)
- **Result:** Success (sustainable niche)

**What the data actually shows:**

**For browser FPS specifically, the hypothesis appears TRUE:**
- Every documented successful browser FPS is fast, deep, and competent
- The only documented browser FPS failure (Iron Vice) failed because it was NOT fast and NOT competent
- No documented cases of fast + deep + competent browser FPS that failed

**Why browser FPS may be different from Steam games:**
- **High barriers to entry:** Multiplayer networking, lag compensation, real-time synchronization are technically difficult
- **Natural selection:** The technical difficulty means few teams can actually build a competent browser FPS
- **By definition appealing:** If you manage to overcome the technical barriers and make a fast, deep, competent browser FPS, it's almost guaranteed to be appealing because so few can do it
- **Accessibility advantage:** No download required
- **Platform distribution:** Poki, CrazyGames provides built-in audience
- **School-friendly nature:** Creates captive audience

**What actually determines success for browser FPS:**

**1. Fast load times (critical baseline)**
- Must be <5 seconds to load
- Iron Vice failed with 3-5 minute load times
- Successful games all achieve <5 seconds

**2. Technical competence (critical baseline)**
- Must run well on typical hardware (Chromebooks, school computers)
- Iron Vice failed by being too demanding
- Successful games run on 39% Chromebook users (Shell Shockers)

**3. Depth/Content (critical baseline)**
- Enough maps, modes, progression to retain players
- Successful games all have meaningful progression systems

**4. Differentiation (competitive advantage)**
- Shell Shockers: Eggs with guns
- Krunker: Advanced movement (at launch)
- Tribes-inspired: Skiing + jetpacks (doesn't exist in ANY browser game)
- **Demo system:** Auto demo recording + public library (doesn't exist in ANY browser game)
- **Unique combination:** No browser game has EITHER Tribes-style movement OR efficient demo recording + public library
- **Double differentiation:** Two completely unique features that don't exist separately in any browser game

**5. Distribution (competitive advantage)**
- Poki partnership (Narrow.one)
- Multiple platforms (Shell Shockers)
- Direct hosting (Krunker, Venge.io)

**Conclusion:** For browser FPS specifically, the hypothesis appears TRUE. Fast + Deep + Competent seems to be sufficient for success, as evidenced by:
- All successful browser FPS having these qualities
- No documented counterexamples of fast + deep + competent browser FPS that failed
- The only documented failure (Iron Vice) failed because it lacked these baseline qualities

**Tribes-inspired concept advantages:**
- Baseline requirements met (fast, deep, competent) → likely success
- Unique Tribes gameplay (skiing + jetpacks) → doesn't exist in browser FPS
- Demo system (auto recording + public library) → multiplier on virality and content creation
- **Unique combination:** No browser FPS has both movement differentiation AND demo system
- This combination compounds the success probability beyond the baseline

This is different from the Steam market where competition is much more brutal and polished games like Highguard can still fail. The browser FPS market has high technical barriers to entry, and if you overcome them with unique gameplay and viral features, success appears highly likely.

## Revenue Reality

### Web Game ARPU (AppLixir Benchmarks)

**Average Revenue Per User (ARPU):**
- Range: $0.20 - $0.60 per month
- Genre-specific ARPU:
  - Idle/Tycoon: $0.06
  - Trivia/Quiz: $0.15
  - Card/Strategy: $0.20
  - Real-Money Skill: $0.45
  - Action/Arcade: $0.08
  - Puzzle/Match-3: $0.05

**Rewarded Video CPM:**
- Tier 1 (US, CA, UK, AU): $12-30
- Tier 2 (Western EU, Nordics): $6-15
- Tier 3 (Eastern EU, LATAM, Asia): $2-6

**Most indie web games earn under $2 CPM** with banners. Rewarded video generates 3-10× higher CPM ($6-20+).

### Platform Revenue Share

**Poki model:**
- 50/50 revenue split (typical)
- Platform provides: distribution, hosting, ad optimization
- Developer provides: game, updates, community management

**Example calculation:**
- 1,000 DAU × $0.30 ARPU = $300/month gross
- Poki share (50%): $150/month
- Developer share: $150/month

## Realistic Success Scenarios

### Conservative (1,000 DAU - Narrow.one level)
- **Gross revenue:** 1,000 × $0.20 = $200/month
- **Poki share (50%):** $100/month
- **Server costs:** $5-20/month
- **Profit:** $80-95/month
- **Status:** Pocket money, not full-time income

### Moderate (3,000 DAU - Successful indie)
- **Gross revenue:** 3,000 × $0.30 = $900/month
- **Poki share (50%):** $450/month
- **Server costs:** $10-30/month
- **Profit:** $420-440/month
- **Status:** Supplemental income, could cover some bills

### Good (5,000 DAU - Krunker web level)
- **Gross revenue:** 5,000 × $0.30 = $1,500/month
- **Poki share (50%):** $750/month
- **Server costs:** $15-50/month
- **Profit:** $700-735/month
- **Status:** Meaningful side income, still not full-time

### Excellent (10,000 DAU - Top-tier indie)
- **Gross revenue:** 10,000 × $0.40 = $4,000/month
- **Poki share (50%):** $2,000/month
- **Server costs:** $20-100/month
- **Profit:** $1,900-1,980/month
- **Status:** Could be full-time income in low-cost regions

### Exceptional (100,000 DAU - Poki top-tier)
- **Gross revenue:** 100,000 × $0.40 = $40,000/month
- **Poki share (50%):** $20,000/month
- **Server costs:** $100-500/month
- **Profit:** $19,500-19,900/month
- **Status:** Very profitable, but extremely rare (only top 1% of Poki games)

## Comparison with SaaS

### SaaS Economics

**Typical SaaS ARPU:**
- $20-100+ per month per user
- 500 users × $20/month = $10,000/month
- 500 users × $50/month = $25,000/month

**Server costs:**
- $5-50/month for 500 users
- Much lower per-user cost than multiplayer games

**Comparison:**
- SaaS needs 500 users for $10,000-25,000/month
- Web game needs 25,000-125,000 users for same revenue
- **Web game needs 50-250x more users to match SaaS revenue**

### Why SaaS is Better for Most Developers

**Lower success threshold:**
- 500 users = viable SaaS business
- 10,000+ users = viable web game business

**Higher revenue per user:**
- SaaS: $20-100/month per user
- Web game: $0.20-0.60/month per user

**Lower operational complexity:**
- SaaS: Simple CRUD, no real-time networking
- Web game: Complex multiplayer, lag compensation, server management

**More predictable:**
- SaaS: Subscription revenue, predictable churn
- Web game: Ad revenue, dependent on platform algorithms

## Success Stories

### Tribes Ascend (2012)

**Launch success:**
- 800,000+ registered users within weeks
- 1.2 million downloads in first month
- 110,000 players from friend referrals alone
- Critical acclaim: "Most exciting FPS in years"

**Why it declined:**
- Hi-Rez abandoned the game to focus on SMITE
- Lack of continued updates and support
- Monetization became too aggressive over time
- Not due to gameplay (movement was praised)

**Lesson:** Even great gameplay needs ongoing support and platform commitment.

### Poki Top Earners

**Top performers:**
- Up to €1 million (~$1.1M USD) annually
- Tenfold increase over 5 years (from $50k to $1M)
- Example: Emolingo Games (Turkish studio) grew from 2 to 5 employees

**Success case study:**
- Emolingo Games: Rainbow Obby exceeded 100 million plays
- Studio averages 800,000 daily plays across 8 titles
- Each game takes 3 months from concept to release

**Reality:** Top 1% only. Most Poki games earn minimal revenue.

### Narrow.one

**Success story:**
- 2-person team sustains themselves
- Started as simple demo, grew over 2 years
- Poki partnership crucial for distribution
- Continuous updates and community engagement

**Key lesson:** Sustainable success is possible with realistic expectations and continuous improvement.

## Market Saturation

### Browser FPS Competition

**Existing players:**
- Krunker (established, declining but still dominant)
- Narrow.one (successful but smaller)
- Dozens of CS/Valorant clones (most unsuccessful)
- Bullet Force, War Brokers, and others (minimal impact)

**Differentiation opportunities:**
- **Movement mechanics:** No browser game has skiing/jetpacks (Tribes-style)
- **Demo system:** No browser game has auto demo recording + public library
- **Procedural generation:** Most use hand-crafted maps
- **Technical moat:** Multiplayer complexity creates barrier to AI competition

### Why Most Browser FPS Fail

**Common failure modes:**
- CS/Valorant clones with no differentiation
- Poor networking feel (no lag compensation)
- High bundle size (slow load times)
- No unique selling proposition
- Abandoned after initial launch

**Success factors:**
- Unique gameplay (Krunker: movement, Narrow.one: bow combat)
- LAN-like feel despite latency
- Fast load times (3 seconds or less)
- Continuous updates
- Platform partnership (Poki)

## Geographic Distribution

**Tier 1 markets (highest CPM):**
- United States, Canada, United Kingdom, Australia
- Rewarded video CPM: $12-30
- Best monetization but most competitive

**Tier 2 markets (moderate CPM):**
- Western Europe, Nordics
- Rewarded video CPM: $6-15
- Good balance of monetization and competition

**Tier 3 markets (low CPM):**
- Eastern Europe, Latin America, Asia
- Rewarded video CPM: $2-6
- Lower monetization but less competition

**Strategy:** Focus on Tier 1 for revenue, Tier 2/3 for player base growth.

## Platform Analysis

### Poki

**Advantages:**
- 100 million monthly players
- 1 billion plays per month
- Built-in monetization (ad optimization)
- Quality curation (only ~1,000 games)
- Developer support and resources

**Disadvantages:**
- 50/50 revenue split
- Curation process (not all games accepted)
- Platform dependency
- Limited control over monetization

**Verdict:** Best platform for browser FPS due to scale and player base.

### itch.io

**Advantages:**
- Easy to publish
- Community engagement
- Developer-friendly

**Disadvantages:**
- Lower monetization (optional payments)
- Smaller player base
- Not optimized for casual web games

**Verdict:** Good for community building, not primary revenue source.

### Self-hosted

**Advantages:**
- Full control of monetization
- No platform fees
- Direct player relationship

**Disadvantages:**
- Must handle marketing and user acquisition
- Higher technical burden
- No built-in distribution

**Verdict:** Only viable after establishing audience on platform.

## Technical Moat Against AI

### Why Browser FPS Has AI Resistance

**Complex networking:**
- Client-side prediction
- Server reconciliation
- Lag compensation
- Real-time synchronization

**Game physics:**
- Skiing mechanics (momentum, slope detection)
- Jetpack energy management
- Projectile physics with leading shots
- Collision detection

**Performance optimization:**
- 60+ FPS rendering
- Efficient bandwidth usage
- LOD systems
- Procedural generation

**Business complexity:**
- Server cost optimization
- CPM optimization
- Player retention strategies
- Monetization balance

### AI Can Easily Do

- CRUD applications
- Static websites
- Single-player games
- Turn-based games
- Content management systems

### AI Struggles With

- Real-time multiplayer systems
- Complex distributed architectures
- Performance-critical applications
- Systems requiring "feel" or subtle tuning
- Business judgment for tradeoffs

**Verdict:** Browser FPS has genuine AI-resistant moat, but this doesn't guarantee success.

## Time to Revenue

### Development Timeline

**Phase 1: Prototype (1-2 months)**
- Basic movement and combat
- Single-player testing
- No multiplayer yet

**Phase 2: Multiplayer MVP (2-3 months)**
- Networking implementation
- One map, one game mode
- Basic matchmaking

**Phase 3: Polish (1-2 months)**
- Performance optimization
- UI/UX improvements
- Platform submission

**Phase 4: Launch (ongoing)**
- Marketing and community building
- Regular updates
- Monetization optimization

**Total: 4-7 months to launch**

### Time to Profitability

**Conservative estimate:**
- 6-12 months to reach 1,000 DAU
- 12-24 months to reach 5,000 DAU
- 24+ months to reach 10,000+ DAU

**Narrow.one example:**
- 2+ years to reach sustainable level
- Started as demo, grew through updates
- Poki partnership accelerated growth

## Risk Assessment

### Technical Risks

**High:**
- Networking bugs and synchronization issues
- Performance problems on low-end devices
- Security vulnerabilities in multiplayer code

**Mitigation:**
- Extensive testing with real network conditions
- Performance profiling across devices
- Security audits before launch

### Market Risks

**High:**
- Difficulty acquiring initial players
- Player retention challenges
- Competition from established games
- Platform dependency (Poki algorithm changes)

**Mitigation:**
- Focus on one distribution channel initially (Poki)
- Implement retention features (daily rewards, progression)
- Differentiate through gameplay or art style
- Build community early (Discord, social media)

### Financial Risks

**Medium:**
- Development time investment without guaranteed return
- Server costs scaling with players
- Opportunity cost vs other projects

**Mitigation:**
- Treat as passion project with income potential
- Use serverless architecture to minimize costs
- Set clear time/effort limits
- Have backup income source

## Recommendations

### For Pursuing Browser FPS

**Do it if:**
- You have networking/multiplayer experience
- You enjoy game development and game design
- You're willing to invest 6-12 months without guaranteed return
- You have marketing skills or connections in gaming community
- You treat it as a passion project with income potential

**Approach:**
- Start with MVP focusing on one core mechanic
- Use serverless/P2P to minimize costs
- Target one distribution channel (Poki) initially
- Build community early (Discord, social media)
- Plan for regular updates and iteration

### For Pursuing SaaS (BellRack Alternative)

**Do it if:**
- You want more predictable income
- You have domain expertise in the niche
- You prefer lower risk and faster time to revenue
- You want to build sustainable recurring revenue
- You enjoy solving specific user problems

**Approach:**
- Focus on niche audience with clear pain points
- Implement subscription pricing ($10-$20/month)
- Use targeted marketing (content, community)
- Iterate based on user feedback
- Scale gradually with customer base

## Conclusion

The browser FPS market is smaller than it appears, with even the most successful games having modest player counts (1,000-10,000 DAU). However, a 2-person team can sustain themselves with a successful browser FPS, as demonstrated by Narrow.one.

**Key realities:**
- Krunker (market leader): ~5,000-10,000 DAU
- Narrow.one (successful indie): ~1,000-3,000 DAU
- Web game ARPU: $0.20-0.60/month
- SaaS ARPU: $20-100/month
- Web game needs 50-250x more users to match SaaS revenue

**The Tribes-inspired opportunity:**
- Genuine differentiation (skiing/jetpacks don't exist in browser FPS)
- Technical moat against AI competition
- Proven mass appeal (Tribes Ascend had 800k+ users)
- But still faces the same market size limitations

**Strategic recommendation:**
- Pursue browser FPS as a high-upside passion project
- Expect 1-3 years to reach sustainable income
- Keep expectations realistic (1,000-5,000 DAU is success)
- Consider SaaS (BellRack) for more predictable income
- The technical moat is real, but the market ceiling is low
