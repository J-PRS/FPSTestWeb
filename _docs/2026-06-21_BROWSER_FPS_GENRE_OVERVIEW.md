# Browser FPS Genre - Main Players, Monetization, and Technology

## Overview

Browser-based first-person shooters have evolved from simple experiments to sophisticated multiplayer experiences rivaling native games. This document analyzes the key players in the genre, their monetization strategies, success metrics, and technical approaches.

## Key Players

### 1. Krunker.io

**Status**: Post-acquisition decline, but historically significant

**Developer**: Sidney de Vries (Yendis Entertainment → acquired by FRVR for $40M in 2022)

**Player Statistics**:
- **Peak CCU**: 30,000 concurrent players
- **Current CCU**: 430 (web), 32 (Steam)
- **Total plays**: 1.5 billion
- **Unique players**: 200 million
- **Decline**: 94-98% from peak post-acquisition

**Monetization**:
- **KR Currency**: Purchasable in-game currency
- **Marketplace**: Player-to-player trading with 10% tax
- **Premium subscription**: Recurring revenue
- **Creator program**: 20% revenue share
- **Battle pass**: Seasonal content

**Technology**:
- **Engine**: Custom WebGL engine
- **Features**: Map editor, Krunkscript (scripting system), modding support
- **Platform**: Web-first, Steam (negligible), Discord (Krunker Strike)

**Key Insight**: Proves acquisition path exists but timing is critical. Sold at peak of .io hype (smart for founder, risky for acquirer).

---

### 2. Narrow One

**Status**: Sustainable indie success

**Developer**: Pelican Party Studios (Jesper van den Ende, 2-person team)

**Player Statistics**:
- **Peak DAU**: 50,000 daily active players (within 6 months of launch)
- **Current DAU**: ~25,000 (estimated)
- **Total sessions**: 500 million (cumulative 2021-2026)
- **Steam**: Negligible (1-21 concurrent players)

**Monetization**:
- **Platform partnership**: Poki (50% revenue share on referred traffic, 100% on direct)
- **Rewarded ads**: Primary revenue stream
- **Cosmetics**: Optional purchases (low conversion rate 1-2%)
- **No marketplace**: Simple shop-only model

**Technology**:
- **Engine**: Renda (custom WebGL/WebGPU engine)
- **Features**: Auto-scaling servers, custom networking
- **Platform**: Web (narrow.one, narrow-one.io mirror), Steam (negligible)

**Financials**:
- **Annual revenue**: $327K-$357K
- **Net per person**: $38K-$74K (after Netherlands taxes)
- **Profit margin**: 37-66%

**Key Insight**: Sustainable indie model through platform partnership, efficiency, and niche targeting (school-friendly).

---

### 3. Venge.io

**Status**: Active, Poki partnership

**Developer**: OnRush Studio (Cem Demir, Amsterdam-based small team)

**Player Statistics**:
- **Plays**: 660,309 (Snokido counter)
- **Platform**: Web (Poki featured partnership)

**Monetization**:
- **Platform partnership**: Poki (revenue share model)
- **Free to play**: No upfront cost
- **Skill progression**: Experience-based unlocks
- **Custom content**: Community maps/modes

**Technology**:
- **Engine**: Likely Unity (based on typical web game stack)
- **Features**: Custom maps, skill cards system, hero selection
- **Platform**: Web (Poki primary)

**Key Insight**: Competitive/esports focus with objective-based gameplay (not just TDM). Proves small studio can succeed with Poki partnership.

---

### 4. Repuls.io

**Status**: Active, passion project

**Developer**: Docski (Docski Games)

**Player Statistics**:
- **Status**: Active development (monthly updates)
- **Platform**: Web + Android

**Monetization**:
- **Free to play**: Web version
- **Mobile**: Android version (likely monetized differently)
- **Passion project**: Started in high school

**Technology**:
- **Engine**: Unity
- **Features**: Vehicles (mechs, planes, jeeps), grappling hook physics, open-world maps
- **Platform**: Web + Android

