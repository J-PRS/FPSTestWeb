// 3D mesh fireball blob along the trail
class TrailBlob {
  public var mesh : h3d.scene.Mesh;
  public var mat  : h3d.mat.Material;
  public var age  : Float = 0.0;
  public var life : Float;
  public var dead : Bool = false;
  public var vx: Float; public var vy: Float; public var vz: Float;
  public var sz: Float;
  public function new(mesh, mat, vx, vy, vz, life, sz) {
    this.mesh=mesh; this.mat=mat;
    this.vx=vx; this.vy=vy; this.vz=vz; this.life=life; this.sz=sz;
  }
}

// Billboard glow puff
class TrailPuff {
  public var p   : h3d.parts.Particle;
  public var age : Float = 0.0; public var life: Float;
  public var dead: Bool = false;
  public var vx: Float; public var vy: Float; public var vz: Float;
  public var s0: Float; public var s1: Float;
  public function new(p,vx,vy,vz,life,s0,s1) {
    this.p=p; this.vx=vx; this.vy=vy; this.vz=vz; this.life=life; this.s0=s0; this.s1=s1;
  }
}

// Ember spark (Graphics streak)
class TrailSpark {
  public var x: Float; public var y: Float; public var z: Float;
  public var vx: Float; public var vy: Float; public var vz: Float;
  public var age: Float = 0.0; public var life: Float;
  public var dead: Bool = false;
  public function new(x,y,z,vx,vy,vz,life) {
    this.x=x;this.y=y;this.z=z;this.vx=vx;this.vy=vy;this.vz=vz;this.life=life;
  }
}

class RocketTrail {

  static inline var BLOB_LIFE  = 0.35;
  static inline var PUFF_LIFE  = 0.45;
  static inline var SPARK_LIFE = 0.75;
  static inline var LINE_LEN   = 48;

  public var dead : Bool = false;

  var s3d      : h3d.scene.Scene;

  // Layer A: thick Graphics lines (3 width passes)
  var gCore    : h3d.scene.Graphics;  // bright white-yellow, thin
  var gGlow    : h3d.scene.Graphics;  // orange outer glow, wide
  var gHaze    : h3d.scene.Graphics;  // very wide soft haze

  // Layer B: additive billboard puffs (DISABLED - buffer overflow issue)
  // var psGlow   : h3d.parts.Particles;

  // Layer C: 3D additive mesh blobs (gives real volume)
  var blobs    : Array<TrailBlob>  = [];

  // Layer D: ember sparks
  var sparks   : Array<TrailSpark> = [];
  // var puffs    : Array<TrailPuff>  = [];  // DISABLED with psGlow

  var lineX: Array<Float> = []; var lineY: Array<Float> = [];
  var lineZ: Array<Float> = []; var lineT: Array<Float> = [];
  var lastDt: Float = 0.016;

  public function new(s3d: h3d.scene.Scene) {
    this.s3d = s3d;

    gCore = new h3d.scene.Graphics(s3d);
    gCore.material.props = gCore.material.getDefaultProps("ui");

    gGlow = new h3d.scene.Graphics(s3d);
    gGlow.material.props = gGlow.material.getDefaultProps("ui");

    gHaze = new h3d.scene.Graphics(s3d);
    gHaze.material.props = gHaze.material.getDefaultProps("ui");

    // psGlow disabled due to buffer overflow
    // psGlow = new h3d.parts.Particles(null, s3d);
    // psGlow.material.blendMode = h3d.mat.BlendMode.Add;
    // psGlow.material.mainPass.depthWrite = false;
    // psGlow.hasColor = true;
  }

  public function addPoint(x: Float, y: Float, z: Float, px: Float, py: Float, pz: Float) {
    // Line ring buffer
    lineX.unshift(x); lineY.unshift(y); lineZ.unshift(z); lineT.unshift(0.0);
    if (lineX.length > LINE_LEN) { lineX.pop(); lineY.pop(); lineZ.pop(); lineT.pop(); }

    // Layer C: 3D mesh blob — real volume, additive
    var sphere = new h3d.prim.Sphere(0.28 + Math.random()*0.22, 5, 5);
    sphere.addUVs(); sphere.addNormals();
    var bmat = h3d.mat.Material.create();
    bmat.color.set(1.0, 0.45 + Math.random()*0.3, 0.0);
    bmat.blendMode = h3d.mat.BlendMode.Add;
    bmat.mainPass.depthWrite = false;
    var bm = new h3d.scene.Mesh(sphere, bmat, s3d);
    bm.x = x + (Math.random()-0.5)*0.1;
    bm.y = y + (Math.random()-0.5)*0.1;
    bm.z = z + (Math.random()-0.5)*0.1;
    var bsz = 1.0 + Math.random()*0.8;
    bm.setScale(bsz);
    blobs.push(new TrailBlob(bm, bmat,
      (Math.random()-0.5)*0.3, 0.0, (Math.random()-0.5)*0.3,
      BLOB_LIFE * (0.7 + Math.random()*0.3), bsz));

    // Layer B: billboard puffs DISABLED
    // for (_i in 0...4) { ... }

    // Layer D: embers x6 — tight spray, mostly backward
    var i = 0;
    for (i in 0...6) {
      var spd = 2.0 + Math.random() * 4.0;
      var ang = Math.random() * Math.PI * 2;
      var elv = (Math.random() - 0.5) * Math.PI * 0.25;
      sparks.push(new TrailSpark(
        x, y, z,
        spd*Math.cos(elv)*Math.sin(ang)*0.4,
        spd*Math.sin(elv),
        spd*Math.cos(elv)*Math.cos(ang)*0.4,
        SPARK_LIFE * (0.35 + Math.random()*0.65)));
    }
  }

