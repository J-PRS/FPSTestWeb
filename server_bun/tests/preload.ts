// Test gate: every invariant violation throws — a broken invariant fails
// the suite that let it happen, never a counted blip on a later dump.
import { setStrictInvariants } from '../../shared/invariants.ts';
setStrictInvariants(true);

// Scenario rooms run the pre-MPC reactive stack: the capper option's
// sync fallback pays ~300ms/solve inside step(), which turned 5s
// sim-soak tests into 20-100s wall runs (measured: defenderFire 98s,
// invariantSoak 24s, replicaParity 7s, fastSoak ratio 3x vs the 10x
// bar — the planner's cost, not the room's). Production offloads
// search to the MPC worker so nothing real pays it. The sweep tools
// (capStat/mpcCap) never load this file, so their cappers stay armed.
process.env.FPS_MPC_OFF ??= '1';
