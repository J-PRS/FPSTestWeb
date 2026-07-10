#!/usr/bin/env python3
"""
Project Overview Script (Universal)
Lists all files in the project with size, line count, and import/using statistics
Supports Haxe (.hx), C# (.cs), and other common file types
"""

import time
import re
import argparse
from pathlib import Path
from collections import defaultdict
import pyperclip

start_time = time.time()

# Use src directories in client and server folders
project_dirs = [Path('client/src'), Path('server/src')]

# Extensions to count lines for (code files)
CODE_EXTENSIONS = {
    '.hx',
    '.hxml',
    '.cs',
    '.csproj',
    '.bat',
    '.py',
    '.lua',
    '.md',
    '.txt',
    '.json',
    '.xml',
    '.svelte',
    '.ts',
    '.js',
    '.css',
}

# Extensions to skip entirely
SKIP_EXTENSIONS = {'.obj', '.o', '.dll', '.exe', '.lib', '.a', '.pdb', '.ilk'}

# Threshold for aggregating PNG files in folders
AGGREGATE_THRESHOLD = 5  # If folder has more than this many PNG files, aggregate

# Directories to skip
SKIP_DIRS = {
    '_reports',
    '_docs',
    'spritegen-gh-pages',
    'logs',
    'node_modules',
    '.git',
    'zzz',
    'build',
    'bin',
    'obj',
    '.vs',
    '.vscode',
    'Properties',
}

# Files to skip
SKIP_FILES = {'_overview.lua', 'overview.py', 'overview_cs.py', 'overview.bat'}


def get_line_count(filepath):
    """Get line count of a file"""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            return sum(1 for _ in f)
    except (IOError, OSError, UnicodeDecodeError):
        return 0


def count_imports(filepath):
    """Count import/using statements in Haxe, C#, TypeScript, or JavaScript files"""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()

        ext = Path(filepath).suffix.lower()

        if ext == '.hx':
            # Parse Haxe import statements
            # Matches: import package.ClassName; or import package.*;
            import_pattern = r'^\s*import\s+([a-zA-Z0-9_.*]+)\s*;'
            imports = re.findall(import_pattern, content, re.MULTILINE)
            # Filter out wildcard imports (package.*) for counting
            # Only count specific class imports
            specific_imports = [imp for imp in imports if not imp.endswith('.*')]
            return len(specific_imports)

        elif ext == '.cs':
            # Parse C# using statements
            # Matches: using System; or using System.Collections;
            using_pattern = r'^\s*using\s+([a-zA-Z0-9_.]+)\s*;'
            usings = re.findall(using_pattern, content, re.MULTILINE)
            # Filter out static usings and aliases for counting
            # Only count standard using statements
            standard_usings = [
                u for u in usings if '=' not in u and not u.endswith('.*')
            ]
            return len(standard_usings)

        elif ext in ('.ts', '.js', '.svelte'):
            # Parse TypeScript/JavaScript ES6 imports
            # Matches: import ... from '...'; or import '...';
            import_pattern = r'^\s*import\s+.*?from\s+[\'"]([^\'"]+)[\'"]\s*;?|^\s*import\s+[\'"]([^\'"]+)[\'"]\s*;?'
            imports = re.findall(import_pattern, content, re.MULTILINE)
            # Flatten results and filter empty strings
            all_imports = [imp for pair in imports for imp in pair if imp]
            # Filter out relative imports (starting with . or ..) for counting
            external_imports = [imp for imp in all_imports if not imp.startswith('.')]
            return len(external_imports)

        elif ext == '.css':
            # Parse CSS @import statements
            # Matches: @import '...'; or @import url('...');
            import_pattern = r'^\s*@import\s+(?:url\()?[\'"]([^\'"]+)[\'"]\)?\s*;'
            imports = re.findall(import_pattern, content, re.MULTILINE)
            return len(imports)

        return 0
    except (IOError, OSError, UnicodeDecodeError):
        return 0