**Key Insight**: Most ambitious browser FPS - full Halo-like experience with vehicles and complex mechanics. Shows technical possibilities of web platform.

---

### 5. War Brokers

**Status**: Active, vehicle + infantry focus

**Developer**: Trebuchet Entertainment LLC

**Player Statistics**:
- **Steam CCU**: 9 concurrent players (current)
- **Platform**: Web (primary), Steam (secondary)
- **Player limit**: 16 players per match (browser performance limitations)
- **Match duration**: 15 minutes (Team Deathmatch)

**Monetization**:
- **Currency**: Coins (earnable or purchasable)
- **Coin value**: 1 coin ≈ $0.0002 USD
- **Purchase options**:
  - Minimum: 1,000 coins for $4.99
  - Maximum: 19,500 coins for $79.99
- **Free coins**: 6,845 coins earnable without paying (leveling + missions)
- **Ad rewards**: 1 coin per 15-20 second unskippable ad
- **Cosmetics only**: No pay-to-win, all weapons available to all players
- **Spending**: Coins spent on crates (cosmetics) and skin sets

**Technology**:
- **Platform**: Web-first, Steam version available
- **Matchmaking**: 16-player limit due to browser performance
- **Vehicles**: Started as 2D tank game, evolved to 3D with multiple vehicle types
- **Development path**: Vehicles first, then infantry added

**Team**:
- **Size**: Small team (specific numbers unknown)
- **Key roles**: Admin, map designer, weapon developer, main programmer
- **Structure**: Likely indie team similar to Pelican Party

**Key Insight**: Most similar to your project scope (vehicles + infantry). Proves vehicle + infantry FPS can work in browser. 16-player limit is realistic constraint. Monetization focuses on cosmetics with generous free-to-play model (6,845 free coins).

---

### 6. Shell Shockers

**Status**: Major success, multi-million dollar revenue

**Developer**: Blue Wizard Digital (Jason Kapalka, PopCap co-founder)

**Player Statistics**:
- **Total players**: 200 million
- **DAU peaks**: 300K-350K daily active users
- **Platform split**: 51% Windows, 39% Chromebooks, 10% mobile
- **Age demographic**: 10-15 year-olds (schoolkids)
- **Geography**: 47.6% US, 6.4% Canada, rest Brazil/Spain/Netherlands/Taiwan
- **Seasonality**: School-year pattern (declines in summer, peaks during school year)

**Monetization**:
- **Annual revenue**: "Low seven figures" = $1M-$3M/year
- **Ad revenue**: 80-90% of total revenue (banners + video ads)
- **Microtransactions**: 10-20% of total revenue
  - 50% cosmetics (hats, weapon skins)
  - 50% VIP status (removes ads, non-competitive bonuses)
- **No pay-to-win**: Cosmetics only, no competitive advantages

**Technology**:
- **Engine**: Babylon.js (JavaScript)
- **Platform**: Web (primary), mobile (secondary), Steam
- **Backend**: Custom multiplayer backend handling 10,000+ simultaneous players
- **Performance**: Optimized for Chromebooks (39% of player base)

**Company**:
- **Team size**: 11-50 employees
- **Location**: Comox Valley, British Columbia, Canada
- **Founded**: 2014 by Jason Kapalka (PopCap co-founder)
- **Status**: Independent, unfunded
- **Other games**: Football Bros series, murder-puzzle games

**Key Insight**: Proves web FPS can generate $1M-$3M/year with ad-heavy monetization. School market is massive and underserved. Chromebook optimization is critical (39% of players).

---

## Monetization Models

### 1. Platform Partnership Model (Narrow One, Venge.io)

**How it works**:
- Partner with platform (Poki, CrazyGames)
- Platform provides: traffic, infrastructure, marketing
- Revenue share: 50% on platform-referred traffic, 100% on direct traffic
- Exclusivity: Often 5-7 year web exclusivity required

