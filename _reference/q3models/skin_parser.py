"""Parse Quake 3 .skin files: surface_name -> texture_path mappings."""


def parse_skin_data(data):
    """Parse .skin file bytes into a dict of surface_name -> texture_path."""
    result = {}
    if data is None:
        return result

    # Try UTF-8 first, then Latin-1
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        text = data.decode('latin-1')

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue

        comma_idx = line.find(',')
        if comma_idx == -1:
            continue

        surf_name = line[:comma_idx].strip()
        tex_path = line[comma_idx + 1:].strip()

        # Skip tag_ entries
        if surf_name.lower().startswith('tag_'):
            continue
        if not surf_name or not tex_path:
            continue

        result[surf_name.lower()] = tex_path

    return result
