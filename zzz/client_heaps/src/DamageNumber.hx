class DamageNumber {
  
  var text : h2d.Text;
  var age : Float = 0;
  var life : Float = 1.0; // 1 second to display
  public var dead : Bool = false;
  
  var worldPos : h3d.Vector;
  var s3d : h3d.scene.Scene;
  var s2d : h2d.Scene;
  
  public function new(s3d: h3d.scene.Scene, s2d: h2d.Scene, x: Float, y: Float, z: Float, damage: Float) {
    this.s3d = s3d;
    this.s2d = s2d;
    this.worldPos = new h3d.Vector(x, y + 2.5, z); // Start above player head
    
    var font = hxd.res.DefaultFont.get();
    text = new h2d.Text(font, s2d);
    text.text = Std.string(Math.round(damage));
    text.textColor = 0xFF0000; // Red for damage
    text.textAlign = Center;
    text.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    text.setScale(1.5);
  }
  
  public function update(dt: Float) {
    age += dt;
    
    if (age >= life) {
      dead = true;
      text.remove();
      return;
    }
    
    // Float upward
    worldPos.y += 2.0 * dt; // 2 units per second upward
    
    // Project to screen
    var camera = s3d.camera;
    var camDir = new h3d.Vector();
    camDir.x = camera.target.x - camera.pos.x;
    camDir.y = camera.target.y - camera.pos.y;
    camDir.z = camera.target.z - camera.pos.z;
    camDir.normalize();
    
    var camYaw = Math.atan2(camDir.x, camDir.z);
    var camPitch = Math.asin(camDir.y);
    
    var cp = Math.cos(camPitch);
    var sp = Math.sin(camPitch);
    var cy = Math.cos(camYaw);
    var sy = Math.sin(camYaw);
    
    var fx = cp * sy;
    var fy = sp;
    var fz = cp * cy;
    var rx = cy;
    var rz = -sy;
    var ux = -sp * sy;
    var uy = cp;
    var uz = -sp * cy;
    
    var dx = worldPos.x - camera.pos.x;
    var dy = worldPos.y - camera.pos.y;
    var dz = worldPos.z - camera.pos.z;
    
    var cx = dx * rx + dy * ux + dz * rz;
    var cy_cam = dx * ux + dy * uy + dz * uz;
    var cz = dx * fx + dy * fy + dz * fz;
    
    if (cz > 0.1) {
      var fovTan = Math.tan(camera.fovY * Math.PI / 360.0);
      var aspect = s2d.width / s2d.height;
      var sx = (cx / cz) / (fovTan * aspect);
      var sy = (cy_cam / cz) / fovTan;
      
      var screenX = s2d.width * 0.5 + sx * s2d.width * 0.5;
      var screenY = s2d.height * 0.5 - sy * s2d.height * 0.5;
      
      text.x = screenX;
      text.y = screenY;
      text.visible = true;
      
      // Fade out
      var t = age / life;
      text.alpha = 1.0 - t;
    } else {
      text.visible = false;
    }
  }
  
  public function dispose() {
    text.remove();
  }
}
