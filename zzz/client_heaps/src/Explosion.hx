class EP {
  public var mesh : h3d.scene.Mesh;
  public var mat  : h3d.mat.Material;
  public var vx: Float; public var vy: Float; public var vz: Float;
  public var life: Float; public var elapsed: Float = 0;
  public var dead: Bool = false;
  public var baseScale: Float;
  public var gravity: Float;
  public var r1: Float; public var g1: Float; public var b1: Float;
  public var r2: Float; public var g2: Float; public var b2: Float;
  public function new(mesh, mat, vx, vy, vz, life, baseScale, gravity, r1, g1, b1, r2, g2, b2) {
    this.mesh=mesh; this.mat=mat;
    this.vx=vx; this.vy=vy; this.vz=vz; this.life=life;
    this.baseScale=baseScale; this.gravity=gravity;
    this.r1=r1; this.g1=g1; this.b1=b1;
    this.r2=r2; this.g2=g2; this.b2=b2;
  }
}

class Explosion {

  public var dead : Bool = false;

  var particles : Array<EP>           = [];
  var gfx       : h3d.scene.Graphics;
  var elapsed   : Float = 0.0;
  var ox: Float; var oy: Float; var oz: Float;

  static inline var SHOCK_LIFE = 0.25;
  static inline var FLASH_LIFE = 0.09;

  public function new(s3d: h3d.scene.Scene, pos: h3d.Vector) {
    ox = pos.x; oy = pos.y; oz = pos.z;

    gfx = new h3d.scene.Graphics(s3d);
    gfx.material.props = gfx.material.getDefaultProps("ui");

    // Layer 1: Flash — white-yellow, very large, very short, additive
    for (i in 0...20) {
      var ang = Math.random() * Math.PI * 2;
      var elv = (Math.random() - 0.4) * Math.PI * 0.5;
      var spd = 3.0 + Math.random() * 8.0;
      spawn(s3d, pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+3, spd*Math.cos(elv)*Math.cos(ang),
        0.16 + Math.random()*0.08,
        1.8 + Math.random()*1.4,
        -3.0,
        1.0, 1.0, 0.85,
        1.0, 0.6, 0.0,
        true);
    }

    // Layer 2: Fireball core — orange spheres, medium, additive → glow accumulates
    for (i in 0...65) {
      var ang = Math.random() * Math.PI * 2;
      var elv = (Math.random() - 0.25) * Math.PI;
      var spd = 7.0 + Math.random() * 28.0;
      spawn(s3d, pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+8, spd*Math.cos(elv)*Math.cos(ang),
        0.40 + Math.random()*0.30,
        0.35 + Math.random()*0.65,
        -18.0,
        1.0, 0.4+Math.random()*0.35, 0.0,
        0.55, 0.02, 0.0,
        true);
    }

    // Layer 3: Debris — fast chunks, orange→brown, alpha (solid looking)
    for (i in 0...32) {
      var ang = Math.random() * Math.PI * 2;
      var elv = (Math.random() - 0.2) * Math.PI * 0.75;
      var spd = 16.0 + Math.random() * 40.0;
      spawn(s3d, pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+14, spd*Math.cos(elv)*Math.cos(ang),
        0.30 + Math.random()*0.35,
        0.09 + Math.random()*0.15,
        -32.0,
        1.0, 0.3+Math.random()*0.2, 0.0,
        0.12, 0.05, 0.01,
        false);
    }

    // Layer 4: Embers — tiny, long life, fast, additive orange→dark
    for (i in 0...80) {
      var ang = Math.random() * Math.PI * 2;
      var elv = (Math.random() - 0.3) * Math.PI;
      var spd = 8.0 + Math.random() * 35.0;
      spawn(s3d, pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+6, spd*Math.cos(elv)*Math.cos(ang),
        0.7 + Math.random()*0.8,
        0.05 + Math.random()*0.10,
        -14.0,
        1.0, 0.5+Math.random()*0.3, 0.0,
        0.2, 0.0, 0.0,
        true);
    }

    // Layer 5: Smoke — slow, rising, grey, alpha (non-additive for dark contrast)
    for (i in 0...6) {
      var ang = Math.random() * Math.PI * 2;
      var spd = 1.0 + Math.random() * 4.0;
      spawn(s3d, pos,
        spd*Math.sin(ang)+(Math.random()-0.5), 2.5+Math.random()*4.0, spd*Math.cos(ang)+(Math.random()-0.5),
        0.7 + Math.random()*0.4,
        0.28 + Math.random()*0.35,
        -1.0,
        0.22, 0.20, 0.18,
        0.06, 0.06, 0.06,
        false);
    }
  }

