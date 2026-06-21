// A single flying shard from a destroyed ball
class Shard {
  public var mesh    : h3d.scene.Mesh;
  public var mat     : h3d.mat.Material;
  public var vx      : Float; public var vy: Float; public var vz: Float;
  // angular velocity (euler per second, simple)
  public var rx      : Float; public var ry: Float; public var rz: Float;
  public var life      : Float;
  public var elapsed   : Float = 0.0;
  public var dead      : Bool  = false;
  public var landed    : Bool  = false;
  public var landedAt  : Float = 0.0;   // elapsed time when first touched ground
  public var radius    : Float = 0.5;   // collision radius — max half-extent of the box
  public var cr: Float; public var cg: Float; public var cb: Float; // original color
  public var x         : Float; public var y: Float; public var z: Float;
  public function new(mesh, mat, x, y, z, vx, vy, vz, rx, ry, rz, life, radius, cr, cg, cb) {
    this.mesh=mesh; this.mat=mat;
    this.x=x; this.y=y; this.z=z;
    this.vx=vx; this.vy=vy; this.vz=vz;
    this.rx=rx; this.ry=ry; this.rz=rz;
    this.life=life; this.radius=radius;
    this.cr=cr; this.cg=cg; this.cb=cb;
  }
}

class BallDebris {

  static inline var GRAVITY      = -26.0;
  static inline var BOUNCE_Y     = 0.35;   // low bounce, they settle fast
  static inline var FRICTION_XZ  = 0.80;
  static inline var BASE_CHUNK_COUNT = 14;
  static inline var BASE_SPEED   = 9.0;
  static inline var EXTRA_SPEED  = 14.0;
  static inline var LIFE_BASE    = 6.0;   // fallback max lifetime if never lands
  static inline var LIFE_RAND    = 2.0;
  static inline var SHRINK_DUR   = 0.5;   // seconds to shrink to zero after landing
  static inline var GREY_DUR     = 1.0;   // seconds to fade to grayscale

  public var dead : Bool = false;

  var shards  : Array<Shard> = [];
  var terrain : Terrain;

  public function new(s3d: h3d.scene.Scene, terrain: Terrain,
                      px: Float, py: Float, pz: Float,
                      cr: Float, cg: Float, cb: Float,
                      scale: Float = 1.0) {
    this.terrain = terrain;

    // More chunks for larger enemies, but same chunk size
    var chunkCount = Std.int(BASE_CHUNK_COUNT * scale);

    for (i in 0...chunkCount) {
      // --- shape: randomly scaled box to simulate an irregular chunk ---
      // Chunk size does NOT scale with enemy size
      var sw = 0.25 + Math.random() * 0.55;
      var sh = 0.18 + Math.random() * 0.45;
      var sd = 0.20 + Math.random() * 0.50;
      var cube = makeShard(sw, sh, sd);
      cube.addNormals();
      var mat = h3d.mat.Material.create();
      // slight color variation per chunk
      var v = 0.75 + Math.random() * 0.25;
      mat.color.set(cr * v, cg * v, cb * v);
      mat.props = mat.getDefaultProps("default");
      var m = new h3d.scene.Mesh(cube, mat, s3d);

      // offset spawn position based on scale - larger enemies spawn debris in wider sphere
      var ox = (Math.random() - 0.5) * 0.6 * scale;
      var oy = (Math.random() - 0.5) * 0.6 * scale;
      var oz = (Math.random() - 0.5) * 0.6 * scale;
      m.x = px + ox; m.y = py + oy; m.z = pz + oz;

      // launch velocity: outward hemisphere, mostly upward-biased
      var ang  = Math.random() * Math.PI * 2;
      var elv  = Math.random() * Math.PI * 0.65;  // 0..117°
      var spd  = BASE_SPEED + Math.random() * EXTRA_SPEED;
      var vx   = Math.cos(elv) * Math.cos(ang) * spd;
      var vy   = Math.sin(elv) * spd + 2.0;
      var vz   = Math.cos(elv) * Math.sin(ang) * spd;

      // tumble
      var tumble = 4.0 + Math.random() * 8.0;
      var rx = (Math.random() - 0.5) * 2 * tumble;
      var ry = (Math.random() - 0.5) * 2 * tumble;
      var rz = (Math.random() - 0.5) * 2 * tumble;

      var life = LIFE_BASE + Math.random() * LIFE_RAND;
      var rad  = Math.max(sw, Math.max(sh, sd));  // conservative bounding sphere
      var scr  = cr * v; var scg = cg * v; var scb = cb * v;
      shards.push(new Shard(m, mat, m.x, m.y, m.z, vx, vy, vz, rx, ry, rz, life, rad, scr, scg, scb));
    }
  }

