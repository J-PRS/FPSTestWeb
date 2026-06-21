class Terrain {

  static inline var SIZE   : Float = 500.0;
  static inline var SUBDIV : Int   = 100;
  static inline var STEP   : Float = 5.0;
  static inline var HSCALE : Float = 125.0;
  static inline var NSCALE : Float = 0.0015;

  // --- Heightmap mode ---
  // Set to true to use image heightmap instead of procedural noise.
  // The heightmap tiles seamlessly (coordinates are wrapped).
  static inline var USE_HEIGHTMAP : Bool = true;
  // World units the heightmap covers before tiling (tune to match desired feature scale)
  static inline var HM_WORLD_SCALE : Float = 1500.0;

  static var hmPixels : hxd.Pixels = null;  // loaded once, reused by all sampleHeight calls
  static var hmSize   : Int = 0;

  var s3d : h3d.scene.Scene;

  var tiles    : Array<Array<TileData>>;
  var centerTX : Int = 0;
  var centerTZ : Int = 0;

  public var shader : TerrainShader;

  public function new(s3d: h3d.scene.Scene) {
    this.s3d = s3d;
    shader = new TerrainShader();
    if (USE_HEIGHTMAP) initHeightmap();
    tiles = [];
    for (tz in 0...3) {
      tiles.push([]);
      for (tx in 0...3) {
        tiles[tz].push(buildTile(tx - 1, tz - 1));
      }
    }
    debugSeams();
  }

  // Raw 16-bit pixel bytes (R16U = 2 bytes per pixel, little-endian)
  static var hmBytes  : haxe.io.Bytes = null;

  // Load heightmap pixels synchronously from the embedded asset
  static function initHeightmap() {
    var bmp = hxd.Res.load("heightmaps/Vortex_Smooth2_2048.png").toImage();
    hmPixels = bmp.getPixels();   // keep native R16U format
    hmBytes  = hmPixels.bytes;
    hmSize   = hmPixels.width;
  }

  // Read one R16U pixel as 0..1 float directly from raw bytes
  static inline function hmSample(x: Int, z: Int) : Float {
    var idx = (z * hmSize + x) * 2;        // 2 bytes per R16U pixel
    var lo  = hmBytes.get(idx);
    var hi  = hmBytes.get(idx + 1);
    return ((hi << 8) | lo) / 65535.0;     // little-endian uint16 → 0..1
  }

  // Bilinear sample of heightmap, tiling via modulo wrap
  static function sampleHeightmap(wx: Float, wz: Float) : Float {
    var u  = ((wx / HM_WORLD_SCALE) % 1.0 + 1.0) % 1.0 * hmSize;
    var v  = ((wz / HM_WORLD_SCALE) % 1.0 + 1.0) % 1.0 * hmSize;
    var x0 = Std.int(u) % hmSize;
    var z0 = Std.int(v) % hmSize;
    var x1 = (x0 + 1) % hmSize;
    var z1 = (z0 + 1) % hmSize;
    var fx = u - Math.floor(u);
    var fz = v - Math.floor(v);
    var h  = hmSample(x0,z0)*(1-fx)*(1-fz) + hmSample(x1,z0)*fx*(1-fz)
           + hmSample(x0,z1)*(1-fx)*fz     + hmSample(x1,z1)*fx*fz;
    return h * HSCALE;
  }

  // Call every frame with player world position so we can shift the grid
  public function update(px: Float, pz: Float) {
    var ptx = Math.floor(px / SIZE + 0.5);
    var ptz = Math.floor(pz / SIZE + 0.5);
    var dx = ptx - centerTX;
    var dz = ptz - centerTZ;
    if (dx == 0 && dz == 0) return;

    centerTX += dx;
    centerTZ += dz;

    // Rebuild all 9 tiles around new centre (simple approach — only 9 meshes total,
    // rebuild is fast enough; a real engine would recycle the 3 non-shifted rows)
    for (tz in 0...3) {
      for (tx in 0...3) {
        var old = tiles[tz][tx];
        old.mesh.remove();
        var worldTX = centerTX + (tx - 1);
        var worldTZ = centerTZ + (tz - 1);
        tiles[tz][tx] = buildTile(worldTX, worldTZ);
      }
    }
  }

  // --- Noise primitives ---

  static function hash(x: Float, y: Float) : Float {
    var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  static function valueNoise(x: Float, y: Float) : Float {
    var ix = Math.floor(x); var iy = Math.floor(y);
    var fx = x - ix;        var fy = y - iy;
    var ux = fx * fx * (3.0 - 2.0 * fx);
    var uy = fy * fy * (3.0 - 2.0 * fy);
    var a = hash(ix,     iy    );
    var b = hash(ix+1.0, iy    );
    var c = hash(ix,     iy+1.0);
    var d = hash(ix+1.0, iy+1.0);
    return a + (b-a)*ux + (c-a)*uy + (b-a+a-b+d-c)*ux*uy;
  }

  static function fbm(x: Float, y: Float, octaves: Int) : Float {
    var v = 0.0; var amp = 0.5; var freq = 1.0;
    for (_ in 0...octaves) {
      v    += valueNoise(x * freq, y * freq) * amp;
      freq *= 2.0;
      amp  *= 0.5;
    }
    return v;
  }

  static function ridgedFbm(x: Float, y: Float, octaves: Int) : Float {
    var v = 0.0; var amp = 0.5; var freq = 1.0;
    for (_ in 0...octaves) {
      var n = valueNoise(x * freq, y * freq) * 2.0 - 1.0;
      v    += (1.0 - Math.abs(n)) * amp;
      freq *= 2.1;
      amp  *= 0.48;
    }
    return v;
  }

  // Compute height at an arbitrary world position (used for collision + spawning)
  public static function sampleHeight(wx: Float, wz: Float) : Float {
    if (USE_HEIGHTMAP) return sampleHeightmap(wx, wz);
    return sampleHeightProc(wx, wz);
  }

  // Procedural fBm height (used when USE_HEIGHTMAP = false)
  static function sampleHeightProc(wx: Float, wz: Float) : Float {
    var nx = wx * NSCALE;
    var nz = wz * NSCALE;
    var height = fbm(nx, nz, 4);
    height = (height - 0.06) / 0.88;
    height = Math.pow(Math.max(0.0, height), 0.6);
    return height * HSCALE;
  }

  // Build one tile mesh at integer tile offset (tileX, tileZ)
  function buildTile(tileX: Int, tileZ: Int) : TileData {
    var n      = SUBDIV + 1;
    var pts    : Array<h3d.col.Point> = [];
    var uvs    : Array<h3d.prim.UV>   = [];
    var idxArr : Array<Int>            = [];
    var heights: Array<Float>          = [];

    // wx/wz = integer grid index * STEP (5.0). Both tiles sharing an edge compute
    // the same integer index, so wx is bit-identical — zero seam gap possible.
    var cornerX : Int = tileX * SUBDIV - Std.int(SUBDIV / 2);
    var cornerZ : Int = tileZ * SUBDIV - Std.int(SUBDIV / 2);

    for (iz in 0...n) {
      for (ix in 0...n) {
        var wx : Float = (cornerX + ix) * STEP;
        var wz : Float = (cornerZ + iz) * STEP;
        var wy = sampleHeight(wx, wz);
        heights.push(wy);
        pts.push(new h3d.col.Point(wx, wy, wz));
        uvs.push(new h3d.prim.UV(ix / SUBDIV * 8, iz / SUBDIV * 8));
      }
    }

    for (iz in 0...SUBDIV) {
      for (ix in 0...SUBDIV) {
        var i = iz * n + ix;
        idxArr.push(i);     idxArr.push(i + n);     idxArr.push(i + 1);
        idxArr.push(i + 1); idxArr.push(i + n);     idxArr.push(i + n + 1);
      }
    }

    var idx  = new hxd.IndexBuffer();
    for (v in idxArr) idx.push(v);
    var prim = new h3d.prim.Polygon(pts, idx);
    prim.uvs = uvs;
    prim.addNormals();

    var mat = h3d.mat.Material.create();
    mat.props = mat.getDefaultProps("default");
    mat.mainPass.culling = h3d.mat.Data.Face.None;
    mat.mainPass.addShader(shader);

    var mesh = new h3d.scene.Mesh(prim, mat, s3d);
    return { mesh: mesh, heights: heights, originX: cornerX * (SIZE / SUBDIV), originZ: cornerZ * (SIZE / SUBDIV) };
  }

  // Get interpolated height at any world position — finds the right tile
  public function getHeight(wx: Float, wz: Float) : Float {
    return sampleHeight(wx, wz);
  }

  // Runtime seam + quality diagnostics — logs to browser console
  public function debugSeams() {
    // 1. Seam test: compare stored vertex heights at shared edges in the height arrays.
    //    heights[] is row-major: index = iz*(SUBDIV+1)+ix
    var n = SUBDIV + 1;
    var maxSeamErr = 0.0;
    var seamFails  = 0;
    // Check X-direction seams: right column of tile[tz][tx] vs left column of tile[tz][tx+1]
    for (tz in 0...3) {
      for (tx in 0...2) {
        var tA = tiles[tz][tx];
        var tB = tiles[tz][tx + 1];
        for (iz in 0...n) {
          var hA = tA.heights[iz * n + SUBDIV]; // rightmost column of A
          var hB = tB.heights[iz * n + 0];      // leftmost column of B
          var diff = Math.abs(hA - hB);
          if (diff > maxSeamErr) maxSeamErr = diff;
          if (diff > 0.01) seamFails++;
        }
      }
    }
    // Check Z-direction seams: bottom row of tile[tz][tx] vs top row of tile[tz+1][tx]
    for (tz in 0...2) {
      for (tx in 0...3) {
        var tA = tiles[tz][tx];
        var tB = tiles[tz + 1][tx];
        for (ix in 0...n) {
          var hA = tA.heights[SUBDIV * n + ix]; // bottom row of A
          var hB = tB.heights[0 * n + ix];      // top row of B
          var diff = Math.abs(hA - hB);
          if (diff > maxSeamErr) maxSeamErr = diff;
          if (diff > 0.01) seamFails++;
        }
      }
    }

    // 2. Height range survey across 20x20 sample grid
    var minH =  999.0;
    var maxH = -999.0;
    var samples = 20;
    for (iz in 0...samples) {
      for (ix in 0...samples) {
        var wx = (ix / (samples-1) - 0.5) * SIZE * 3;
        var wz = (iz / (samples-1) - 0.5) * SIZE * 3;
        var h = sampleHeight(wx, wz);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }

    // 3. Slope variance — sample gradient magnitude at 100 random points
    var totalSlope = 0.0;
    var slopeCount = 100;
    var e = STEP * 2.0;
    for (i in 0...slopeCount) {
      var wx = (i / slopeCount - 0.5) * SIZE * 2.0;
      var wz = ((i * 37 % slopeCount) / slopeCount - 0.5) * SIZE * 2.0;
      var dh_dx = (sampleHeight(wx + e, wz) - sampleHeight(wx - e, wz)) / (2.0 * e);
      var dh_dz = (sampleHeight(wx, wz + e) - sampleHeight(wx, wz - e)) / (2.0 * e);
      var grad = dh_dx * dh_dx + dh_dz * dh_dz;
      totalSlope += Math.sqrt(Math.max(0.0, grad));
    }
    var avgSlope = totalSlope / slopeCount;

    trace('=== TERRAIN DEBUG ===');
    trace('Seam max error: ' + maxSeamErr + ' | fails (>0.001): ' + seamFails);
    trace('Height range: ' + Math.round(minH*10)/10 + ' to ' + Math.round(maxH*10)/10 + ' (HSCALE=' + HSCALE + ')');
    trace('Avg slope magnitude: ' + Math.round(avgSlope*1000)/1000 + ' (0=flat, >1=very steep)');
    trace('NSCALE=' + NSCALE + '  STEP=' + STEP + '  SUBDIV=' + SUBDIV);
    if (maxH - minH < HSCALE * 0.3) trace('WARNING: Low height variance — terrain may look too flat');
    if (avgSlope > 1.5) trace('WARNING: High avg slope — terrain may look jagged');
    if (avgSlope < 0.1) trace('WARNING: Very low slope — terrain almost completely flat');
    trace('=====================');
  }

  // Get surface normal at any world XZ via central finite differences
  public function getNormal(wx: Float, wz: Float) : h3d.Vector {
    var e = 0.5;
    var hL = sampleHeight(wx - e, wz);
    var hR = sampleHeight(wx + e, wz);
    var hD = sampleHeight(wx, wz - e);
    var hU = sampleHeight(wx, wz + e);
    var nx = hL - hR;
    var ny = 2.0 * e;
    var nz = hD - hU;
    var len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    return new h3d.Vector(nx/len, ny/len, nz/len);
  }
}

private typedef TileData = {
  mesh    : h3d.scene.Mesh,
  heights : Array<Float>,
  originX : Float,
  originZ : Float,
}