  function spawn(s3d: h3d.scene.Scene, pos: h3d.Vector,
    vx: Float, vy: Float, vz: Float,
    life: Float, sz: Float, gravity: Float,
    r1: Float, g1: Float, b1: Float,
    r2: Float, g2: Float, b2: Float,
    additive: Bool
  ) {
    var sphere = new h3d.prim.Sphere(sz, 5, 5);
    sphere.addUVs(); sphere.addNormals();
    var mat = h3d.mat.Material.create();
    mat.color.set(r1, g1, b1);
    if (additive) {
      mat.blendMode = h3d.mat.BlendMode.Add;
      mat.mainPass.depthWrite = false;
    } else {
      mat.props = mat.getDefaultProps("default");
    }
    var m = new h3d.scene.Mesh(sphere, mat, s3d);
    m.x = pos.x + (Math.random()-0.5)*0.5;
    m.y = pos.y + (Math.random()-0.5)*0.5;
    m.z = pos.z + (Math.random()-0.5)*0.5;
    particles.push(new EP(m, mat, vx, vy, vz, life, sz, gravity, r1, g1, b1, r2, g2, b2));
  }

  public function update(dt: Float) {
    elapsed += dt;

    var alive = 0;
    for (p in particles) {
      if (p.dead) continue;
      p.elapsed += dt;
      if (p.elapsed >= p.life) { p.mesh.remove(); p.dead = true; continue; }
      var t  = p.elapsed / p.life;
      var ft = 1.0 - t;
      p.vy += p.gravity * dt;
      p.mesh.x += p.vx * dt;
      p.mesh.y += p.vy * dt;
      p.mesh.z += p.vz * dt;
      // grow briefly then shrink
      var scl = p.baseScale * (t < 0.12 ? t/0.12 : ft);
      p.mesh.setScale(scl < 0.01 ? 0.01 : scl);
      p.mat.color.set(
        p.r1 + (p.r2 - p.r1) * t,
        p.g1 + (p.g2 - p.g1) * t,
        p.b1 + (p.b2 - p.b1) * t
      );
      alive++;
    }

    // Shockwave rings
    gfx.clear();
    if (elapsed < SHOCK_LIFE) {
      var st = elapsed / SHOCK_LIFE;
      var ft = 1.0 - st;
      var segs = 36;
      // outer ring orange
      var rad = 32.0 * st;
      var a   = Std.int(ft * 220);
      var gi  = Std.int(0.35 * ft * 255);
      var col = (a << 24) | (0xFF << 16) | (gi << 8);
      for (i in 0...segs) {
        var a1 = i / segs * Math.PI * 2;
        var a2 = (i+1) / segs * Math.PI * 2;
        gfx.lineStyle(8.0 * ft, col, ft);
        gfx.moveTo(ox + Math.cos(a1)*rad, oy+0.2, oz + Math.sin(a1)*rad);
        gfx.lineTo(ox + Math.cos(a2)*rad, oy+0.2, oz + Math.sin(a2)*rad);
      }
      // inner ring yellow
      var rad2 = 20.0 * st;
      var col2 = (a << 24) | 0xFFEE00;
      for (i in 0...segs) {
        var a1 = i / segs * Math.PI * 2;
        var a2 = (i+1) / segs * Math.PI * 2;
        gfx.lineStyle(3.0 * ft, col2, ft * 0.7);
        gfx.moveTo(ox + Math.cos(a1)*rad2, oy+0.2, oz + Math.sin(a1)*rad2);
        gfx.lineTo(ox + Math.cos(a2)*rad2, oy+0.2, oz + Math.sin(a2)*rad2);
      }
    }
    // Flash ring
    if (elapsed < FLASH_LIFE) {
      var ft  = 1.0 - elapsed / FLASH_LIFE;
      var rad = 10.0 * (1.0 - ft);
      var a   = Std.int(ft * 230);
      var col = (a << 24) | 0xFFFFCC;
      var segs = 24;
      for (i in 0...segs) {
        var a1 = i / segs * Math.PI * 2;
        var a2 = (i+1) / segs * Math.PI * 2;
        gfx.lineStyle(7.0 * ft, col, ft);
        gfx.moveTo(ox + Math.cos(a1)*rad, oy, oz + Math.sin(a1)*rad);
        gfx.lineTo(ox + Math.cos(a2)*rad, oy, oz + Math.sin(a2)*rad);
      }
    }

    if (alive == 0 && elapsed > SHOCK_LIFE) dead = true;
  }

  public function dispose() {
    for (p in particles) if (!p.dead) p.mesh.remove();
    gfx.remove();
  }
}
