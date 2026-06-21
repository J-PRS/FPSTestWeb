class Sky {

  var mesh   : h3d.scene.Mesh;
  var shader : SkyShader;

  public function new(s3d: h3d.scene.Scene) {
    var sphere = new h3d.prim.Sphere(1, 32, 16);
    sphere.addNormals();

    shader = new SkyShader();
    shader.sunDir = new h3d.Vector(0.4, 1.0, 0.6).normalized();

    var mat = h3d.mat.Material.create();
    mat.props = mat.getDefaultProps("ui");
    mat.mainPass.depthWrite = false;
    mat.mainPass.depthTest  = h3d.mat.Data.Compare.Always;
    mat.mainPass.culling    = h3d.mat.Data.Face.Back;
    mat.mainPass.addShader(shader);

    mesh = new h3d.scene.Mesh(sphere, mat, s3d);
    mesh.material.mainPass.layer = -1;
  }

  public function update(camera: h3d.Camera) {
    // Center skybox on camera
    mesh.x = camera.pos.x;
    mesh.y = camera.pos.y;
    mesh.z = camera.pos.z;
    mesh.setScale(4000);
    shader.cameraPos.set(camera.pos.x, camera.pos.y, camera.pos.z);
  }
}
