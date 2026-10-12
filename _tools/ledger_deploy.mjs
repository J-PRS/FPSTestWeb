import fs from 'fs';
const f = '_docs/CORRECTNESS.md';
let s = fs.readFileSync(f, 'utf8');
const entry = `- **Deploy placement claims:** \`handleDeploy\` gates every forgeable
  axis — player alive, kind enum + cap-0 rejection (a client cannot
  plant a generator), pos finite + within \`MAX_PLANT_DIST\` of the
  server-truth position, Y re-derived via \`groundY\` (a claimed Y
  is ignored — no buried or floating gear), belt charges verified
  before the spend, per-player cap recycles the oldest unit.
  Verified sealed.
`;
if (!s.includes('Deploy placement claims')) {
  s = s.replace('## Remaining', entry + '\n## Remaining');
  fs.writeFileSync(f, s);
  console.log('ledgered');
} else { console.log('already there'); }
