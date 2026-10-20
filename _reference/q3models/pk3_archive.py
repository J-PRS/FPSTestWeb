"""PK3 (ZIP) archive reader for Quake 3 assets."""

import os
import zipfile


class PK3Archive:
    def __init__(self, path):
        self.archive_path = path
        self._zipfile = zipfile.ZipFile(path, 'r')
        self._file_list = self._zipfile.namelist()
        # Build lowercase lookup map: lowercase -> actual name
        self._lower_map = {}
        for f in self._file_list:
            self._lower_map[f.lower()] = f

    def close(self):
        self._zipfile.close()

    def all_files(self):
        return list(self._file_list)

    def player_model_paths(self):
        """Find directories containing lower.md3, upper.md3, head.md3."""
        player_dirs = set()
        for f in self._file_list:
            lower = f.lower()
            if lower.endswith('lower.md3') or lower.endswith('upper.md3') or lower.endswith('head.md3'):
                # Directory is everything before the last /
                dir_path = f.rsplit('/', 1)[0] if '/' in f else ''
                if dir_path:
                    player_dirs.add(dir_path)

        # Filter to directories that have all three parts
        valid = []
        for d in player_dirs:
            lower_path = (d + '/lower.md3').lower()
            upper_path = (d + '/upper.md3').lower()
            head_path = (d + '/head.md3').lower()
            has_lower = lower_path in self._lower_map
            has_upper = upper_path in self._lower_map
            has_head = head_path in self._lower_map
            if has_lower and has_upper and has_head:
                valid.append(d)

        valid.sort()
        return valid

    def read_file(self, path):
        """Read a file from the archive with case-insensitive lookup."""
        # Try exact match first
        key = path.lower()
        actual = self._lower_map.get(key)
        if actual is None:
            return None
        try:
            return self._zipfile.read(actual)
        except (KeyError, zipfile.BadZipFile):
            return None
