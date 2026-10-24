# Medium rig joint map — mannequin bones measured in meters, relative to the
# pelvis. Blender frame after glTF import: the medium GLB's skeleton is cm-scale
# (armature world identity), so positions are scaled by 0.01 here.
import bpy, json
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='C:/TEMP/_WEB/FPSWebTest/client/public/assets/models/class_medium.glb')
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
names = {
    'pelvis': 'Base_HumanPelvis', 'spine3': 'Base_HumanSpine3', 'neck': 'Base_HumanNeck',
    'head': 'Base_HumanHead', 'clav_r': 'Base_HumanRCollarbone', 'upper_r': 'Base_HumanRUpperarm1',
    'fore_r': 'Base_HumanRForearm1', 'palm_r': 'Base_HumanRPalm', 'thigh_r': 'Base_HumanRThigh',
    'calf_r': 'Base_HumanRCalf', 'foot_r': 'Base_HumanRFoot',
}
pos = {k: arm.matrix_world @ arm.data.bones[v].head_local for k, v in names.items()}
ref = pos['pelvis']
out = {k: [round((p.x - ref.x) * 0.01, 3), round((p.y - ref.y) * 0.01, 3), round((p.z - ref.z) * 0.01, 3)] for k, p in pos.items()}
print('JOINTS', json.dumps(out))
