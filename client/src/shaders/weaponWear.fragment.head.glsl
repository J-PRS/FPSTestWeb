// Injected after `#include <common>` in the fragment shader — varyings
// plus the shared noise helpers (value noise + fbm) used by both the
// grunge mottle and the wear/grime masks.
varying vec3 vWpos;
varying float vWear;
varying float vGrime;
varying float vAw;
varying vec3 vBary;
varying vec3 vAedge;
varying vec3 vAlt;
float whash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float wnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(whash(i), whash(i + vec3(1,0,0)), f.x), mix(whash(i + vec3(0,1,0)), f.x), mix(whash(i + vec3(0,1,1)), f.x), f.y),
    mix(mix(whash(i + vec3(0,0,1)), whash(i + vec3(1,0,1)), f.x), mix(whash(i + vec3(0,1,1)), whash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float wfbm(vec3 p) { return 0.5 * wnoise(p) + 0.25 * wnoise(p * 2.17) + 0.125 * wnoise(p * 4.31); }
