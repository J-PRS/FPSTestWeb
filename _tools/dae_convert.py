import bpy, sys
bpy.ops.wm.collada_import(filepath=sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.save_as_mainfile(filepath=sys.argv[sys.argv.index('--')+2], check_existing=False)
