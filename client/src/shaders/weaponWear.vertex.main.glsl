// Injected after `#include <fog_vertex>` — pass the bake attributes
// through. OBJECT space, not world: the viewmodel rides the camera, so a
// world-space field swims across the gun as you move — read as "moving
// blobs". Local position glues the grunge to the metal.
vWpos = position; vWear = wear; vBary = abary; vAedge = aedge; vAlt = aalt; vGrime = grime; vAw = awear;
