import io
p = 'src/game/entities.ts'
s = io.open(p, encoding='utf-8').read()

# grab the ball block: from "// Wire bounce/peak" through end of recordBallSnapshots
a = s.index("  // Wire bounce/peak keyframe callbacks")
b = s.index("  /** Loose gems from non-target deaths")
block = s[a:b]
s = s[:a] + s[b:]

# strip leading 2-space indent for module scope
mod = '\n'.join(line[2:] if line.startswith('  ') else line for line in block.splitlines())

sub = '''interface BallFieldDeps {
  deps: EntitiesDeps;
  balls: Ball[];
  targets: Targetable[];
  classicMode: boolean;
  serverBalls: () => boolean;
  netTargetPosFor: (b: Ball) => THREE.Vector3 | null;
  aggroFor: (e: Targetable, pos: THREE.Vector3, dt: number, profile: AggroProfile) => THREE.Vector3 | null;
  kickDust: (e: { pos: THREE.Vector3; vel: THREE.Vector3 }, dt: number) => void;
  removeTarget: <T>(list: T[], i: number, e: T) => void;
  pickVariant: () => 0 | 1 | 2 | 3;
}

// Owns the local (non-server) ball population: ambient spawns, elite
// splits, demo keyframe + snapshot recording. Server-owned ball
// replication lives in game/netBalls.ts — this field only runs the
// offline/demo side and culls locals once a server roster arrives.
function createBallField(f: BallFieldDeps) {
  const { deps, balls, targets } = f;
  const scene = deps.scene;
  let ballTimer = 0;
  let ballSnapshotTimer = 0;

'''
s = s.replace("// Owns every ambient-entity registry", sub + "// Owns every ambient-entity registry", 1)

# insert the stripped body after the createBallField header comment block
hdr_end = s.index("let ballSnapshotTimer = 0;\n\n")
s = s[:hdr_end + len("let ballSnapshotTimer = 0;\n\n")] + mod + s[hdr_end + len("let ballSnapshotTimer = 0;\n\n"):]

# fix references inside the moved block: bare names -> f.<name>
moved_names = ["serverBalls", "netTargetPosFor", "aggroFor", "kickDust", "removeTarget", "pickVariant", "classicMode"]
import re
start = s.index("function createBallField")
end = s.index("// Owns every ambient-entity registry")
body = s[start:end]
for n in ["serverBalls", "netTargetPosFor", "aggroFor", "kickDust", "removeTarget", "pickVariant"]:
    body = re.sub(r'(?<![\w.])' + n + r'\(', 'f.' + n + '(', body)
body = body.replace("CLASSIC_MODE ? 0", "f.classicMode ? 0")
# internal calls must not get f. prefix
for n in ["recordBallKeyframes", "spawnBallOfVariant", "spawnSplitChildren", "spawnBall\\(", "recordBallSnapshots", "spawnBall"]:
    body = re.sub(r'f\.' + n + r'\(', n.replace("\\\\","") + '(', body)
s = s[:start] + body + s[end:]

# remove the f.-prefixed names that live inside createBallField anyway? they are params of f — fine.
# In the factory, replace the moved function calls with ballField.x
factory_start = s.index("export function createEntities")
head, tail = s[:factory_start], s[factory_start:]
tail = tail.replace("  const netCrawlers = createNetCrawlers", '''  const ballField = createBallField({
    deps, balls, targets, classicMode: CLASSIC_MODE,
    serverBalls, netTargetPosFor,
    aggroFor: (e, pos, dt, profile) => aggroFor(e, pos, dt, profile),
    kickDust, removeTarget, pickVariant,
  });
  const { spawnBall, spawnEliteBall, updateBalls, recordBallKeyframes } = ballField;

  const netCrawlers = createNetCrawlers''')
# spawnSplitChildren was internal to onDeath — only referenced inside moved block (onDeath wiring inside spawnBallOfVariant) — ok.
s = head + tail

# add return of ballField fns inside createBallField: append before its closing brace
close_idx = s.index("// Owns every ambient-entity registry")
seg = s[start:close_idx]
seg = seg[:seg.rfind("}\n")] + '''
  return { spawnBall, spawnEliteBall, updateBalls, recordBallKeyframes, spawnBallOfVariant };
}
'''
s = s[:start] + seg + s[close_idx:]

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
