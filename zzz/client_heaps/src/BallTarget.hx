class BallTarget {

  static inline var BASE_RADIUS = 1.2;
  static inline var GRAVITY    = -28.0;
  static inline var BOUNCE     = 1.0;    // perfect elastic bounce
  static inline var FRICTION   = 1.0;    // no horizontal damping
  static inline var BOUND      = 220.0;  // world edge

  // Teleport-to-player constants
  static inline var MAX_DIST  = 300.0;  // if farther than this from player, teleport
  static inline var TELE_MIN  = 60.0;   // min spawn ring radius around player
  static inline var TELE_MAX  = 120.0;  // max spawn ring radius around player
  static inline var TELE_HEIGHT = 25.0; // height above ground when teleported

  // Trail constants
  static inline var TRAIL_COUNT    = 14;    // ghost dots kept alive
  static inline var TRAIL_LIFE     = 1.2;   // seconds each dot lives
  static inline var TRAIL_INTERVAL = 0.04;  // seconds between emissions
  static inline var TRAIL_RADIUS   = 1.0;   // dot sphere radius

  public var pos    : h3d.Vector;
  public var dead   : Bool = false;
  public var health : Int = 1;
  public var scale  : Float = 1.0;
  public var radius : Float;

  var vel  : h3d.Vector;
  var mesh : h3d.scene.Mesh;
  var s3d  : h3d.scene.Scene;

  // Trail state / color (public so Game can pass to BallDebris)
  public var cr: Float; public var cg: Float; public var cb: Float;
  var trailTimer  : Float = 0.0;
  var trailDots   : Array<{ m: h3d.scene.Mesh, mat: h3d.mat.Material, age: Float }>;
  var flashTimer  : Float = 0.0;  // damage flash effect

  // Random cheerful color per ball
  static var COLORS = [
    [1.0, 0.25, 0.25],
    [0.25, 0.85, 0.25],
    [0.25, 0.55, 1.0],
    [1.0, 0.85, 0.1],
    [0.9, 0.25, 0.9],
    [0.15, 0.9, 0.9],
    [1.0, 0.5, 0.1],
  ];

  public function new(s3d: h3d.scene.Scene, terrain: Terrain, variant: Int = 0) {
    this.s3d = s3d;

    // Variant: 0=small(1x), 1=medium(2x), 2=large(3x)
    if (variant == 1) {
      scale = 2.0;
      health = 2;
      // Green for medium
      cr = 0.25; cg = 0.85; cb = 0.25;
    } else if (variant == 2) {
      scale = 3.0;
      health = 3;
      // Red for large
      cr = 1.0; cg = 0.25; cb = 0.25;
    } else {
      scale = 1.0;
      health = 1;
      // Teal for small
      cr = 0.15; cg = 0.9; cb = 0.9;
    }
    radius = BASE_RADIUS * scale;

    // Pick a random spot well inside the map
    var rx = (Math.random() - 0.5) * 2 * (BOUND - 20);
    var rz = (Math.random() - 0.5) * 2 * (BOUND - 20);
    var gy = terrain.getHeight(rx, rz);
    pos = new h3d.Vector(rx, gy + 80.0 + Math.random() * 60.0, rz);

    // Random lateral velocity, slight downward drift
    var ang = Math.random() * Math.PI * 2;
    var spd = Math.random() * 20.0;
    vel = new h3d.Vector(Math.cos(ang) * spd, -2.0, Math.sin(ang) * spd);

    var sphere = new h3d.prim.Sphere(BASE_RADIUS, 5, 4);
    sphere.addUVs();
    sphere.addNormals();
    var mat = h3d.mat.Material.create();
    mat.color.set(cr, cg, cb);
    mat.props = mat.getDefaultProps("default");
    mesh = new h3d.scene.Mesh(sphere, mat, s3d);
    mesh.x = pos.x; mesh.y = pos.y; mesh.z = pos.z;
    mesh.setScale(scale);

    trailDots = [];
  }

  public function update(dt: Float, terrain: Terrain, ?playerPos: h3d.Vector) {
    if (dead) return;

    // Gravity
    vel.y += GRAVITY * dt;

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    // Terrain bounce — reflect against real surface normal
    var gy = terrain.getHeight(pos.x, pos.z);
    if (pos.y - radius <= gy) {
      pos.y = gy + radius;
      var n   = terrain.getNormal(pos.x, pos.z);
      var dot = vel.x*n.x + vel.y*n.y + vel.z*n.z;
      vel.x = (vel.x - 2.0 * dot * n.x) * BOUNCE;
      vel.y = (vel.y - 2.0 * dot * n.y) * BOUNCE;
      vel.z = (vel.z - 2.0 * dot * n.z) * BOUNCE;

      // Teleport if too far from player
      if (playerPos != null) {
        var dx = pos.x - playerPos.x;
        var dz = pos.z - playerPos.z;
        if (dx*dx + dz*dz > MAX_DIST * MAX_DIST) {
          var ang  = Math.random() * Math.PI * 2;
          var dist = TELE_MIN + Math.random() * (TELE_MAX - TELE_MIN);
          var tx   = playerPos.x + Math.cos(ang) * dist;
          var tz   = playerPos.z + Math.sin(ang) * dist;
          pos.x = tx;
          pos.z = tz;
          pos.y = terrain.getHeight(tx, tz) + TELE_HEIGHT;
          vel.x = Math.random() * 10.0 - 5.0;
          vel.y = 2.0;
          vel.z = Math.random() * 10.0 - 5.0;
          trailTimer = TRAIL_INTERVAL; // flush trail immediately on next frame
        }
      }
    }

    mesh.x = pos.x; mesh.y = pos.y; mesh.z = pos.z;

    // Restore color after damage flash
    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) {
        mesh.material.color.set(cr, cg, cb);
      }
    }

    // Emit a new trail dot
    trailTimer += dt;
    if (trailTimer >= TRAIL_INTERVAL) {
      trailTimer = 0.0;
      var spd2 = vel.x*vel.x + vel.y*vel.y + vel.z*vel.z;
      if (spd2 > 0.5) {   // only trail when actually moving
        var tsph = new h3d.prim.Sphere(TRAIL_RADIUS * scale, 6, 6);
        tsph.addUVs(); tsph.addNormals();
        var tmat = h3d.mat.Material.create();
        tmat.color.set(cr, cg, cb);
        tmat.props = tmat.getDefaultProps("default");
        var tm = new h3d.scene.Mesh(tsph, tmat, s3d);
        tm.x = pos.x; tm.y = pos.y; tm.z = pos.z;
        trailDots.push({ m: tm, mat: tmat, age: 0.0 });
      }
    }

    // Age trail dots
    var ti = trailDots.length;
    while (--ti >= 0) {
      var d = trailDots[ti];
      d.age += dt;
      if (d.age >= TRAIL_LIFE) {
        d.m.remove();
        trailDots.splice(ti, 1);
      } else {
        var t  = d.age / TRAIL_LIFE;
        var ft = 1.0 - t;
        // shrink as they age
        var s = ft * ft;
        d.m.setScale(s < 0.01 ? 0.01 : s);
        // brighten center tint and fade toward ball color * darkness
        d.mat.color.set(cr * ft, cg * ft, cb * ft);
      }
    }
  }

  // Returns true if the given point is inside the ball
  public function hitTest(px: Float, py: Float, pz: Float, ?extraRadius: Float) : Bool {
    var dx = px - pos.x; var dy = py - pos.y; var dz = pz - pos.z;
    var r = radius + (extraRadius == null ? 0.0 : extraRadius);
    return dx*dx + dy*dy + dz*dz <= r * r;
  }

  // Apply damage, return true if destroyed
  public function takeDamage() : Bool {
    health--;
    if (health <= 0) {
      dead = true;
      return true;
    }
    // Flash effect on damage
    flashTimer = 0.15;  // flash for 0.15 seconds
    mesh.material.color.set(1.0, 1.0, 1.0);
    return false;
  }

  // Apply knockback impulse from explosion
  public function applyKnockback(fromX: Float, fromY: Float, fromZ: Float, force: Float) {
    var dx = pos.x - fromX;
    var dy = pos.y - fromY;
    var dz = pos.z - fromZ;
    var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < 0.1) dist = 0.1;  // prevent division by zero
    // Normalize and apply force
    vel.x += (dx / dist) * force;
    vel.y += (dy / dist) * force * 0.5;  // less vertical knockback
    vel.z += (dz / dist) * force;
  }

  public function dispose() {
    mesh.remove();
    for (d in trailDots) d.m.remove();
    trailDots = [];
  }
}