**Pros**:
- Guaranteed traffic (Poki: 100M MAU, 1B gameplays/month)
- Infrastructure covered (servers, CDN)
- Marketing provided
- Lower risk than going solo

**Cons**:
- 50% revenue share on most traffic
- Exclusivity limits distribution
- Platform dependency
- Less control over monetization

**Best for**: Small teams, indie developers, sustainable operations

---

### 2. Complex Economy Model (Krunker)

**How it works**:
- In-game currency (KR) purchasable with real money
- Player-to-player marketplace with tax
- Trading system with fees
- Premium subscription
- Creator program (revenue share)

**Pros**:
- Multiple revenue streams
- Community engagement through economy
- Scalable with large player base
- Creator program drives growth

**Cons**:
- Complex to maintain and balance
- Requires large player base to function
- Inflation risks
- High development overhead

**Best for**: Large-scale games with massive player base, acquisition targets

---

### 3. Ad-Heavy + Cosmetic Model (Shell Shockers)

**How it works**:
- 80-90% ad revenue (banners + video ads during play)
- 10-20% microtransactions (cosmetics + VIP status)
- VIP removes ads and gives non-competitive bonuses
- No pay-to-win, cosmetics only
- Free-to-play with generous free currency

**Pros**:
- Highest revenue potential for web games ($1M-$3M/year proven)
- Works at massive scale (300K-350K DAU)
- School market is underserved and consistent
- Chromebook optimization critical (39% of players)
- Ad revenue scales with player count

**Cons**:
- Requires massive player base (300K+ DAU for $1M+)
- Ad-dependent (vulnerable to ad rate fluctuations)
- School seasonality (declines in summer)
- Requires 11-50 team to maintain
- Complex backend (10,000+ simultaneous players)

**Best for**: Teams with resources, school-friendly games, massive scale goals

**Key insight**: Shell Shockers proves $1M-$3M/year is possible with ad-heavy model at 300K-350K DAU. This is 3-10x Narrow One's revenue at 10x the player count.

---

### 4. Freemium + Mobile Expansion (Repuls.io)

**How it works**:
- Free web version for discovery
- Paid/mobile version for monetization
- Cross-platform expansion

**Pros**:
- Web for discovery (no friction)
- Mobile for monetization (higher ARPU)
- Broader market reach

**Cons**:
- Maintaining multiple platforms
- Different monetization strategies per platform
- Mobile development overhead

**Best for**: Games with cross-platform appeal, teams with mobile expertise

---

## Technology Stacks

### Custom WebGL Engines

**Examples**: Krunker, Narrow One (Renda)

**Pros**:
- Full control over performance
- Optimized for specific use case
- Smaller bundle sizes
- No licensing fees
- Defensible IP

**Cons**:
- High development cost
- Maintenance burden
- Limited tooling
- Talent pool smaller

**Best for**: Teams with technical expertise, long-term projects, acquisition targets

---

### Unity Web Export

**Examples**: Venge.io, Repuls.io, likely most web FPS games

**Pros**:
- Established tooling and ecosystem
- Faster development
- Large talent pool
- Cross-platform support
- Asset store

**Cons**:
- Larger bundle sizes
- Performance overhead
- Licensing costs (Pro tier)
- Less control over optimization

**Best for**: Rapid development, teams with Unity experience, cross-platform goals

---

### Three.js / Babylon.js

**Examples**: Your project (client_three)

**Pros**:
- Open source (no licensing)
- JavaScript/TypeScript (web-native)
- Good for custom implementations
- Large community

**Cons**:
- Higher development overhead than engines
- Need to build systems from scratch
- Performance tuning required

**Best for**: Custom implementations, web-native teams, full control needed

---

## Success Metrics

### Player Count Benchmarks

**Successful web FPS**:
- **Peak**: 10,000-30,000 CCU
- **Sustainable**: 1,000-5,000 CCU
- **Niche**: 100-1,000 CCU

