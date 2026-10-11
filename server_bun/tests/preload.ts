// Test gate: every invariant violation throws — a broken invariant fails
// the suite that let it happen, never a counted blip on a later dump.
import { setStrictInvariants } from '../../shared/invariants.ts';
setStrictInvariants(true);
