class JumpDust {

  public var dead : Bool = false;

  var particles : Array<DP> = [];
  var elapsed   : Float = 0.0;

  public function new(s3d: h3d.scene.Scene, pos: h3d.Vector, intensity: Float = 1.0) {
    var count = Std.int(12 * intensity);
    // Spawn dust particles at jump point
    for (i in 0...count) {
      var ang = Math.random() * Math.PI * 2;
      var spd = (1.5 + Math.random() * 3.0) * intensity;
      var sz = (0.15 + Math.random() * 0.25) * intensity;
      
      var sphere = new h3d.prim.Sphere(sz, 4, 4);
      sphere.addUVs(); sphere.addNormals();
      var mat = h3d.mat.Material.create();
      mat.color.set(0.6, 0.55, 0.45);  // brownish dust
      mat.blendMode = h3d.mat.BlendMode.Add;
      mat.mainPass.depthWrite = false;
      
      var m = new h3d.scene.Mesh(sphere, mat, s3d);
      m.x = pos.x + (Math.random()-0.5) * 0.4;
      m.y = pos.y + 0.1;
      m.z = pos.z + (Math.random()-0.5) * 0.4;
      
      particles.push(new DP(m, mat,
        Math.cos(ang) * spd,
        1.0 + Math.random() * 2.0,  // slight upward
        Math.sin(ang) * spd,
        0.4 + Math.random() * 0.3,  // life
        sz
      ));
    }
  }

  public function update(dt: Float) {
    elapsed += dt;
    var alive = 0;
    
    for (p in particles) {
      if (p.dead) continue;
      p.elapsed += dt;
      if (p.elapsed >= p.life) {
        p.mesh.remove();
        p.dead = true;
        continue;
      }
      
      var t = p.elapsed / p.life;
      var ft = 1.0 - t;
      
      p.vy -= 8.0 * dt;  // gravity
      p.mesh.x += p.vx * dt;
      p.mesh.y += p.vy * dt;
      p.mesh.z += p.vz * dt;
      
      // Fade out
      p.mat.color.set(0.6 * ft, 0.55 * ft, 0.45 * ft);
      p.mesh.setScale(p.baseScale * ft);
      
      alive++;
    }
    
    if (alive == 0) dead = true;
  }

  public function dispose() {
    for (p in particles) if (!p.dead) p.mesh.remove();
  }
}

class DP {
  public var mesh : h3d.scene.Mesh;
  public var mat  : h3d.mat.Material;
  public var vx: Float; public var vy: Float; public var vz: Float;
  public var life: Float; public var elapsed: Float = 0;
  public var dead: Bool = false;
  public var baseScale: Float;
  
  public function new(mesh, mat, vx, vy, vz, life, baseScale) {
    this.mesh = mesh; this.mat = mat;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.life = life; this.baseScale = baseScale;
  }
}