**Comparison**:
- Krunker: 30,000 peak → 430 current (decline)
- Narrow One: 50,000 DAU peak → 25,000 current (stable)
- Venge.io: 660K plays (moderate success)

**Key insight**: Sustainable operations possible at 1,000-5,000 CCU with proper monetization.

---

### Revenue Benchmarks

**Web FPS revenue ranges**:
- **Niche**: $50K-$200K/year (1K-5K DAU)
- **Moderate**: $200K-$500K/year (10K-50K DAU)
- **Successful**: $500K-$1M/year (50K-100K DAU)
- **Hit**: $1M-$5M/year (100K-300K+ DAU)

**Examples**:
- Narrow One: $327K-$357K/year at 25K DAU (sustainable indie)
- Shell Shockers: $1M-$3M/year at 300K-350K DAU (ad-heavy model)
- Krunker: $200K-$500K/year pre-acquisition at 200M total players (overvalued)
- War Brokers: Unknown (small team, likely $50K-$200K range)

**Revenue per DAU comparison**:
- Narrow One: $327K / 25K DAU = $13.08/DAU = $0.036 ARPDAU
- Shell Shockers: $2M / 325K DAU = $6.15/DAU = $0.017 ARPDAU
- Krunker: $350K / 50K DAU (peak) = $7/DAU = $0.019 ARPDAU

**Key insight**: Shell Shockers generates 3-10x Narrow One's revenue but with 10x the player count. ARPDAU is actually lower for Shell Shockers ($0.017) than Narrow One ($0.036), suggesting platform partnership (Poki) may have higher ARPDAU than ad-heavy model, or Narrow One's monetization is more efficient per player.

---

### Monetization Efficiency

**ARPDAU (Average Revenue Per Daily Active User)**:
- **Web games**: $0.03-$0.12 (casual)
- **FPS games**: Likely $0.05-$0.15 (higher engagement)
- **With cosmetics**: $0.10-$0.20
- **With marketplace**: $0.15-$0.30

**Calculation example**:
- 25,000 DAU × $0.10 ARPDAU = $2,500/day = $912,500/year
- After 50% platform share = $456,250/year

**Key insight**: Narrow One's $327K-$357K at 25K DAU = ~$0.04 ARPDAU, below FPS benchmarks. Room for optimization.

---

## Strategic Paths

### Path 1: Sustainable Indie (Narrow One Model)

**Characteristics**:
- Platform partnership (Poki)
- Simple monetization (ads + cosmetics)
- Niche targeting (school-friendly)
- Efficiency focus (auto-scaling, custom engine)
- Long-term operations

**Financial outcome**: $300K-$500K/year, $40K-$75K net per person

**Risk profile**: Low

**Best for**: Small teams (1-3 people), sustainable income goal

---

### Path 2: Acquisition Target (Krunker Model)

**Characteristics**:
- Massive scale (100M+ players)
- Complex economy (marketplace, trading)
- Defensible technology (custom engine, tools)
- Viral growth focus
- Exit timing at hype peak

**Financial outcome**: $40M+ exit (high variance)

**Risk profile**: High

**Best for**: Teams seeking exit, technical expertise, growth capital

---

### Path 3: Competitive Esports (Venge.io Model)

**Characteristics**:
- Competitive focus
- Objective-based gameplay
- Community content (custom maps)
- Platform partnership
- Long-term engagement

**Financial outcome**: $200K-$500K/year (estimated)

**Risk profile**: Medium

**Best for**: Teams passionate about competitive gaming, community building

---

### Path 4: Ambitious Tech Demo (Repuls.io Model)

**Characteristics**:
- Maximum feature set (vehicles, grappling, etc.)
- Technical showcase
- Cross-platform expansion
- Passion project

**Financial outcome**: Unknown (likely low initially)

**Risk profile**: High (technical complexity)

**Best for**: Technical teams, portfolio building, learning

---

