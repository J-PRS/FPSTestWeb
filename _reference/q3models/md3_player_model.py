"""Three-part Quake 3 player model (lower/upper/head) with tag stitching."""

import math
import sys
import time

from md3_types import AnimNumber, AnimState, TagTransform, MD3Tag, Animation
from md3_model import MD3Model
from animation_config import AnimationConfig
from skin_parser import parse_skin_data


def _current_time_ms():
    return time.monotonic() * 1000.0


def _vector_normalize(v):
    length = math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])
    if length > 0.0001:
        v[0] /= length
        v[1] /= length
        v[2] /= length


def _matrix_multiply_3x3(in1, in2):
    """Multiply two 3x3 matrices (list-of-lists)."""
    out = [[0.0]*3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            out[i][j] = in1[i][0]*in2[0][j] + in1[i][1]*in2[1][j] + in1[i][2]*in2[2][j]
    return out


def _transform_point(inp, origin, axis):
    """out = origin + in[0]*axis[0] + in[1]*axis[1] + in[2]*axis[2]"""
    out = [0.0, 0.0, 0.0]
    for i in range(3):
        out[i] = origin[i] + inp[0]*axis[0][i] + inp[1]*axis[1][i] + inp[2]*axis[2][i]
    return out


class MD3PlayerModel:
    def __init__(self, archive, model_path):
        self.model_name = model_path.rsplit('/', 1)[-1] if '/' in model_path else model_path
        self._model_path = model_path
        self._archive = archive

        # Enumerate available skins
        self._available_skins = []
        self._current_skin = 'default'
        self._enumerate_skins()

        # Load MD3 files
        lower_data = archive.read_file(model_path + '/lower.md3')
        upper_data = archive.read_file(model_path + '/upper.md3')
        head_data = archive.read_file(model_path + '/head.md3')

        if lower_data is None or upper_data is None or head_data is None:
            raise ValueError(f"Missing .md3 files in {model_path}")

        self._lower = MD3Model(lower_data, 'lower.md3')
        self._upper = MD3Model(upper_data, 'upper.md3')
        self._head = MD3Model(head_data, 'head.md3')

        # Load default skin
        self._lower_skin = {}
        self._upper_skin = {}
        self._head_skin = {}
        self._load_skin('default')

        # Load animation config
        self.anim_config = None
        anim_data = archive.read_file(model_path + '/animation.cfg')
        if anim_data:
            self.anim_config = AnimationConfig(anim_data)

        # Compute center height
        self.center_height = 0.0
        self.bounding_radius = 50.0
        self._compute_center_height()

        # Animation state
        self._playing = True
        self._torso_state = AnimState()
        self._legs_state = AnimState()
        self._init_anim_state(self._torso_state, AnimNumber.TORSO_STAND)
        self._init_anim_state(self._legs_state, AnimNumber.LEGS_IDLE)

    @property
    def playing(self):
        return self._playing

    @playing.setter
    def playing(self, value):
        self._playing = value

    @property
    def available_skins(self):
        return self._available_skins

    @property
    def current_skin(self):
        return self._current_skin

    @property
    def torso_anim(self):
        return self._torso_state.animIndex

    @torso_anim.setter
    def torso_anim(self, anim):
        self.set_torso_animation(anim)

    @property
    def legs_anim(self):
        return self._legs_state.animIndex

    @legs_anim.setter
    def legs_anim(self, anim):
        self.set_legs_animation(anim)

    def _init_anim_state(self, state, anim):
        state.animIndex = anim
        state.currentFrame = 0
        state.nextFrame = 0
        state.fraction = 0.0
        state.frameTime = _current_time_ms()
        state.playing = True

    def _enumerate_skins(self):
        skin_names = set()
        prefix = (self._model_path + '/lower_').lower()

        for f in self._archive.all_files():
            lower = f.lower()
            if lower.startswith(prefix) and lower.endswith('.skin'):
                # Extract skin name: "lower_red.skin" -> "red"
                filename = lower.rsplit('/', 1)[-1] if '/' in lower else lower
                skin_name = filename[6:]  # skip "lower_"
                skin_name = skin_name.rsplit('.', 1)[0]  # strip ".skin"
                if skin_name:
                    skin_names.add(skin_name)

        sorted_names = sorted(skin_names, key=str.lower)
        if 'default' in sorted_names:
            sorted_names.remove('default')
            sorted_names.insert(0, 'default')
        self._available_skins = sorted_names

    def _load_skin(self, skin_name):
        lower_path = f"{self._model_path}/lower_{skin_name}.skin"
        upper_path = f"{self._model_path}/upper_{skin_name}.skin"
        head_path = f"{self._model_path}/head_{skin_name}.skin"

        self._lower_skin = parse_skin_data(self._archive.read_file(lower_path))
        self._upper_skin = parse_skin_data(self._archive.read_file(upper_path))
        self._head_skin = parse_skin_data(self._archive.read_file(head_path))
        self._current_skin = skin_name

    def select_skin(self, skin_name):
        self._load_skin(skin_name)

    def set_torso_animation(self, anim):
        self._init_anim_state(self._torso_state, anim)

    def set_legs_animation(self, anim):
        self._init_anim_state(self._legs_state, anim)

    def step_frame(self, direction):
        if self._playing:
            return
        self._step_anim_state(self._torso_state, direction)
        self._step_anim_state(self._legs_state, direction)

    def _step_anim_state(self, state, direction):
        if self.anim_config is None:
            return
        anim = self.anim_config.animations[state.animIndex]
        if anim.numFrames <= 0:
            return
        state.currentFrame += direction
        if state.currentFrame < 0:
            state.currentFrame = anim.numFrames - 1
        if state.currentFrame >= anim.numFrames:
            state.currentFrame = 0
        state.nextFrame = state.currentFrame
        state.fraction = 0.0

    def torso_current_frame(self):
        return self._torso_state.currentFrame

    def torso_num_frames(self):
        if self.anim_config is None:
            return 0
        return self.anim_config.animations[self._torso_state.animIndex].numFrames

    def legs_current_frame(self):
        return self._legs_state.currentFrame

    def legs_num_frames(self):
        if self.anim_config is None:
            return 0
        return self.anim_config.animations[self._legs_state.animIndex].numFrames

    def scrub_torso_to_frame(self, frame):
        if self.anim_config is None:
            return
        anim = self.anim_config.animations[self._torso_state.animIndex]
        if anim.numFrames <= 0:
            return
        self._torso_state.currentFrame = frame % anim.numFrames
        self._torso_state.nextFrame = self._torso_state.currentFrame
        self._torso_state.fraction = 0.0

    def scrub_legs_to_frame(self, frame):
        if self.anim_config is None:
            return
        anim = self.anim_config.animations[self._legs_state.animIndex]
        if anim.numFrames <= 0:
            return
        self._legs_state.currentFrame = frame % anim.numFrames
        self._legs_state.nextFrame = self._legs_state.currentFrame
        self._legs_state.fraction = 0.0

    def _update_anim_state(self, state):
        if not self._playing or self.anim_config is None:
            return
        anim = self.anim_config.animations[state.animIndex]
        if anim.numFrames <= 1:
            return

        now = _current_time_ms()
        elapsed = now - state.frameTime

        if anim.frameLerp <= 0:
            return

        state.fraction = elapsed / anim.frameLerp
        while state.fraction >= 1.0:
            state.fraction -= 1.0
            state.frameTime += anim.frameLerp
            state.currentFrame += 1

            if anim.loopFrames > 0:
                if state.currentFrame >= anim.numFrames:
                    state.currentFrame = anim.numFrames - anim.loopFrames
            else:
                if state.currentFrame >= anim.numFrames - 1:
                    state.currentFrame = anim.numFrames - 1
                    state.fraction = 0.0

        state.nextFrame = state.currentFrame + 1
        if anim.loopFrames > 0:
            if state.nextFrame >= anim.numFrames:
                state.nextFrame = anim.numFrames - anim.loopFrames
        else:
            if state.nextFrame >= anim.numFrames:
                state.nextFrame = anim.numFrames - 1

    def _get_frame_a_b(self, state):
        if self.anim_config is None:
            return 0, 0, 0.0
        anim = self.anim_config.animations[state.animIndex]

        fa = anim.firstFrame + state.currentFrame
        fb = anim.firstFrame + state.nextFrame

        if anim.reversed:
            fa = anim.firstFrame + anim.numFrames - 1 - state.currentFrame
            fb = anim.firstFrame + anim.numFrames - 1 - state.nextFrame

        return fa, fb, state.fraction

    def _lerp_tag(self, model, tag_name, frame_a, frame_b, frac):
        tag_a = model.tag_for_name(tag_name, frame_a)
        tag_b = model.tag_for_name(tag_name, frame_b)

        if tag_a is None or tag_b is None:
            return MD3Tag(
                name=tag_name,
                origin=[0, 0, 0],
                axis=[[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            )

        back_lerp = 1.0 - frac
        out = MD3Tag(name=tag_name)
        out.origin = [0.0, 0.0, 0.0]
        out.axis = [[0.0]*3 for _ in range(3)]

        for i in range(3):
            out.origin[i] = tag_a.origin[i] * back_lerp + tag_b.origin[i] * frac
            out.axis[0][i] = tag_a.axis[0][i] * back_lerp + tag_b.axis[0][i] * frac
            out.axis[1][i] = tag_a.axis[1][i] * back_lerp + tag_b.axis[1][i] * frac
            out.axis[2][i] = tag_a.axis[2][i] * back_lerp + tag_b.axis[2][i] * frac

        _vector_normalize(out.axis[0])
        _vector_normalize(out.axis[1])
        _vector_normalize(out.axis[2])

        return out

    def _position_child_on_tag(self, parent_transform, tag):
        child = TagTransform()

        # child.origin = parent.origin + tag.origin[0]*parent.axis[0] + ...
        child.origin = [0.0, 0.0, 0.0]
        for i in range(3):
            child.origin[i] = parent_transform.origin[i]
            for j in range(3):
                child.origin[i] += tag.origin[j] * parent_transform.axis[j][i]

        # child.axis = tag.axis * parent.axis
        child.axis = _matrix_multiply_3x3(tag.axis, parent_transform.axis)

        return child

    def _compute_center_height(self):
        legs_frame = 0
        torso_frame = 0
        if self.anim_config:
            anims = self.anim_config.animations
            legs_frame = anims[AnimNumber.LEGS_IDLE].firstFrame
            torso_frame = anims[AnimNumber.TORSO_STAND].firstFrame
        if legs_frame >= self._lower.num_frames:
            legs_frame = 0
        if torso_frame >= self._upper.num_frames:
            torso_frame = 0

        min_x = min_y = min_z = 1e9
        max_x = max_y = max_z = -1e9

        # Lower body verts at idle frame
        for surf in self._lower.surfaces:
            base = legs_frame * surf.numVerts
            for v_idx in range(surf.numVerts):
                v = surf.vertices[base + v_idx]
                x, y, z = v.position
                min_x = min(min_x, x); max_x = max(max_x, x)
                min_y = min(min_y, y); max_y = max(max_y, y)
                min_z = min(min_z, z); max_z = max(max_z, z)

        # Get tag_torso at legs idle frame
        torso_tag = self._lower.tag_for_name('tag_torso', legs_frame)
        t_origin = [0, 0, 0]
        t_axis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        if torso_tag:
            t_origin = list(torso_tag.origin)
            t_axis = [list(row) for row in torso_tag.axis]

        # Upper body verts at torso stand frame, transformed through tag_torso
        for surf in self._upper.surfaces:
            base = torso_frame * surf.numVerts
            for v_idx in range(surf.numVerts):
                v = surf.vertices[base + v_idx]
                world = _transform_point(v.position, t_origin, t_axis)
                min_x = min(min_x, world[0]); max_x = max(max_x, world[0])
                min_y = min(min_y, world[1]); max_y = max(max_y, world[1])
                min_z = min(min_z, world[2]); max_z = max(max_z, world[2])

        # Get tag_head at torso stand frame, transformed through tag_torso
        head_tag = self._upper.tag_for_name('tag_head', torso_frame)
        h_origin = [0, 0, 0]
        h_axis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        if head_tag:
            local_origin = _transform_point(head_tag.origin, t_origin, t_axis)
            h_origin = local_origin
            h_axis = _matrix_multiply_3x3(head_tag.axis, t_axis)

        # Head verts at frame 0, transformed through both tags
        for surf in self._head.surfaces:
            for v_idx in range(surf.numVerts):
                v = surf.vertices[v_idx]  # head is typically 1 frame
                world = _transform_point(v.position, h_origin, h_axis)
                min_x = min(min_x, world[0]); max_x = max(max_x, world[0])
                min_y = min(min_y, world[1]); max_y = max(max_y, world[1])
                min_z = min(min_z, world[2]); max_z = max(max_z, world[2])

        cx = (min_x + max_x) * 0.5
        cy = (min_y + max_y) * 0.5
        cz = (min_z + max_z) * 0.5
        self.center_height = cz

        dx = max(max_x - cx, cx - min_x)
        dy = max(max_y - cy, cy - min_y)
        dz = max(max_z - cz, cz - min_z)
        self.bounding_radius = math.sqrt(dx*dx + dy*dy + dz*dz)

    def render(self, renderer, tex_cache, view_matrix, proj_matrix, gamma):
        self._update_anim_state(self._torso_state)
        self._update_anim_state(self._legs_state)

        # Lower body (legs)
        legs_fa, legs_fb, legs_frac = self._get_frame_a_b(self._legs_state)
        legs_transform = TagTransform()

        renderer.render_model(self._lower, legs_fa, legs_fb, legs_frac,
                              legs_transform, tex_cache, self._lower_skin,
                              view_matrix, proj_matrix, gamma)

        # Upper body (torso)
        torso_tag = self._lerp_tag(self._lower, 'tag_torso', legs_fa, legs_fb, legs_frac)
        torso_transform = self._position_child_on_tag(legs_transform, torso_tag)

        torso_fa, torso_fb, torso_frac = self._get_frame_a_b(self._torso_state)

        renderer.render_model(self._upper, torso_fa, torso_fb, torso_frac,
                              torso_transform, tex_cache, self._upper_skin,
                              view_matrix, proj_matrix, gamma)

        # Head
        head_tag = self._lerp_tag(self._upper, 'tag_head', torso_fa, torso_fb, torso_frac)
        head_transform = self._position_child_on_tag(torso_transform, head_tag)

        renderer.render_model(self._head, 0, 0, 0.0,
                              head_transform, tex_cache, self._head_skin,
                              view_matrix, proj_matrix, gamma)
