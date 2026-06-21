class EnemyIndicator {

  static inline var MAX_RANGE = 400.0;  // max distance to show indicator
  static inline var MIN_SCALE = 0.3;    // smallest arrow size (far away)
  static inline var MAX_SCALE = 1.5;    // largest arrow size (close up)

  var arrow : h2d.Graphics;
  var s2d   : h2d.Scene;
  var target: BallTarget;

  public function new(s2d: h2d.Scene, target: BallTarget) {
    this.s2d = s2d;
    this.target = target;

    // Create graphics for drawing different shapes
    arrow = new h2d.Graphics(s2d);
    arrow.visible = false;
  }

  public function update(playerPos: h3d.Vector, camera: h3d.Camera, screenWidth: Float, screenHeight: Float, yaw: Float, pitch: Float) {
    if (target.dead) {
      arrow.visible = false;
      return;
    }

    // Add vertical offset based on enemy radius so indicator appears above model
    var yOffset = target.radius * 0.8;
    var dx = target.pos.x - playerPos.x;
    var dy = (target.pos.y + yOffset) - playerPos.y;
    var dz = target.pos.z - playerPos.z;
    var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

    // Hide if too far
    if (dist > MAX_RANGE) {
      arrow.visible = false;
      return;
    }

    // Compute camera basis from yaw/pitch
    var cp = Math.cos(pitch);
    var sp = Math.sin(pitch);
    var cy = Math.cos(yaw);
    var sy = Math.sin(yaw);

    // Forward
    var fx = cp * sy;
    var fy = sp;
    var fz = cp * cy;

    // Right
    var rx = cy;
    var rz = -sy;

    // Up
    var ux = -sp * sy;
    var uy = cp;
    var uz = -sp * cy;

    // Transform offset to camera space
    var cx = dx * rx + dy * 0 + dz * rz;  // right component
    var cy_cam = dx * ux + dy * uy + dz * uz;  // up component
    var cz = dx * fx + dy * fy + dz * fz;  // forward component

    // Check if behind camera
    if (cz < 0.1) {
      arrow.visible = false;
      return;
    }

    // Project to screen coordinates using perspective
    var fovTan = Math.tan(camera.fovY * Math.PI / 360.0);
    var aspect = screenWidth / screenHeight;
    var sx = (cx / cz) / (fovTan * aspect);
    var sy = (cy_cam / cz) / fovTan;

    // Convert to screen pixel coordinates (center is 0,0)
    var screenX = screenWidth * 0.5 + sx * screenWidth * 0.5;
    var screenY = screenHeight * 0.5 - sy * screenHeight * 0.5;  // flip Y

    // Clamp to screen edges
    var margin = 20.0;
    screenX = hxd.Math.clamp(screenX, margin, screenWidth - margin);
    screenY = hxd.Math.clamp(screenY, margin, screenHeight - margin);

    // Scale based on distance (quadratic falloff for natural feel)
    var t = dist / MAX_RANGE;
    var scale = MAX_SCALE * (1.0 - t * t);  // quadratic falloff
    if (scale < MIN_SCALE) scale = MIN_SCALE;

    // Position and scale arrow
    arrow.x = screenX;
    arrow.y = screenY - 20;  // above the target position
    arrow.scaleX = scale;
    arrow.scaleY = scale;
    arrow.visible = true;

    // Clear and redraw shape
    arrow.clear();

    var size = 16.0;

    if (target.scale <= 1.5) {
      // Light: V chevron (pointing down)
      arrow.lineStyle(2, 0x15E5E5);
      arrow.moveTo(-size/2, -size/2);
      arrow.lineTo(0, size/2);
      arrow.lineTo(size/2, -size/2);
    } else if (target.scale <= 2.5) {
      // Medium: V with top line (inverted Y shape)
      arrow.lineStyle(2, 0x40D940);
      arrow.moveTo(-size/2, -size/2);
      arrow.lineTo(0, size/2);
      arrow.lineTo(size/2, -size/2);
      arrow.moveTo(-size/2, -size/2);
      arrow.lineTo(size/2, -size/2);
    } else {
      // Heavy: filled triangle pointing down
      arrow.beginFill(0xFF4040);
      arrow.moveTo(-size/2, -size/2);
      arrow.lineTo(size/2, -size/2);
      arrow.lineTo(0, size/2);
      arrow.lineTo(-size/2, -size/2);
      arrow.endFill();
    }
  }

  public function dispose() {
    arrow.remove();
  }
}
