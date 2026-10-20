"""MD3 binary format types, animation enums, and runtime dataclasses."""

import struct
from dataclasses import dataclass, field
from enum import IntEnum
from typing import List

# On-disk MD3 constants
MD3_IDENT = (ord('3') << 24) + (ord('P') << 16) + (ord('D') << 8) + ord('I')
MD3_VERSION = 15
MD3_XYZ_SCALE = 1.0 / 64.0
MAX_QPATH = 64

# MD3 limits
MD3_MAX_FRAMES = 1024
MD3_MAX_TAGS = 16
MD3_MAX_SURFACES = 32
MD3_MAX_TRIANGLES = 8192
MD3_MAX_VERTS = 4096
MD3_MAX_SHADERS = 256

# Struct format strings for on-disk types (little-endian)
# MD3DiskHeader: ident, version, name[64], flags, numFrames, numTags, numSurfaces,
#                numSkins, ofsFrames, ofsTags, ofsSurfaces, ofsEnd
MD3_DISK_HEADER_FMT = '<ii64siiiiiiiii'
MD3_DISK_HEADER_SIZE = struct.calcsize(MD3_DISK_HEADER_FMT)

# MD3DiskFrame: bounds[2][3], localOrigin[3], radius, name[16]
MD3_DISK_FRAME_FMT = '<6f3ff16s'
MD3_DISK_FRAME_SIZE = struct.calcsize(MD3_DISK_FRAME_FMT)

# MD3DiskTag: name[64], origin[3], axis[3][3]
MD3_DISK_TAG_FMT = '<64s3f9f'
MD3_DISK_TAG_SIZE = struct.calcsize(MD3_DISK_TAG_FMT)

# MD3DiskSurface: ident, name[64], flags, numFrames, numShaders, numVerts,
#                 numTriangles, ofsTriangles, ofsShaders, ofsSt, ofsXyzNormals, ofsEnd
MD3_DISK_SURFACE_FMT = '<i64siiiiiiiiii'
MD3_DISK_SURFACE_SIZE = struct.calcsize(MD3_DISK_SURFACE_FMT)

# MD3DiskShader: name[64], shaderIndex
MD3_DISK_SHADER_FMT = '<64si'
MD3_DISK_SHADER_SIZE = struct.calcsize(MD3_DISK_SHADER_FMT)

# MD3DiskTriangle: indexes[3]
MD3_DISK_TRIANGLE_FMT = '<3i'
MD3_DISK_TRIANGLE_SIZE = struct.calcsize(MD3_DISK_TRIANGLE_FMT)

# MD3DiskTexCoord: st[2]
MD3_DISK_TEXCOORD_FMT = '<2f'
MD3_DISK_TEXCOORD_SIZE = struct.calcsize(MD3_DISK_TEXCOORD_FMT)

# MD3DiskVertex: xyz[3] as int16, normal as int16
MD3_DISK_VERTEX_FMT = '<3hh'
MD3_DISK_VERTEX_SIZE = struct.calcsize(MD3_DISK_VERTEX_FMT)


# Animation enum (matches Q3 bg_public.h)
class AnimNumber(IntEnum):
    BOTH_DEATH1 = 0
    BOTH_DEAD1 = 1
    BOTH_DEATH2 = 2
    BOTH_DEAD2 = 3
    BOTH_DEATH3 = 4
    BOTH_DEAD3 = 5

    TORSO_GESTURE = 6

    TORSO_ATTACK = 7
    TORSO_ATTACK2 = 8

    TORSO_DROP = 9
    TORSO_RAISE = 10

    TORSO_STAND = 11
    TORSO_STAND2 = 12

    LEGS_WALKCR = 13
    LEGS_WALK = 14
    LEGS_RUN = 15
    LEGS_BACK = 16
    LEGS_SWIM = 17

    LEGS_JUMP = 18
    LEGS_LAND = 19

    LEGS_JUMPB = 20
    LEGS_LANDB = 21

    LEGS_IDLE = 22
    LEGS_IDLECR = 23

    LEGS_TURN = 24

    TORSO_GETFLAG = 25
    TORSO_GUARDBASE = 26
    TORSO_PATROL = 27
    TORSO_FOLLOWME = 28
    TORSO_AFFIRMATIVE = 29
    TORSO_NEGATIVE = 30

    MAX_ANIMATIONS = 31

    LEGS_BACKCR = 32
    LEGS_BACKWALK = 33
    FLAG_RUN = 34
    FLAG_STAND = 35
    FLAG_STAND2RUN = 36

    MAX_TOTALANIMATIONS = 37


ANIMATION_NAMES = [
    "BOTH_DEATH1", "BOTH_DEAD1", "BOTH_DEATH2", "BOTH_DEAD2",
    "BOTH_DEATH3", "BOTH_DEAD3",
    "TORSO_GESTURE",
    "TORSO_ATTACK", "TORSO_ATTACK2",
    "TORSO_DROP", "TORSO_RAISE",
    "TORSO_STAND", "TORSO_STAND2",
    "LEGS_WALKCR", "LEGS_WALK", "LEGS_RUN", "LEGS_BACK", "LEGS_SWIM",
    "LEGS_JUMP", "LEGS_LAND",
    "LEGS_JUMPB", "LEGS_LANDB",
    "LEGS_IDLE", "LEGS_IDLECR",
    "LEGS_TURN",
    "TORSO_GETFLAG", "TORSO_GUARDBASE", "TORSO_PATROL",
    "TORSO_FOLLOWME", "TORSO_AFFIRMATIVE", "TORSO_NEGATIVE",
]


@dataclass
class Animation:
    firstFrame: int = 0
    numFrames: int = 0
    loopFrames: int = 0
    frameLerp: int = 0
    reversed: int = 0
    flipflop: int = 0


@dataclass
class AnimState:
    animIndex: int = 0
    currentFrame: int = 0
    nextFrame: int = 0
    fraction: float = 0.0
    frameTime: float = 0.0
    playing: bool = True


@dataclass
class TagTransform:
    origin: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    axis: List[List[float]] = field(default_factory=lambda: [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ])


# Runtime structures
@dataclass
class MD3Vertex:
    position: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    normal: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])


@dataclass
class MD3Tag:
    name: str = ""
    origin: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    axis: List[List[float]] = field(default_factory=lambda: [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ])


@dataclass
class MD3Frame:
    bounds: List[List[float]] = field(default_factory=lambda: [[0.0]*3, [0.0]*3])
    localOrigin: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    radius: float = 0.0
    name: str = ""


@dataclass
class MD3Surface:
    name: str = ""
    numFrames: int = 0
    numVerts: int = 0
    numTriangles: int = 0
    triangles: List[int] = field(default_factory=list)      # flat: numTriangles * 3
    texCoords: List[float] = field(default_factory=list)     # flat: numVerts * 2
    vertices: List[MD3Vertex] = field(default_factory=list)  # numVerts * numFrames
    shaderName: str = ""
    textureID: int = 0