## Key Learnings

### 1. School Market is Massive and Underserved

**Shell Shockers proves this**:
- 39% of players on Chromebooks (school computers)
- 10-15 year-old demographic (schoolkids)
- 300K-350K DAU peaks during school year
- Seasonal pattern (declines in summer, peaks during school)
- 200 million total players

**Narrow One also targets this**:
- School-friendly (no realistic violence)
- Works on Chromebooks
- Unblocked version (narrow-one.io) for restrictive networks

**Key insight**: School market is the largest underserved segment in web gaming. Games that work on Chromebooks and are school-friendly can achieve massive scale (300K+ DAU). This is where the real money is in web FPS.

### 2. Platform Partnerships vs Ad-Heavy Model

**Platform partnership (Narrow One)**:
- Poki provides traffic (100M MAU)
- 50% revenue share on referred traffic
- Higher ARPDAU ($0.036)
- Sustainable at 25K DAU
- Lower overhead (platform handles infrastructure)

**Ad-heavy model (Shell Shockers)**:
- 80-90% ad revenue
- Lower ARPDAU ($0.017)
- Requires 300K+ DAU for $1M+ revenue
- Higher overhead (custom backend, 10K+ simultaneous players)
- 11-50 team needed

**Key insight**: Platform partnership is more efficient per player. Ad-heavy model requires 10x the player base for 3-10x the revenue. For small teams, platform partnership is better. For teams seeking massive scale, ad-heavy model is viable.

### 3. Chromebook Optimization is Critical

**Shell Shockers data**:
- 39% of players on Chromebooks
- "Frankly very underpowered" hardware
- Requires optimization for good framerate
- JavaScript/Babylon.js engine

**Key insight**: If targeting school market, Chromebook optimization is not optional - it's essential. 40% of your potential players are on underpowered hardware. Your engine must perform well on these devices.

### 4. Timing is Critical for Exits

- Krunker sold at peak of .io hype (smart for founder)
- FRVR bought at peak (risky, resulted in bad ROI)
- Hype cycles decay quickly (.io peaked 2021-2022)
- Acquisitions often overpay for declining assets
- Shell Shockers hasn't exited - still independent and profitable

**Key insight**: If pursuing acquisition path, sell at hype peak. If building sustainable business, ignore hype cycles and focus on steady growth.

### 5. Sustainable > Spectacular for Most

- Narrow One's $300K-$500K/year is sustainable for 2-person team
- Shell Shockers' $1M-$3M/year requires 11-50 team
- Krunker's $40M exit is rare and timing-dependent
- Most indie developers should target sustainability
- Acquisition path is high-variance lottery

**Key insight**: For most indie developers, sustainable indie model (Narrow One) is more realistic than acquisition target (Krunker) or massive scale (Shell Shockers).

### 6. Monetization Complexity Scales with Player Base

- Simple model (ads + cosmetics) works at 10K-50K DAU
- Complex economy (marketplace) needs 100K+ DAU
- Ad-heavy model needs 300K+ DAU for efficiency
- Don't overengineer monetization for small player base
- Start simple, add complexity as you scale

**Key insight**: Match monetization complexity to player count. War Brokers has simple coin system with generous free-to-play (6,845 free coins) - appropriate for their smaller scale.

### 7. Technology Choice Depends on Goals

- Custom engine (Renda, Krunker): For acquisition targets, long-term projects
- Unity (Venge, Repuls): For rapid development, cross-platform
- Three.js/Babylon (Shell Shockers, your project): For web-native teams, custom control

**Key insight**: Shell Shockers uses Babylon.js and handles 10,000+ simultaneous players. Proves JavaScript engines can scale. Your Three.js choice is viable.

### 8. Vehicle + Infantry is Viable but Complex

**War Brokers proves**:
- Vehicle + infantry FPS works in browser
- 16-player limit due to browser performance
- Started as 2D tank game, evolved to 3D
- Small team can maintain