def build_type_reference_map(results):
    """Build type reference count map (how many times each file is referenced)"""
    ref_map = defaultdict(int)
    type_to_file = {}

    # Build type name to file path mapping
    for file in results:
        if file['line_count'] != '-':  # Only for code files
            # Extract class name from file path (e.g., src/Player.hx -> Player)
            filename = Path(file['path']).stem
            type_to_file[filename] = file['path']

    # Scan all files for import/using statements
    for file in results:
        if file['line_count'] != '-':
            try:
                with open(file['path'], 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()

                ext = Path(file['path']).suffix.lower()

                if ext == '.hx':
                    # Parse Haxe import statements
                    import_pattern = r'^\s*import\s+([a-zA-Z0-9_.*]+)\s*;'
                    imports = re.findall(import_pattern, content, re.MULTILINE)
                    # Extract the class name from import (e.g., combat.Projectile -> Projectile)
                    for imp in imports:
                        if not imp.endswith('.*'):  # Skip wildcard imports
                            class_name = imp.split('.')[-1]
                            if (
                                class_name in type_to_file
                                and type_to_file[class_name] != file['path']
                            ):
                                ref_map[type_to_file[class_name]] += 1

                elif ext == '.cs':
                    # Parse C# using statements
                    using_pattern = r'^\s*using\s+([a-zA-Z0-9_.]+)\s*;'
                    usings = re.findall(using_pattern, content, re.MULTILINE)
                    # Extract the class name from using (e.g., System.Collections -> Collections)
                    for using_stmt in usings:
                        if '=' not in using_stmt and not using_stmt.endswith('.*'):
                            class_name = using_stmt.split('.')[-1]
                            if (
                                class_name in type_to_file
                                and type_to_file[class_name] != file['path']
                            ):
                                ref_map[type_to_file[class_name]] += 1

                elif ext in ('.ts', '.js', '.svelte'):
                    # Parse TypeScript/JavaScript ES6 imports
                    import_pattern = r'^\s*import\s+.*?from\s+[\'"]([^\'"]+)[\'"]\s*;?|^\s*import\s+[\'"]([^\'"]+)[\'"]\s*;?'
                    imports = re.findall(import_pattern, content, re.MULTILINE)
                    all_imports = [imp for pair in imports for imp in pair if imp]
                    # Extract class/module name from import path (e.g., ./utils -> utils, @lib/components -> components)
                    for imp in all_imports:
                        if not imp.startswith('.'):  # Only external imports
                            # Get the last part of the path as the module name
                            class_name = imp.split('/')[-1].split('\\')[-1]
                            if (
                                class_name in type_to_file
                                and type_to_file[class_name] != file['path']
                            ):
                                ref_map[type_to_file[class_name]] += 1

                elif ext == '.css':
                    # Parse CSS @import statements
                    import_pattern = (
                        r'^\s*@import\s+(?:url\()?[\'"]([^\'"]+)[\'"]\)?\s*;'
                    )
                    imports = re.findall(import_pattern, content, re.MULTILINE)
                    for imp in imports:
                        # Get the filename from the import path
                        class_name = (
                            imp.split('/')[-1].split('\\')[-1].replace('.css', '')
                        )
                        if (
                            class_name in type_to_file
                            and type_to_file[class_name] != file['path']
                        ):
                            ref_map[type_to_file[class_name]] += 1

            except (IOError, OSError, UnicodeDecodeError):
                pass

    return ref_map


def format_size(bytes, include_unit=True):
    """Format file size in human-readable format (always KB for ultra mode)"""
    if bytes < 1024 * 1024:
        value = f'{bytes / 1024:.1f}'
        return f'{value} KB' if include_unit else value
    else:
        value = f'{bytes / (1024 * 1024):.1f}'
        return f'{value} MB' if include_unit else value


def check_docs_date_prefixes(docs_dir):
    """Check _docs files for date prefix suggestions"""
    from datetime import datetime

    suggestions = []

    if not docs_dir.exists():
        return suggestions

    for filepath in docs_dir.iterdir():
        if not filepath.is_file():
            continue

        filename = filepath.name

        # Skip if already has date prefix (YYYY-MM-DD_)
        if re.match(r'^\d{4}-\d{2}-\d{2}_', filename):
            continue

        # Check if starts with a letter (not special char or digit)
        if filename and filename[0].isalpha():
            # Get oldest of creation and modification time
            stat = filepath.stat()
            creation_time = datetime.fromtimestamp(stat.st_ctime)
            modification_time = datetime.fromtimestamp(stat.st_mtime)

            oldest_date = min(creation_time, modification_time)
            date_prefix = oldest_date.strftime('%Y-%m-%d')
            new_filename = f'{date_prefix}_{filename}'

            suggestions.append(
                {
                    'original': filename,
                    'suggested': new_filename,
                    'date': date_prefix,
                    'oldest_date': oldest_date,
                }
            )

    return suggestions


def scan_dir(root_dirs):
    """Recursively scan directories for files"""
    results = []

    for root_dir in root_dirs:
        if not root_dir.exists():
            continue
        for filepath in root_dir.rglob('*'):
            if not filepath.is_file():
                continue

            full_path = str(filepath).replace('\\', '/')

            # Skip directories
            if any(skip_dir in full_path for skip_dir in SKIP_DIRS):
                continue

            # Skip specific files
            filename = filepath.name
            if any(skip_file in filename for skip_file in SKIP_FILES):
                continue

            # Skip files with certain extensions
            if filepath.suffix.lower() in SKIP_EXTENSIONS:
                continue

            # Check if file is in assets folder or has asset/config in path
            is_asset = (
                '/assets/' in full_path
                or 'asset' in full_path.lower()
                or 'config' in full_path.lower()
            )

            # Get file size
            size = filepath.stat().st_size

            # Get line count and import counts
            ext = filepath.suffix.lower()
            if ext in CODE_EXTENSIONS:
                line_count = get_line_count(full_path)
                if ext in ('.hx', '.cs', '.ts', '.js', '.svelte', '.css'):
                    imports_count = count_imports(full_path)
                else:
                    imports_count = '-'
                imported_count = 0  # Will be filled later
                # Classify as Asset if in assets/config directories, otherwise Script
                file_type = 'Asset' if is_asset else 'Script'
            else:
                line_count = '-'
                imports_count = '-'
                imported_count = '-'
                file_type = 'Asset'

            results.append(
                {
                    'path': full_path,
                    'size': size,
                    'line_count': line_count,
                    'imports_count': imports_count,
                    'imported_count': imported_count,
                    'type': file_type,
                }
            )

    return results


def build_tree(files):
    """Build tree structure for hierarchical display"""
    tree = {}

    for file in files:
        parts = file['path'].split('/')
        current = tree

        for i, part in enumerate(parts):
            if part not in current:
                current[part] = {
                    'is_dir': i < len(parts) - 1,
                    'children': {},
                    'file': None,
                    'file_count': 0,
                    'total_size': 0,
                    'png_count': 0,
                    'png_size': 0,
                }
            if i == len(parts) - 1:
                current[part]['file'] = file
                current[part]['file_count'] = 1
                current[part]['total_size'] = file['size']
                # Track PNG files specifically for aggregation
                if file['path'].lower().endswith('.png'):
                    current[part]['png_count'] = 1
                    current[part]['png_size'] = file['size']
            current = current[part]['children']

    return tree


def print_tree_non_png(tree, indent, path_width, compact=False):
    """Recursively print tree structure, skipping PNG files"""
    dirs = []
    files = []

    # Separate directories and files
    for key, node in tree.items():
        if node['is_dir']:
            dirs.append(key)
        else:
            # Skip PNG files
            if node['file'] and not node['file']['path'].lower().endswith('.png'):
                files.append(key)

    # Sort directories and files
    dirs.sort()
    files.sort()

    # Print directories first
    for key in dirs:
        node = tree[key]

        # Calculate PNG count and total size for this directory
        png_count = 0
        png_size = 0
        for child_key, child_node in node['children'].items():
            if child_node['png_count'] > 0:
                png_count += child_node['png_count']
                png_size += child_node['png_size']

        # If directory has many PNG files, show aggregated stats instead of listing them
        if png_count > AGGREGATE_THRESHOLD:
            brackets = '[' * (indent + 1) + ' ' + key + ' ' + ']' * (indent + 1)
            display_path = '  ' * indent + brackets
            print(
                f'{display_path:<{path_width}} {format_size(png_size):>8} {png_count:>6} {"-":>7} {"-":>8}'
            )
            # Print non-PNG files in this directory
            print_tree_non_png(node['children'], indent + 1, path_width, compact)
        else:
            brackets = '[' * (indent + 1) + ' ' + key + ' ' + ']' * (indent + 1)
            print(f'{"  " * indent}{brackets:<{path_width}}')
            print_tree_non_png(node['children'], indent + 1, path_width, compact)

    # Print non-PNG files after directories
    if compact and files:
        # Compact mode: print all files on one line
        file_entries = []
        for key in files:
            node = tree[key]
            display_name = key[:-7] if key.endswith('.svelte') else key
            file = node['file']
            size_str = format_size(file['size'])
            lines_str = str(file['line_count']) if file['line_count'] != '-' else '-'
            file_entries.append(f'{display_name} {size_str} {lines_str}')
        print('  ' * indent + ', '.join(file_entries))
    else:
        # Normal mode: print each file on its own line
        for key in files:
            node = tree[key]
            # Strip .svelte extension for compact display
            display_name = key[:-7] if key.endswith('.svelte') else key
            display_path = '  ' * indent + display_name
            file = node['file']

            # Format imports_count and imported_count
            imports_display = (
                file['imports_count']
                if file['imports_count'] != 0 and file['imports_count'] != '-'
                else '-'
            )
            imported_display = (
                file['imported_count']
                if file['imported_count'] != 0 and file['imported_count'] != '-'
                else '-'
            )

            if file['line_count'] == '-':
                print(
                    f'{display_path:<{path_width}} {format_size(file["size"]):>8} {file["line_count"]:>6} {imports_display:>7} {imported_display:>8}'
                )
            else:
                print(
                    f'{display_path:<{path_width}} {format_size(file["size"]):>8} {file["line_count"]:>6} {imports_display:>7} {imported_display:>8}'
                )


def print_tree(tree, indent, path_width, compact=False):
    """Recursively print tree structure"""
    dirs = []
    files = []

    # Separate directories and files
    for key, node in tree.items():
        if node['is_dir']:
            dirs.append(key)
        else:
            files.append(key)

    # Sort directories and files
    dirs.sort()
    files.sort()

    # Print directories first
    for key in dirs:
        node = tree[key]

        # Calculate PNG count and total size for this directory
        png_count = 0
        png_size = 0
        for child_key, child_node in node['children'].items():
            if child_node['png_count'] > 0:
                png_count += child_node['png_count']
                png_size += child_node['png_size']

        # If directory has many PNG files, show aggregated stats instead of listing them
        if png_count > AGGREGATE_THRESHOLD:
            brackets = '[' * (indent + 1) + ' ' + key + ' ' + ']' * (indent + 1)
            display_path = '  ' * indent + brackets
            print(
                f'{display_path:<{path_width}} {format_size(png_size):>8} {png_count:>6} {"-":>7} {"-":>8}'
            )
            # Print non-PNG files in this directory
            print_tree_non_png(node['children'], indent + 1, path_width, compact)
        else:
            brackets = '[' * (indent + 1) + ' ' + key + ' ' + ']' * (indent + 1)
            print(f'{"  " * indent}{brackets:<{path_width}}')
            print_tree(node['children'], indent + 1, path_width, compact)

    # Print files after directories (only if not in aggregated directory)
    if compact and files:
        # Compact mode: print all files on one line
        file_entries = []
        for key in files:
            node = tree[key]
            display_name = key[:-7] if key.endswith('.svelte') else key
            file = node['file']
            size_str = format_size(file['size'])
            lines_str = str(file['line_count']) if file['line_count'] != '-' else '-'
            file_entries.append(f'{display_name} {size_str} {lines_str}')
        print('  ' * indent + ', '.join(file_entries))
    else:
        # Normal mode: print each file on its own line
        for key in files:
            node = tree[key]
            # Strip .svelte extension for compact display
            display_name = key[:-7] if key.endswith('.svelte') else key
            display_path = '  ' * indent + display_name
            file = node['file']

            # Format imports_count and imported_count
            imports_display = (
                file['imports_count']
                if file['imports_count'] != 0 and file['imports_count'] != '-'
                else '-'
            )
            imported_display = (
                file['imported_count']
                if file['imported_count'] != 0 and file['imported_count'] != '-'
                else '-'
            )

            if file['line_count'] == '-':
                print(
                    f'{display_path:<{path_width}} {format_size(file["size"]):>8} {file["line_count"]:>6} {imports_display:>7} {imported_display:>8}'
                )
            else:
                print(
                    f'{display_path:<{path_width}} {format_size(file["size"]):>8} {file["line_count"]:>6} {imports_display:>7} {imported_display:>8}'
                )


def main():
    parser = argparse.ArgumentParser(description='Project Overview Script')
    parser.add_argument('--compact', '-c', action='store_true', help='Compact mode: list files on one line per directory')
    parser.add_argument('--ultra', '-u', action='store_true', help='Ultra-compact mode: just file paths with size/lines, no tree structure')
    args = parser.parse_args()

    if args.ultra:
        # Ultra mode: simple flat list
        results = scan_dir(project_dir)
        
        # Build tree structure for Explorer-style sorting
        tree = {}
        for f in results:
            parts = f['path'].split('/')
            current = tree
            for i, part in enumerate(parts):
                is_file = (i == len(parts) - 1)
                if is_file:
                    current[part] = {'type': 'file', 'data': f}
                else:
                    if part not in current:
                        current[part] = {'type': 'folder', 'children': {}}
                    current = current[part]['children']
        
        # Depth-first traversal to get sorted paths
        sorted_paths = []
        
        def traverse(node, path_prefix=''):
            # Separate folders and files
            folders = []
            files = []
            for name, item in node.items():
                if item['type'] == 'folder':
                    folders.append(name)
                else:
                    files.append(name)
            
            # Sort alphabetically
            folders.sort()
            files.sort()
            
            # Process folders first
            for name in folders:
                folder_path = f"{path_prefix}/{name}" if path_prefix else name
                sorted_paths.append(folder_path)
                traverse(node[name]['children'], folder_path)
            
            # Then files
            for name in files:
                file_path = f"{path_prefix}/{name}" if path_prefix else name
                sorted_paths.append(file_path)
        
        traverse(tree)
        
        # Create a path -> file mapping
        path_to_file = {f['path']: f for f in results}
        
        # Filter to only files (not folders) for output
        file_results = [path_to_file[p] for p in sorted_paths if p in path_to_file]
        
        # Calculate column widths for alignment
        max_size_width = max((len(format_size(f['size'], include_unit=False)) for f in file_results if f['line_count'] != '-'), default=8)
        max_lines_width = max((len(str(f['line_count'])) for f in file_results if f['line_count'] != '-'), default=4)
        max_index_width = len(str(len(file_results)))
        # Collect output lines
        output_lines = []
        # Print header with shortened labels to fit column widths
        index_label = '#'[:max_index_width]
        size_label = 'KB'[:max_size_width]
        lines_label = 'Ln'[:max_lines_width]
        header = f"{index_label:>{max_index_width}} {size_label:>{max_size_width}} {lines_label:>{max_lines_width}} Path"
        print(header)
        output_lines.append(header)
        for idx, file in enumerate(file_results, 1):
            if file['line_count'] != '-':
                size_str = format_size(file['size'], include_unit=False)
                lines_str = str(file['line_count'])
                line = f"{idx:>{max_index_width}} {size_str:>{max_size_width}} {lines_str:>{max_lines_width}} {file['path']}"
                print(line)
                output_lines.append(line)
        # Copy to clipboard
        pyperclip.copy('\n'.join(output_lines))
        print(f"\nCopied {len(output_lines)} lines to clipboard")
        return

    print('Project Overview (Universal)')
    print('=' * 80)
    print()

    results = scan_dir(project_dir)

    # Check _docs files for date prefix suggestions
    docs_dir = Path('_docs')
    date_suggestions = check_docs_date_prefixes(docs_dir)

    # Calculate maximum path length for dynamic column width
    max_path_len = max((len(f['path']) for f in results), default=4)
    path_width = min(max_path_len + 2, 60)
    total_width = path_width + 8 + 6 + 7 + 8 + 4

    header_format = f'%-{path_width}s %8s %6s %7s %8s'
    print(header_format % ('Path', 'Size', 'Lines', 'Imports', 'Imported'))
    print('-' * total_width)

    # Find common prefix
    if results:
        first_path = results[0]['path']
        common_len = len(first_path)

        for file in results:
            i = 0
            while (
                i < common_len
                and i < len(file['path'])
                and file['path'][i] == first_path[i]
            ):
                i += 1
            common_len = i
            if common_len == 0:
                break

        # Strip common prefix from all paths (only if prefix exists)
        # Find the last '/' in the common prefix to strip full directory
        if common_len > 0:
            last_slash = first_path.rfind('/', 0, common_len)
            if last_slash != -1:
                common_len = last_slash + 1  # Keep the slash

        for file in results:
            if common_len < len(file['path']):
                file['path'] = file['path'][common_len:]
            else:
                file['path'] = file['path']

        # Build type reference count map
        ref_map = build_type_reference_map(results)

        # Fill imported_count from ref_map
        for file in results:
            if file['imported_count'] != '-':
                file['imported_count'] = ref_map.get(file['path'], 0)

    # Build and print tree
    tree = build_tree(results)
    print_tree(tree, 0, path_width, args.compact)

    # Print summary
    print('-' * total_width)

    # Calculate totals for scripts
    script_results = [f for f in results if f['type'] == 'Script']
    script_size = sum(f['size'] for f in script_results)
    script_lines = sum(
        f['line_count'] for f in script_results if f['line_count'] != '-'
    )
    script_imports = sum(
        f['imports_count'] for f in script_results if f['imports_count'] != '-'
    )
    script_imported = sum(
        f['imported_count'] for f in script_results if f['imported_count'] != '-'
    )

    # Calculate totals for assets
    asset_results = [f for f in results if f['type'] == 'Asset']
    asset_size = sum(f['size'] for f in asset_results)
    asset_lines = sum(f['line_count'] for f in asset_results if f['line_count'] != '-')
    asset_imports = sum(
        f['imports_count'] for f in asset_results if f['imports_count'] != '-'
    )
    asset_imported = sum(
        f['imported_count'] for f in asset_results if f['imported_count'] != '-'
    )

    # Calculate overall totals
    total_size = sum(f['size'] for f in results)
    total_lines = sum(f['line_count'] for f in results if f['line_count'] != '-')
    total_imports = sum(
        f['imports_count'] for f in results if f['imports_count'] != '-'
    )
    total_imported = sum(
        f['imported_count'] for f in results if f['imported_count'] != '-'
    )

    # Print Scripts and Assets summaries
    print(
        f'{"Scripts":<{path_width}} {format_size(script_size):>8} {script_lines:>6} {script_imports:>7} {script_imported:>8}'
    )
    print(
        f'{"Assets":<{path_width}} {format_size(asset_size):>8} {asset_lines:>6} {asset_imports:>7} {asset_imported:>8}'
    )
    print('-' * total_width)
    print(
        f'{"Total":<{path_width}} {format_size(total_size):>8} {total_lines:>6} {total_imports:>7} {total_imported:>8}'
    )
    print()
    print(f'Total files: {len(results)}')
    print(f'Script files: {len(script_results)}')
    print(f'Asset files: {len(asset_results)}')
    end_time = time.time()
    print(f'Duration: {end_time - start_time:.2f}s')

    # Print date prefix suggestions for _docs files
    if date_suggestions:
        print()
        print('=' * 80)
        print('Date Prefix Suggestions for _docs/')
        print('=' * 80)
        print()
        print('Files starting with a letter should be prefixed with YYYY-MM-DD_')
        print('Using oldest of creation/modification date')
        print()
        for suggestion in sorted(date_suggestions, key=lambda x: x['oldest_date']):
            print(
                f'  {suggestion["original"]} → {suggestion["suggested"]} (based on {suggestion["date"]})'
            )

        print()
        response = input('Rename these files? (Y/N): ')
        if response.upper() == 'Y':
            renamed_count = 0
            for suggestion in sorted(date_suggestions, key=lambda x: x['oldest_date']):
                original_path = docs_dir / suggestion['original']
                new_path = docs_dir / suggestion['suggested']
                try:
                    original_path.rename(new_path)
                    print(
                        f'  Renamed: {suggestion["original"]} → {suggestion["suggested"]}'
                    )
                    renamed_count += 1
                except Exception as e:
                    print(f'  Error renaming {suggestion["original"]}: {e}')
            print(f'  Renamed {renamed_count} files')
        else:
            print('  Skipped renaming')


if __name__ == '__main__':
    main()
