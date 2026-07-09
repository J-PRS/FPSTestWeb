#!/usr/bin/env python3
import subprocess
import os
import sys
from pathlib import Path

# Change to script directory
script_dir = Path(__file__).parent
os.chdir(script_dir)

# Create reports directory
reports_dir = script_dir / "reports" / "analysis"
reports_dir.mkdir(parents=True, exist_ok=True)

def run_tool(name, command, output_file):
    print(f"Running {name}...")
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace'
    )
    
    # Save output
    with open(output_file, 'w', encoding='utf-8') as f:
        if result.stdout:
            f.write(result.stdout)
        if result.stderr:
            f.write(result.stderr)
    
    # Only print completion status with line count
    trimmed_output = result.stdout.strip() if result.stdout else ''
    line_count = len(trimmed_output.split('\n')) if trimmed_output else 0
    if result.returncode == 0:
        print(f"  ✓ {name} complete ({line_count} lines)")
    else:
        print(f"  ✗ {name} failed (exit code {result.returncode}, {line_count} lines)")
    print()
    return result.returncode

# Run analysis tools
run_tool("knip", "node node_modules\\knip\\bin\\knip.js --production --strict", reports_dir / "knip.txt")
run_tool("tsc", "npx tsc --noEmit", reports_dir / "tsc.txt")
run_tool("eslint", "npx eslint src", reports_dir / "eslint.txt")
run_tool("jscpd", "npx jscpd src", reports_dir / "jscpd.txt")
run_tool("oxlint", "node node_modules\\oxlint\\bin\\oxlint src", reports_dir / "oxlint.txt")

print("Analysis complete.")