  public function update(dt: Float) {
    lastDt = dt;
    for (i in 0...lineT.length) lineT[i] += dt;

    // Blobs
    var i = blobs.length;
    while (--i >= 0) {
      var b = blobs[i];
      b.age += dt;
      if (b.age >= b.life) { b.mesh.remove(); b.dead = true; blobs.splice(i,1); continue; }
      var t  = b.age / b.life;
      var ft = 1.0 - t;
      b.mesh.x += b.vx * dt; b.mesh.y += b.vy * dt; b.mesh.z += b.vz * dt;
      var scl = b.sz * (t < 0.15 ? t/0.15 : ft * ft);
      b.mesh.setScale(scl < 0.01 ? 0.01 : scl);
      b.mat.color.set(1.0, 0.5 - 0.4*t, 0.0);
    }

    // Billboard puffs DISABLED
    // var j = puffs.length; ...

    // Sparks
    var k = sparks.length;
    while (--k >= 0) {
      var s = sparks[k];
      s.age += dt;
      if (s.age >= s.life) { sparks.splice(k,1); continue; }
      // no gravity on trail sparks
      s.x += s.vx*dt; s.y += s.vy*dt; s.z += s.vz*dt;
    }

    redrawLines();

    if (blobs.length==0 && sparks.length==0 && lineX.length==0) dead = true;
  }

  function redrawLines() {
    gCore.clear(); gGlow.clear(); gHaze.clear();
    var n = lineX.length;
    if (n >= 2) {
      for (i in 1...n) {
        var t = 1.0 - lineT[i] / PUFF_LIFE;
        if (t <= 0) continue;
        var gi  = Std.int((0.75 + 0.25*t) * 255);
        // Pass 1: hot white core
        gCore.lineStyle(5.0 * t, (0xFF << 16) | (gi << 8) | Std.int(0.25*t*255), t);
        gCore.moveTo(lineX[i-1],lineY[i-1],lineZ[i-1]);
        gCore.lineTo(lineX[i],lineY[i],lineZ[i]);
        // Pass 2: orange glow
        var gi2 = Std.int(0.38*t*255);
        gGlow.lineStyle(11.0 * t, (0xFF << 16) | (gi2 << 8), t * 0.55);
        gGlow.moveTo(lineX[i-1],lineY[i-1],lineZ[i-1]);
        gGlow.lineTo(lineX[i],lineY[i],lineZ[i]);
        // Pass 3: wide soft haze
        gHaze.lineStyle(20.0 * t, 0xFF4400, t * 0.18);
        gHaze.moveTo(lineX[i-1],lineY[i-1],lineZ[i-1]);
        gHaze.lineTo(lineX[i],lineY[i],lineZ[i]);
      }
      while (lineT.length > 0 && lineT[lineT.length-1] > PUFF_LIFE) {
        lineX.pop(); lineY.pop(); lineZ.pop(); lineT.pop();
      }
    }

    // Ember streaks on gCore
    for (s in sparks) {
      var t   = 1.0 - s.age / s.life;
      var hot = t > 0.5 ? 1.0 : t * 2.0;
      var gi  = Std.int(hot * 0.5 * 255);
      gCore.lineStyle(2.0 * t, (0xFF << 16) | (gi << 8), t);
      gCore.moveTo(s.x - s.vx*lastDt*5, s.y - s.vy*lastDt*5, s.z - s.vz*lastDt*5);
      gCore.lineTo(s.x, s.y, s.z);
    }
  }

  public function dispose() {
    gCore.remove(); gGlow.remove(); gHaze.remove();
    // psGlow.remove();  // DISABLED
    for (b in blobs) b.mesh.remove();
  }
}
