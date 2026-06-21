class Rocket {

  static inline var SPEED      = 120.0;
  static inline var INHERIT    = 0.5;
  static inline var GRAVITY    = -20.0;
  static inline var RADIUS     = 0.3;   // visual + terrain collision radius
  static inline var HIT_MIN    = 0.3;   // hitbox starts tiny
  static inline var HIT_MAX    = 10.0;  // grows to this over HIT_GROW seconds
  static inline var HIT_GROW   = 2.0;   // seconds to reach full hitbox

  static inline var TRAIL_INTERVAL = 0.025;
  static inline var TRAIL_LIFE     = 0.32;

  public var pos     : h3d.Vector;
  public var dead    : Bool = false;
  public var hitRadius(get, never) : Float;
  public var firePos : h3d.Vector;  // where the rocket was fired from

  var vel        : h3d.Vector;
  var mesh       : h3d.scene.Mesh;
  var glowMesh   : h3d.scene.Mesh;  // additive outer glow shell
  var age        : Float = 0.0;
  var trailTimer : Float = 0.0;
  var trailDots  : Array<{ m: h3d.scene.Mesh, mat: h3d.mat.Material, age: Float }> = [];
  var s3d        : h3d.scene.Scene;
  public var prevPos : h3d.Vector;

  function get_hitRadius() {
    var t = age / HIT_GROW;
    if (t > 1.0) t = 1.0;
    return HIT_MIN + (HIT_MAX - HIT_MIN) * t;
  }

  public function new(s3d: h3d.scene.Scene, origin: h3d.Vector, dir: h3d.Vector, playerVel: h3d.Vector) {
    this.s3d = s3d;
    pos = origin.clone();
    firePos = origin.clone();

    var dot = playerVel.dot(dir);
    vel = dir.clone();
    vel.scale(SPEED + dot * INHERIT);

    prevPos = pos.clone();

    // Core: bright white-orange solid sphere
    var sphere = new h3d.prim.Sphere(RADIUS, 8, 8);
    sphere.addUVs(); sphere.addNormals();
    var mat = h3d.mat.Material.create();
    mat.color.set(1.0, 0.85, 0.3);
    mat.props = mat.getDefaultProps("default");
    mesh = new h3d.scene.Mesh(sphere, mat, s3d);
    mesh.setScale(0.5);
    mesh.x = pos.x; mesh.y = pos.y; mesh.z = pos.z;

    // Glow shell: larger additive sphere around the core
    var gSphere = new h3d.prim.Sphere(RADIUS * 4.0, 6, 6);
    gSphere.addUVs(); gSphere.addNormals();
    var gmat = h3d.mat.Material.create();
    gmat.color.set(1.0, 0.4, 0.0);
    gmat.blendMode = h3d.mat.BlendMode.Add;
    gmat.mainPass.depthWrite = false;
    glowMesh = new h3d.scene.Mesh(gSphere, gmat, s3d);
    glowMesh.setScale(0.5);
    glowMesh.x = pos.x; glowMesh.y = pos.y; glowMesh.z = pos.z;
  }

  public function update(dt: Float, terrain: Terrain) {
    if (dead) return;

    prevPos.set(pos.x, pos.y, pos.z);

    age += dt;

    // Emit ghost trail dot
    trailTimer += dt;
    if (trailTimer >= TRAIL_INTERVAL) {
      trailTimer = 0.0;
      var tsph = new h3d.prim.Sphere(RADIUS * 2.5, 5, 5);
      tsph.addUVs(); tsph.addNormals();
      var tmat = h3d.mat.Material.create();
      tmat.color.set(1.0, 0.45, 0.0);
      tmat.blendMode = h3d.mat.BlendMode.Add;
      tmat.mainPass.depthWrite = false;
      var tm = new h3d.scene.Mesh(tsph, tmat, s3d);
      tm.x = pos.x; tm.y = pos.y; tm.z = pos.z;
      trailDots.push({ m: tm, mat: tmat, age: 0.0 });
    }

    // Age trail dots
    var ti = trailDots.length;
    while (--ti >= 0) {
      var d = trailDots[ti];
      d.age += dt;
      if (d.age >= TRAIL_LIFE) {
        d.m.remove(); trailDots.splice(ti, 1);
      } else {
        var ft = 1.0 - d.age / TRAIL_LIFE;
        d.m.setScale(ft * ft < 0.01 ? 0.01 : ft * ft);
        d.mat.color.set(1.0, 0.3 * ft, 0.0);
      }
    }

    vel.y += GRAVITY * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    // Sphere sweep collision against terrain
    if (sphereSweepHitsTerrain(terrain)) {
      dead = true;
      return;
    }

    mesh.x = pos.x; mesh.y = pos.y; mesh.z = pos.z;
    glowMesh.x = pos.x; glowMesh.y = pos.y; glowMesh.z = pos.z;
  }

  // Swept sphere collision: check if the rocket's path intersects terrain
  function sphereSweepHitsTerrain(terrain: Terrain) : Bool {
    var dx = pos.x - prevPos.x;
    var dy = pos.y - prevPos.y;
    var dz = pos.z - prevPos.z;
    var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < 0.001) {
      // Minimal movement - just check endpoint
      var groundY = terrain.getHeight(pos.x, pos.z);
      return pos.y - RADIUS <= groundY;
    }

    // Sample along the movement path (step size = RADIUS for accuracy)
    var steps = Std.int(Math.ceil(dist / RADIUS)) + 1;
    var invSteps = 1.0 / steps;

    for (i in 0...steps + 1) {
      var t = i * invSteps;
      var sx = prevPos.x + dx * t;
      var sy = prevPos.y + dy * t;
      var sz = prevPos.z + dz * t;

      // Check multiple sample points around the sphere's xz position
      // (terrain is heightfield, so we check a small circle in xz)
      var groundY = terrain.getHeight(sx, sz);

      // Also sample nearby points for better coverage
      var offsets = [0.0, RADIUS * 0.5, -RADIUS * 0.5];
      for (ox in offsets) {
        for (oz in offsets) {
          var gy = terrain.getHeight(sx + ox, sz + oz);
          // Sphere vs terrain point: if sphere center is within RADIUS of terrain
          if (sy - RADIUS <= gy) {
            return true;
          }
        }
      }
    }
    return false;
  }

  public function dispose() {
    mesh.remove();
    glowMesh.remove();
    for (d in trailDots) d.m.remove();
  }
}
