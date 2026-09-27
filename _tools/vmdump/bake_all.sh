#!/bin/bash
# Re-bake all weapon textures: node export.js → blender per glb.
BLENDER="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
cd "$(dirname "$0")"
node export.js
for f in models/w*.glb; do
  n="${f%.glb}"
  [[ "$n" == *_baked ]] && continue
  "$BLENDER" -b --python bake.py -- "$f" "$n" 2>&1 | grep -E "BAKED|Error|Traceback" | head -3
done
mkdir -p ../../client/public/weapons
cp models/*_ao.png models/*_baked.glb ../../client/public/weapons/
echo done
