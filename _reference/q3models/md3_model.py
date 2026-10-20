"""Binary MD3 model parser with vertex decompression."""

import math
import re
import struct

from md3_types import (
    MD3_IDENT, MD3_VERSION, MD3_XYZ_SCALE, MAX_QPATH,
    MD3_DISK_HEADER_FMT, MD3_DISK_HEADER_SIZE,
    MD3_DISK_FRAME_FMT, MD3_DISK_FRAME_SIZE,
    MD3_DISK_TAG_FMT, MD3_DISK_TAG_SIZE,
    MD3_DISK_SURFACE_FMT, MD3_DISK_SURFACE_SIZE,
    MD3_DISK_SHADER_FMT, MD3_DISK_SHADER_SIZE,
    MD3_DISK_TRIANGLE_FMT, MD3_DISK_TRIANGLE_SIZE,
    MD3_DISK_TEXCOORD_FMT, MD3_DISK_TEXCOORD_SIZE,
    MD3_DISK_VERTEX_FMT, MD3_DISK_VERTEX_SIZE,
    MD3Vertex, MD3Surface, MD3Tag, MD3Frame,
)


def _decode_name(raw_bytes):
    """Decode a null-terminated C string from bytes."""
    idx = raw_bytes.find(b'\x00')
    if idx != -1:
        raw_bytes = raw_bytes[:idx]
    return raw_bytes.decode('ascii', errors='replace')


def _decompress_normal(encoded):
    """Decompress a Q3 packed normal (lat/lng in int16) to (nx, ny, nz)."""
    lat = ((encoded >> 8) & 0xFF) * (2.0 * math.pi / 255.0)
    lng = (encoded & 0xFF) * (2.0 * math.pi / 255.0)
    nx = math.cos(lat) * math.sin(lng)
    ny = math.sin(lat) * math.sin(lng)
    nz = math.cos(lng)
    return (nx, ny, nz)


class MD3Model:
    def __init__(self, data, name=""):
        self.name = name
        self.num_frames = 0
        self.num_tags = 0
        self.num_surfaces = 0
        self.frames = []
        self.tags = []       # flat list: num_tags * num_frames
        self.surfaces = []

        self._parse(data)

    def _parse(self, data):
        if len(data) < MD3_DISK_HEADER_SIZE:
            raise ValueError(f"MD3 data too short for header: {self.name}")

        hdr = struct.unpack_from(MD3_DISK_HEADER_FMT, data, 0)
        ident = hdr[0]
        version = hdr[1]
        # hdr[2] = name (bytes)
        # hdr[3] = flags
        num_frames = hdr[4]
        num_tags = hdr[5]
        num_surfaces = hdr[6]
        # hdr[7] = numSkins
        ofs_frames = hdr[8]
        ofs_tags = hdr[9]
        ofs_surfaces = hdr[10]
        # hdr[11] = ofsEnd

        if ident != MD3_IDENT or version != MD3_VERSION:
            raise ValueError(f"MD3 invalid ident/version for {self.name}")

        self.num_frames = num_frames
        self.num_tags = num_tags
        self.num_surfaces = num_surfaces

        # Parse frames
        for i in range(num_frames):
            off = ofs_frames + i * MD3_DISK_FRAME_SIZE
            f = struct.unpack_from(MD3_DISK_FRAME_FMT, data, off)
            # f[0:6] = bounds[2][3], f[6:9] = localOrigin, f[9] = radius, f[10] = name
            frame = MD3Frame(
                bounds=[[f[0], f[1], f[2]], [f[3], f[4], f[5]]],
                localOrigin=[f[6], f[7], f[8]],
                radius=f[9],
                name=_decode_name(f[10]),
            )
            self.frames.append(frame)

        # Parse tags (numTags * numFrames)
        total_tags = num_tags * num_frames
        for i in range(total_tags):
            off = ofs_tags + i * MD3_DISK_TAG_SIZE
            t = struct.unpack_from(MD3_DISK_TAG_FMT, data, off)
            tag = MD3Tag(
                name=_decode_name(t[0]),
                origin=[t[1], t[2], t[3]],
                axis=[
                    [t[4], t[5], t[6]],
                    [t[7], t[8], t[9]],
                    [t[10], t[11], t[12]],
                ],
            )
            self.tags.append(tag)

        # Parse surfaces
        surf_offset = ofs_surfaces
        for i in range(num_surfaces):
            if surf_offset >= len(data):
                break

            sh = struct.unpack_from(MD3_DISK_SURFACE_FMT, data, surf_offset)
            # sh: ident, name, flags, numFrames, numShaders, numVerts,
            #     numTriangles, ofsTriangles, ofsShaders, ofsSt, ofsXyzNormals, ofsEnd
            s_name = _decode_name(sh[1]).lower()
            # Strip trailing _1 or _2
            if len(s_name) > 2 and s_name[-2] == '_' and s_name[-1] in ('1', '2'):
                s_name = s_name[:-2]

            s_num_frames = sh[3]
            s_num_shaders = sh[4]
            s_num_verts = sh[5]
            s_num_triangles = sh[6]
            s_ofs_triangles = sh[7]
            s_ofs_shaders = sh[8]
            s_ofs_st = sh[9]
            s_ofs_xyz_normals = sh[10]
            s_ofs_end = sh[11]

            surf = MD3Surface(
                name=s_name,
                numFrames=s_num_frames,
                numVerts=s_num_verts,
                numTriangles=s_num_triangles,
            )

            # Read shader name
            if s_num_shaders > 0:
                shader_off = surf_offset + s_ofs_shaders
                shader = struct.unpack_from(MD3_DISK_SHADER_FMT, data, shader_off)
                surf.shaderName = _decode_name(shader[0])

            # Read triangles
            tri_off = surf_offset + s_ofs_triangles
            triangles = []
            for j in range(s_num_triangles):
                t = struct.unpack_from(MD3_DISK_TRIANGLE_FMT, data, tri_off + j * MD3_DISK_TRIANGLE_SIZE)
                triangles.extend(t)
            surf.triangles = triangles

            # Read texture coordinates
            tc_off = surf_offset + s_ofs_st
            tex_coords = []
            for j in range(s_num_verts):
                tc = struct.unpack_from(MD3_DISK_TEXCOORD_FMT, data, tc_off + j * MD3_DISK_TEXCOORD_SIZE)
                tex_coords.extend(tc)
            surf.texCoords = tex_coords

            # Read and decompress vertices (all frames)
            vert_off = surf_offset + s_ofs_xyz_normals
            total_verts = s_num_verts * s_num_frames
            vertices = []
            for j in range(total_verts):
                v = struct.unpack_from(MD3_DISK_VERTEX_FMT, data, vert_off + j * MD3_DISK_VERTEX_SIZE)
                nx, ny, nz = _decompress_normal(v[3])
                vert = MD3Vertex(
                    position=[v[0] * MD3_XYZ_SCALE, v[1] * MD3_XYZ_SCALE, v[2] * MD3_XYZ_SCALE],
                    normal=[nx, ny, nz],
                )
                vertices.append(vert)
            surf.vertices = vertices

            self.surfaces.append(surf)
            surf_offset += s_ofs_end

    def tag_for_name(self, name, frame):
        """Find a tag by name at a specific frame (case-insensitive)."""
        if frame < 0 or frame >= self.num_frames:
            return None
        name_lower = name.lower()
        base = frame * self.num_tags
        for i in range(self.num_tags):
            if self.tags[base + i].name.lower() == name_lower:
                return self.tags[base + i]
        return None