**Repuls.io shows**:
- Ambitious vehicle + infantry possible
- Grappling hook + vehicles + open maps
- Unity engine for complexity

**Key insight**: Vehicle + infantry is viable but adds complexity. Consider 16-player limit as realistic constraint for browser performance.

## Recommendations for Your Project

### Based on Your Scope (Vehicle + Infantry FPS)

**Most relevant case studies**:
1. **War Brokers** - Direct competitor, needs research
2. **Repuls.io** - Similar scope, ambitious tech
3. **Narrow One** - Sustainable model, platform partnership

**Recommended approach**:
- **Path**: Sustainable indie with platform partnership
- **Monetization**: Start with ads + cosmetics, add marketplace if scale permits
- **Technology**: Three.js/Babylon (you're already using this)
- **Platform**: Web-first, consider Poki partnership for traffic
- **Target**: 10K-25K DAU for $200K-$400K/year revenue

**Key differentiators**:
- Vehicle + infantry (less common than pure infantry)
- Movement system (skiing, momentum-based)
- Technical quality (custom physics, terrain system)

**Risks to mitigate**:
- Don't overbuild for initial player base
- Focus on core gameplay loop first
- Monetization should be simple initially
- Platform partnership for traffic acquisition

## Market Realities

### Global Browser Gaming Market Size

**Current Market (2023-2024)**:
- **2023**: $15.03 billion globally
- **2024**: $8.5 billion (alternative source)
- **2028 projected**: $22.33 billion (48% growth)
- **2033 projected**: $15.9 billion (7.5% CAGR 2026-2033)

**Regional Distribution (2023)**:
- **Asia-Pacific**: ~50% of total market (~$7.5 billion)
- **North America**: $4.29 billion
- **Europe**: ~30% of total market
- **Rest of world**: ~20%

**Key insight**: Browser gaming is a multi-billion dollar market with steady growth. Asia-Pacific dominates by volume, but North America has higher monetization per user.

---

### Ad CPM Rates by Geography

**Rewarded Video Ads (2024-2026 benchmarks)**:

| Region | CPM Range | Notes |
|--------|-----------|-------|
| **North America** | $10-$18 | Desktop: $14-$18, Mobile web: $10-$14, Q4 peaks: $22-$26 |
| **Europe** | $6-$10 | Western Europe: $8-$10, Southern/Eastern: $6-$8 |
| **Asia-Pacific** | $4-$7 | Tier-1 cities (AU, JP, KR): $6-$7, Southeast Asia: $4-$5.50 |
| **MENA** | $5-$9 | GCC countries: $7-$9, Rest: $5-$6 |

**Desktop vs Mobile Web**:
- Desktop web CPMs: 20-35% higher than mobile app equivalents
- Desktop completion rates: 8-15% higher than mobile
- Desktop CTRs: 30-50% higher than mobile

**Ad Format Comparison**:
- **Banner ads**: Under $2 CPM (generic, low engagement)
- **Rewarded video**: $6-$20+ CPM (engaged users, high completion)
- **Rewarded video on web**: 3-10x higher CPM than banners

**Fill Rate Trends**:
- **2023**: Stable but unoptimized
- **2024**: High CPMs but terrible fill rates (36%)
- **2025**: Both CPM and fill rate optimized (96% fill rate)
- **Key insight**: CPM alone doesn't matter - need both high CPM and high fill rate

**Geographic Multiplier Effect**:
- US traffic typically earns 2-3x more than Tier-3 markets
- First-tier demand (Western nations) is 10x higher than third/fourth-tier
- North American inventory commands premium due to consumer spending power

---

### ARPU Benchmarks by Genre

**Web Game ARPU (Average Revenue Per User)**:

| Genre | ARPU Range | North America | Europe | Asia-Pacific |
|-------|------------|----------------|--------|--------------|
| **Casual** | $0.03-$0.12 | $0.08-$0.12 | $0.05-$0.09 | $0.04-$0.08 |
| **Hardcore/Strategy** | $0.08-$0.20 | $0.15-$0.20 | $0.10-$0.16 | $0.09-$0.14 |
| **Real-Money/Skill** | $0.20-$0.60 | $0.35-$0.60 | $0.25-$0.45 | $0.22-$0.38 |

**FPS Games (Action/Arcade category)**:
- **ARPU**: $0.08
- **Rewarded ad engagement**: 52%
- **Average CPM**: $10.50
- **Completion rate**: 88%

**Key insight**: FPS games fall in the middle range - higher ARPU than casual ($0.08 vs $0.03-$0.12) but lower than strategy/real-money games. Rewarded ads can increase ARPU by 40-70% compared to banner-only approaches.

---

### Platform Economics

**Poki Partnership Model**:
- **Direct traffic**: 100% revenue to developer (Google search, bookmarks, social media)
- **Poki-referred traffic**: 50% revenue share
- **Exclusivity**: 5-7 years (default for maximum support)
- **Platform provides**: Marketing, QA, infrastructure, ad partnerships
- **Platform scale**: 100 million monthly active users

**CrazyGames Partnership Model**:
- **Revenue share**: 50% with time-based exclusivity
- **Compensation**: Based on web traffic and ad performance
- **Payment terms**: 30 days after month-end
- **Platform**: Advertiser partnerships, monthly calculations

**First Web Game Expectations**:
- **Realistic monthly revenue**: $500-$3,000
- **Ceiling**: Lower than Steam breakout (millions in months)
- **Growth pattern**: Slower than mobile, requires multiple games building cumulative audience
- **Revenue model**: Advertising-based revenue share

**Key insight**: Platform partnerships provide guaranteed traffic but take 50% of platform-referred revenue. Direct traffic (SEO, community) keeps 100%. First games should expect $500-$3,000/month, not millions.

---

### F2P Conversion Rates

**General F2P Conversion Benchmarks**:
- **Typical conversion rates**: 1-5% for mobile F2P
- **Survey data**: 37% of players have purchased in-game content (any game)
- **First-time purchasers**: 37% of buyers made their first purchase in that game
- **Average spend**: Fortnite users average $84.67 (exceptionally high)

**Web Game Conversion Rates**:
- **Cosmetics**: Typically 1-2% conversion for web games
- **Rewarded ads**: 35-65% opt-in engagement (voluntary nature)
- **Completion rates**: 80-95% for rewarded video ads
- **Banner ads**: Under 10% engagement

**Conversion Pricing Strategy**:
- **Microtransactions**: $0.99 entry pricing for first purchase
- **High conversion items**: Limited time/use to encourage repeat purchases
- **Value proposition**: Clear exchange (attention for rewards)

**Key insight**: Web game conversion rates are lower than mobile (1-2% vs 1-5%), but rewarded ads have much higher engagement (35-65% opt-in) because they're voluntary and provide clear value.

---

### Geographic Monetization Differences

**North America Advantages**:
- **Highest CPMs**: $10-$18 (2-3x other regions)
- **Highest ARPU**: $0.08-$0.60 depending on genre
- **Strongest consumer spending power**
- **Most competitive advertiser demand**

**Shell Shockers Geographic Breakdown**:
- **United States**: 47.6% of traffic
- **Canada**: 6.4%
- **Brazil, Spain, Netherlands, Taiwan**: Next-ranked countries
- **Evenly distributed across US states**

**Roblox Brand Integration CPMs (2027)**:
- **United States**: $1.50 CPM
- **UK, Canada, Australia, NZ, Nordics**: $0.75 CPM
- **Western Europe, Japan, South Korea**: $0.20 CPM
- **Rest of world**: $0.05 CPM

**Key insight**: US traffic is worth 30x more than rest-of-world traffic in some contexts ($1.50 vs $0.05 CPM). Geographic mix directly impacts revenue - a game with 50% US traffic will earn significantly more than one with 10% US traffic.

---

### Retention's Revenue Multiplier Effect

**Retention Benchmarks**:
- **Web games Day 1 retention**: 40-55% (vs mobile 25-35%)
- **Web games session frequency**: 2-3x higher than mobile
- **Revenue multiplier**: Each 5-point Day 7 retention increase drives 12-18% ARPU improvement

**Why Web Games Have Higher Retention**:
- Frictionless access (no download)
- No app store gatekeepers
- Instant playability across devices
- Direct-to-web user acquisition

**Key insight**: Retention directly multiplies revenue. A 5-point improvement in Day 7 retention = 12-18% more revenue. Web games naturally have higher retention than mobile due to frictionless access.

---

### Seasonality and Timing

**Q4 Seasonal Peaks**:
- **November**: "Super Bowl" for ad revenue
- **Q4 CPM peaks**: $22-$26 for premium gaming inventory
- **Fill rates**: Typically highest in Q4
- **Advertiser behavior**: Flood market with demand in Q4

**School Market Seasonality**:
- **Shell Shockers pattern**: Peaks during school year, declines in summer
- **Thanksgiving week**: Visible dip in DAU
- **Key insight**: School market has inverse seasonality to typical gaming (peaks when school is in session)

**Key insight**: Timing matters. Q4 is best for ad revenue (highest CPMs and fill rates). School market peaks during school year, not summer.

---

### Market Realities Summary

**Revenue Reality**:
- Browser gaming is a $15B+ market with steady growth
- First web games: $500-$3,000/month realistic
- Hit games: $1M-$3M/year possible (Shell Shockers)
- Geographic mix is critical (US traffic worth 2-30x more)

**Monetization Reality**:
- Rewarded video ads: 3-10x higher CPM than banners ($6-$20 vs <$2)
- Platform partnerships: 50% revenue share for guaranteed traffic
- Ad-heavy model: Requires 300K+ DAU for efficiency
- Platform partnership: More efficient per player at smaller scale

**Geographic Reality**:
- North America: Highest CPMs ($10-$18) and ARPU ($0.08-$0.60)
- Asia-Pacific: 50% of market volume but lower per-user value
- US traffic: 30x more valuable than rest-of-world in some contexts
- Geographic optimization: Target US/Europe for monetization, Asia-Pacific for volume

**Technical Reality**:
- Desktop web: 20-35% higher CPMs than mobile
- Chromebook optimization: Critical for school market (39% of players)
- Fill rate matters as much as CPM (2024 showed high CPM + low fill = bad revenue)
- JavaScript engines can scale (Shell Shockers handles 10,000+ simultaneous players)

**Strategic Reality**:
- Platform partnership: Better for small teams (efficient per player)
- Ad-heavy model: Better for teams seeking massive scale
- School market: Largest underserved segment (300K+ DAU possible)
- Chromebook optimization: Not optional for school market (40% of potential players)

## Research Gaps

The following areas need deeper research:

1. **Bullet Force**: Web vs mobile performance, monetization split
2. **Specific FPS conversion rates**: More data on FPS F2P conversion
3. **Platform comparison**: Poki vs CrazyGames vs direct traffic economics
4. **School market size**: Quantitative data on school Chromebook usage
5. **Fill rate optimization**: Technical strategies for improving fill rates

## Next Steps

1. Research War Brokers in depth (most similar to your scope)
2. Research Shell Shockers monetization (proven model)
3. Interview with platform partners (Poki, CrazyGames) if possible
4. Analyze your project's competitive positioning
5. Define monetization strategy based on target player count

## References

- [Pelican Party Monetization Analysis](./PELICAN_PARTY_MONETIZATION.md)
- [Krunker Monetization Analysis](./KRUNKER_MONETIZATION.md)
- [Narrow One Analysis](./NARROW_ONE_ANALYSIS.md)
- [Client-Authoritative Networking](./CLIENT_AUTHORITATIVE_NETWORKING.md)
