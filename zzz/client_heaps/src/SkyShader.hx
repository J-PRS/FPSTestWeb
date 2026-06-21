class SkyShader extends hxsl.Shader {
  static var SRC = {
    @input var input : { position : Vec3 };
    var output : { position : Vec4, color : Vec4 };
    var transformedPosition : Vec3;

    @param var cameraPos   : Vec3;
    @param var sunDir      : Vec3;

    function fragment() {
      var rayDir = normalize(transformedPosition - cameraPos);

      // Elevation for gradient
      var elev = clamp(rayDir.y, -0.2, 1.0);
      var t    = (elev + 0.2) / 1.2;

      // Rich gradient: deep purple zenith → warm orange horizon
      var zenith  = vec3(0.08, 0.15, 0.35);
      var midSky  = vec3(0.25, 0.45, 0.75);
      var horizon = vec3(0.85, 0.65, 0.45);
      var skyCol = vec3(0.0);
      if (t < 0.5) {
        skyCol = mix(zenith, midSky, t * 2.0);
      } else {
        skyCol = mix(midSky, horizon, (t - 0.5) * 2.0);
      }

      // Atmospheric haze near horizon
      var haze = pow(1.0 - clamp(elev, 0.0, 0.3) / 0.3, 2.0);
      skyCol = mix(skyCol, vec3(0.95, 0.85, 0.70), haze * 0.6);

      // Procedural clouds using 3D noise on ray direction
      var cloudT = rayDir.y * 0.5 + 0.5;
      var cx = rayDir.x * 2.0;
      var cy = rayDir.y * 2.0;
      var cz = rayDir.z * 2.0;
      var n1 = fract(sin(dot(vec2(cx, cy), vec2(12.9898, 78.233))) * 43758.5453);
      var n2 = fract(sin(dot(vec2(cy, cz), vec2(39.346, 56.589))) * 43758.5453);
      var cloud = smoothstep(0.45, 0.65, n1 * 0.5 + n2 * 0.5);
      cloud = cloud * smoothstep(0.0, 0.4, elev) * smoothstep(0.8, 1.0, elev);
      skyCol = mix(skyCol, vec3(1.0, 1.0, 1.0), cloud * 0.85);

      // Sun disc — very tight, small bright spot
      var sunDot  = clamp(dot(rayDir, sunDir), 0.0, 1.0);
      var sunDisc = pow(sunDot, 512.0) * 1.2;   // tight core
      var sunGlow = pow(sunDot, 64.0)  * 0.06;  // small inner glow
      var sunCol  = vec3(1.0, 0.95, 0.82);
      skyCol = skyCol + sunCol * (sunDisc + sunGlow);

      // Below horizon: ground fog
      var belowT = clamp(-rayDir.y * 3.0, 0.0, 1.0);
      var ground = vec3(0.35, 0.40, 0.45);
      skyCol = mix(skyCol, ground, belowT * belowT);

      output.color = vec4(skyCol, 1.0);
    }
  };
}
