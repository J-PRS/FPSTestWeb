@echo off
REM Weapon wear baker: emits <name>_grime, _edge (thick), _edge_thin per model.
REM Usage: bake3.bat <model.glb-or-blend> [outdir] [res]
set BLENDER="C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
set BAKERY=D:\[Projects]\FPS_Test\Assets\Models\launcher.blend
if "%~2"=="" (set OUT=%~dp0out) else (set OUT=%~2)
if "%~3"=="" (set RES=2048) else (set RES=%~3)
%BLENDER% -b "%BAKERY%" --python "%~dp0bake3.py" -- "%~1" "%OUT%" %RES%