  // Build a simple axis-aligned box primitive with the given half-extents
  static function makeShard(w: Float, h: Float, d: Float) : h3d.prim.Polygon {
    var pts : Array<h3d.col.Point> = [];
    var idx  = new hxd.IndexBuffer();

    // 8 corners
    var corners = [
      [-w,-h,-d],[w,-h,-d],[w,h,-d],[-w,h,-d],  // front
      [-w,-h, d],[w,-h, d],[w,h, d],[-w,h, d],   // back
    ];
    for (c in corners) pts.push(new h3d.col.Point(c[0], c[1], c[2]));

    // 6 faces x 2 tris
    var faces = [
      [0,1,2,3], [5,4,7,6],  // -Z, +Z
      [4,0,3,7], [1,5,6,2],  // -X, +X
      [4,5,1,0], [3,2,6,7],  // -Y, +Y
    ];
    for (f in faces) {
      idx.push(f[0]); idx.push(f[1]); idx.push(f[2]);
      idx.push(f[0]); idx.push(f[2]); idx.push(f[3]);
    }

    var prim = new h3d.prim.Polygon(pts, idx);
    // add flat UVs (not needed for opaque shading but required by Heaps)
    var uvs = [];
    for (i in 0...8) uvs.push(new h3d.prim.UV(0, 0));
    prim.uvs = uvs;
    return prim;
  }

  public function update(dt: Float) {
    var alive = 0;
    for (s in shards) {
      if (s.dead) continue;
      s.elapsed += dt;
      if (s.elapsed >= s.life) {
        s.mesh.remove();
        s.dead = true;
        continue;
      }
      alive++;

      // physics
      s.vy += GRAVITY * dt;
      s.x  += s.vx * dt;
      s.y  += s.vy * dt;
      s.z  += s.vz * dt;

      // terrain bounce
      var gy = terrain.getHeight(s.x, s.z);
      if (s.y - s.radius <= gy) {
        s.y  = gy + s.radius;
        s.vy = -s.vy * BOUNCE_Y;
        s.vx *= FRICTION_XZ;
        s.vz *= FRICTION_XZ;
        // kill spin on land
        s.rx *= 0.3; s.ry *= 0.3; s.rz *= 0.3;
        if (!s.landed) { s.landed = true; s.landedAt = s.elapsed; }
      }

      // position
      s.mesh.x = s.x; s.mesh.y = s.y; s.mesh.z = s.z;

      // tumble rotation (simple euler, good enough for debris)
      s.mesh.rotate(s.rx * dt, s.ry * dt, s.rz * dt);

      // grayscale fade starts immediately from spawn
      var gt = s.elapsed / GREY_DUR;
      if (gt > 1.0) gt = 1.0;
      var grey = s.cr * 0.299 + s.cg * 0.587 + s.cb * 0.114;
      s.mat.color.set(
        s.cr + (grey - s.cr) * gt,
        s.cg + (grey - s.cg) * gt,
        s.cb + (grey - s.cb) * gt
      );

      // shrink to zero only after landing
      if (s.landed) {
        var shrinkElapsed = s.elapsed - s.landedAt;
        var ft = 1.0 - shrinkElapsed / SHRINK_DUR;
        var sc = ft < 0.0 ? 0.0 : ft;
        s.mesh.setScale(sc);
        if (sc <= 0.0) { s.mesh.remove(); s.dead = true; continue; }
      }
    }
    if (alive == 0) dead = true;
  }

  public function dispose() {
    for (s in shards) if (!s.dead) s.mesh.remove();
  }
}
