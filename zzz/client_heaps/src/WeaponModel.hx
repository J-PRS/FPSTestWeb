class WeaponModel {

  // Viewmodel offset from camera (bottom-right of screen, Quake style)
  static inline var OFFSET_X =  0.28;
  static inline var OFFSET_Y = -0.22;
  static inline var OFFSET_Z =  0.0;

  // Recoil animation
  static inline var RECOIL_KICK   = 0.15;  // backward distance
  static inline var RECOIL_UP     = 0.04;  // upward kick
  static inline var RECOIL_TIME   = 0.08;  // seconds to full recoil
  static inline var RECOVER_TIME  = 0.35;  // seconds to recover
  static inline var MUZZLE_FLASH_TIME = 0.06;

  // Bob animation
  static inline var BOB_SPEED  = 8.0;
  static inline var BOB_AMOUNT = 0.012;

  // Sway (lazy follow on mouse look)
  static inline var SWAY_AMOUNT  = 0.025;  // how far weapon lags behind
  static inline var SWAY_SMOOTH  = 8.0;    // lerp speed to catch up
  static inline var PITCH_TILT   = 0.015;  // weapon drops/rises with look (subtle)

  // FOV independence: weapon is authored for this FOV
  static inline var VIEWMODEL_FOV = 65.0;

  var root : h3d.scene.Object;
  var s3d  : h3d.scene.Scene;

  // Sub-parts for animation
  var barrel      : h3d.scene.Mesh;
  var muzzleFlash : h3d.scene.Mesh;

  var recoilTimer : Float = 0.0;
  var recoilPhase : Int = 0;  // 0=idle, 1=recoiling, 2=recovering
  var bobTimer    : Float = 0.0;
  var prevYaw     : Float = 0.0;
  var prevPitch   : Float = 0.0;
  var swayX       : Float = 0.0;  // current horizontal sway offset
  var swayY       : Float = 0.0;  // current vertical sway offset

  public function new(s3d: h3d.scene.Scene) {
    this.s3d = s3d;
    root = new h3d.scene.Object(s3d);

    // === Build procedural rocket launcher ===

    // --- Main body: dark grey rectangular box ---
    var bodyPrim = new h3d.prim.Cube(0.08, 0.07, 0.38);
    bodyPrim.translate(-0.04, -0.035, -0.05);
    bodyPrim.addNormals();
    var bodyMat = h3d.mat.Material.create();
    bodyMat.color.set(0.25, 0.25, 0.28);
    bodyMat.props = bodyMat.getDefaultProps("default");
    var body = new h3d.scene.Mesh(bodyPrim, bodyMat, root);

    // --- Barrel: cylinder (long tube) using stretched sphere approx ---
    var barrelPrim = new h3d.prim.Cylinder(12, 0.032, 0.40);
    barrelPrim.addNormals();
    barrel = new h3d.scene.Mesh(barrelPrim, null, root);
    var barrelMat = h3d.mat.Material.create();
    barrelMat.color.set(0.35, 0.35, 0.38);
    barrelMat.props = barrelMat.getDefaultProps("default");
    barrel.material = barrelMat;
    barrel.x = 0.0;
    barrel.y = 0.012;
    barrel.z = -0.02;

    // --- Second barrel (top tube) ---
    var barrel2Prim = new h3d.prim.Cylinder(12, 0.025, 0.35);
    barrel2Prim.addNormals();
    var barrel2 = new h3d.scene.Mesh(barrel2Prim, null, root);
    var barrel2Mat = h3d.mat.Material.create();
    barrel2Mat.color.set(0.3, 0.3, 0.33);
    barrel2Mat.props = barrel2Mat.getDefaultProps("default");
    barrel2.material = barrel2Mat;
    barrel2.x = 0.0;
    barrel2.y = 0.035;
    barrel2.z = 0.0;

    // --- Grip/handle: thin vertical box below body ---
    var gripPrim = new h3d.prim.Cube(0.04, 0.10, 0.05);
    gripPrim.translate(-0.02, -0.10, 0.10);
    gripPrim.addNormals();
    var gripMat = h3d.mat.Material.create();
    gripMat.color.set(0.18, 0.18, 0.20);
    gripMat.props = gripMat.getDefaultProps("default");
    var grip = new h3d.scene.Mesh(gripPrim, gripMat, root);

    // --- Exhaust cone at back: wider cylinder ---
    var exhaustPrim = new h3d.prim.Cylinder(10, 0.05, 0.06);
    exhaustPrim.addNormals();
    var exhaust = new h3d.scene.Mesh(exhaustPrim, null, root);
    var exhaustMat = h3d.mat.Material.create();
    exhaustMat.color.set(0.20, 0.20, 0.22);
    exhaustMat.props = exhaustMat.getDefaultProps("default");
    exhaust.material = exhaustMat;
    exhaust.x = 0.0;
    exhaust.y = 0.012;
    exhaust.z = -0.07;

    // --- Front nozzle ring ---
    var nozzlePrim = new h3d.prim.Cylinder(10, 0.04, 0.03);
    nozzlePrim.addNormals();
    var nozzle = new h3d.scene.Mesh(nozzlePrim, null, root);
    var nozzleMat = h3d.mat.Material.create();
    nozzleMat.color.set(0.15, 0.15, 0.17);
    nozzleMat.props = nozzleMat.getDefaultProps("default");
    nozzle.material = nozzleMat;
    nozzle.x = 0.0;
    nozzle.y = 0.012;
    nozzle.z = 0.35;

    // --- Red accent stripe on body ---
    var stripePrim = new h3d.prim.Cube(0.085, 0.015, 0.12);
    stripePrim.translate(-0.0425, -0.005, 0.08);
    stripePrim.addNormals();
    var stripeMat = h3d.mat.Material.create();
    stripeMat.color.set(0.8, 0.15, 0.05);
    stripeMat.props = stripeMat.getDefaultProps("default");
    var stripe = new h3d.scene.Mesh(stripePrim, stripeMat, root);

    // --- Muzzle flash (additive, hidden by default) ---
    var flashPrim = new h3d.prim.Sphere(0.08, 6, 6);
    flashPrim.addNormals();
    var flashMat = h3d.mat.Material.create();
    flashMat.color.set(1.0, 0.7, 0.2);
    flashMat.blendMode = h3d.mat.BlendMode.Add;
    flashMat.mainPass.depthWrite = false;
    muzzleFlash = new h3d.scene.Mesh(flashPrim, flashMat, root);
    muzzleFlash.x = 0.0;
    muzzleFlash.y = 0.012;
    muzzleFlash.z = 0.42;
    muzzleFlash.visible = false;

    // Scale the whole weapon
    root.setScale(1.0);
  }

  public function fire() {
    recoilTimer = 0.0;
    recoilPhase = 1;
    muzzleFlash.visible = true;
  }

  public function update(dt: Float, camera: h3d.Camera, yaw: Float, pitch: Float, speed: Float) {
    // Bob when moving
    if (speed > 1.0) {
      bobTimer += dt * BOB_SPEED;
    } else {
      bobTimer *= 0.9;  // settle
    }
    var bobX = Math.sin(bobTimer) * BOB_AMOUNT;
    var bobY = Math.sin(bobTimer * 2.0) * BOB_AMOUNT * 0.5;

    // Mouse-look sway (weapon lags behind mouse movement)
    var dyaw = yaw - prevYaw;
    var dpitch = pitch - prevPitch;
    if (dyaw > 3.0) dyaw = 0.0;
    if (dyaw < -3.0) dyaw = 0.0;
    if (dpitch > 3.0) dpitch = 0.0;
    if (dpitch < -3.0) dpitch = 0.0;
    var idt = dt > 0.001 ? dt : 0.016;
    var targetSwayX = -dyaw * SWAY_AMOUNT / idt;
    var targetSwayY = -dpitch * SWAY_AMOUNT / idt;
    if (targetSwayX > 0.06) targetSwayX = 0.06;
    if (targetSwayX < -0.06) targetSwayX = -0.06;
    if (targetSwayY > 0.04) targetSwayY = 0.04;
    if (targetSwayY < -0.04) targetSwayY = -0.04;
    var lerpFactor = 1.0 - Math.exp(-SWAY_SMOOTH * dt);
    swayX += (targetSwayX - swayX) * lerpFactor;
    swayY += (targetSwayY - swayY) * lerpFactor;
    prevYaw = yaw;
    prevPitch = pitch;

    var pitchOffset = -pitch * PITCH_TILT;

    // Recoil animation
    var recoilZ = 0.0;
    var recoilY = 0.0;
    if (recoilPhase == 1) {
      recoilTimer += dt;
      var t = recoilTimer / RECOIL_TIME;
      if (t >= 1.0) { t = 1.0; recoilPhase = 2; recoilTimer = 0.0; }
      recoilZ = -RECOIL_KICK * t;
      recoilY = RECOIL_UP * t;
    } else if (recoilPhase == 2) {
      recoilTimer += dt;
      var t = recoilTimer / RECOVER_TIME;
      if (t >= 1.0) { t = 1.0; recoilPhase = 0; }
      var ft = 1.0 - t;
      recoilZ = -RECOIL_KICK * ft * ft;
      recoilY = RECOIL_UP * ft * ft;
    }

    // Muzzle flash timing
    if (recoilPhase >= 1) {
      var totalTime = (recoilPhase == 1) ? recoilTimer : RECOIL_TIME + recoilTimer;
      muzzleFlash.visible = totalTime < MUZZLE_FLASH_TIME;
      if (muzzleFlash.visible) muzzleFlash.setScale(1.0 + Math.random() * 0.5);
    } else {
      muzzleFlash.visible = false;
    }

    // Compute camera basis from yaw/pitch
    var cp = Math.cos(pitch);
    var sp = Math.sin(pitch);
    var cy = Math.cos(yaw);
    var sy = Math.sin(yaw);

    // Forward (same as Player.getCameraDir)
    var fx = cp * sy;
    var fy = sp;
    var fz = cp * cy;

    // Right = normalize(cross(forward, worldUp))
    var rx = cy;
    var rz = -sy;
    // ry = 0 always for yaw/pitch camera

    // Up = cross(forward, right)
    var ux = -sp * sy;
    var uy = cp;
    var uz = -sp * cy;

    var camPos = camera.pos;

    // FOV compensation: scale offsets so weapon looks the same at any FOV
    var fovScale = Math.tan(VIEWMODEL_FOV * Math.PI / 360.0) / Math.tan(camera.fovY * Math.PI / 360.0);

    // Anti-clip: gentle push at extreme pitch angles only
    var absPitch = pitch < 0 ? -pitch : pitch;
    var clipPush = absPitch > 0.8 ? (absPitch - 0.8) * 0.1 : 0.0;
    var clipDrop = absPitch > 0.8 ? (absPitch - 0.8) * 0.05 : 0.0;

    // Local offsets
    var ox = (OFFSET_X + bobX + swayX) * fovScale;
    var oy = (OFFSET_Y + bobY + recoilY + swayY + pitchOffset - clipDrop) * fovScale;
    var oz = (OFFSET_Z + recoilZ + clipPush) * fovScale;

    root.x = camPos.x + rx * ox + ux * oy + fx * oz;
    root.y = camPos.y +           uy * oy + fy * oz;
    root.z = camPos.z + rz * ox + uz * oy + fz * oz;

    // Scale weapon model to compensate for FOV
    root.setScale(fovScale);

    // Orient weapon along camera forward
    root.setRotation(-pitch, yaw, 0);
  }

  public function setVisible(v: Bool) {
    root.visible = v;
  }

  public function dispose() {
    root.remove();
  }
}
