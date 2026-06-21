class JetpackParticles {

  public var dead : Bool = false;

  var particles : Array<JP> = [];
  var elapsed   : Float = 0.0;
  var ox: Float; var oy: Float; var oz: Float;

  public function new(s3d: h3d.scene.Scene, pos: h3d.Vector) {
    ox = pos.x; oy = pos.y; oz = pos.z;
    
    // Spawn initial burst of blue particles
    for (i in 0...8) {
      spawnParticle(s3d, pos);
    }
  }
  
  function spawnParticle(s3d: h3d.scene.Scene, pos: h3d.Vector) {
    var ang = Math.random() * Math.PI * 2;
    var spd = 2.0 + Math.random() * 4.0;
    var sz = 0.08 + Math.random() * 0.15;
    
    var sphere = new h3d.prim.Sphere(sz, 4, 4);
    sphere.addUVs(); sphere.addNormals();
    var mat = h3d.mat.Material.create();
    // Bluish color
    var blue = 0.5 + Math.random() * 0.3;
    var green = 0.6 + Math.random() * 0.2;
    mat.color.set(0.3, green, blue);
    mat.blendMode = h3d.mat.BlendMode.Add;
    mat.mainPass.depthWrite = false;
    
    var m = new h3d.scene.Mesh(sphere, mat, s3d);
    m.x = pos.x + (Math.random()-0.5) * 0.3;
    m.y = pos.y - 0.5;  // below player
    m.z = pos.z + (Math.random()-0.5) * 0.3;
    
    particles.push(new JP(m, mat,
      Math.cos(ang) * spd,
      -3.0 - Math.random() * 2.0,  // downward
      Math.sin(ang) * spd,
      0.8 + Math.random() * 0.4,  // 0.8-1.2s life
      sz
    ));
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
      
      p.vy -= 5.0 * dt;  // gravity
      p.mesh.x += p.vx * dt;
      p.mesh.y += p.vy * dt;
      p.mesh.z += p.vz * dt;
      
      // Fade out
      var blue = ft * 0.8;
      var green = ft * 0.7;
      p.mat.color.set(0.3 * ft, green, blue);
      p.mesh.setScale(p.baseScale * ft);
      
      alive++;
    }
    
    if (alive == 0) dead = true;
  }

  public function dispose() {
    for (p in particles) if (!p.dead) p.mesh.remove();
  }
}

class JP {
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
