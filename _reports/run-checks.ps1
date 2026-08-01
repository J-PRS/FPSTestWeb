# run-checks.ps1
# Runs all static-analysis checks and writes separate reports to _reports/AUTO/.
# Usage:  powershell -ExecutionPolicy Bypass -File run-checks.ps1
#         (or just run it from any shell: pwsh run-checks.ps1)
#
# Outputs:
#   _reports/AUTO/eslint-report.txt                  — all eslint warnings/errors
#   _reports/AUTO/eslint-cognitive-complexity.txt    — only sonarjs/cognitive-complexity
#   _reports/AUTO/tsc-report.txt                     — TypeScript compiler diagnostics
#   _reports/AUTO/knip-report.txt                    — dead code / unused exports
#   _reports/AUTO/summary.txt                        — one-line pass/fail per check

$ErrorActionPreference = 'Continue'

# Resolve paths relative to this script so it works from any CWD.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir          # FPSWebTest/
$ClientDir = Join-Path $RepoRoot 'client'
$ServerDir = Join-Path $RepoRoot 'server_bun'
$ReportDir = Join-Path $ScriptDir 'AUTO'

# Ensure the AUTO folder exists
if (-not (Test-Path $ReportDir)) {
    New-Item -ItemType Directory -Path $ReportDir -Force | Out-Null
}

$summaryLines = @()
$startTime = Get-Date

# ----------------------------------------------------------------------------
# 1. ESLint — full report (typescript-eslint recommended + sonarjs)
# ----------------------------------------------------------------------------
Write-Host "`n=== [1/4] ESLint (full) ===" -ForegroundColor Cyan
$eslintFull = Join-Path $ReportDir 'eslint-report.txt'
Push-Location $ClientDir
try {
    & npx eslint "src/**/*.ts" 2>&1 | Out-File -FilePath $eslintFull -Encoding utf8
    $eslintExit = $LASTEXITCODE
} finally {
    Pop-Location
}
$eslintCount = (Get-Content $eslintFull -ErrorAction SilentlyContinue | Measure-Object).Count
$summaryLines += "ESLint (full):            exit=$eslintExit  lines=$eslintCount  -> $eslintFull"
Write-Host "  -> $eslintFull ($eslintCount lines, exit $eslintExit)"

# ----------------------------------------------------------------------------
# 2. ESLint — cognitive-complexity only (separate file)
# ----------------------------------------------------------------------------
Write-Host "`n=== [2/4] ESLint (cognitive-complexity only) ===" -ForegroundColor Cyan
$eslintCog = Join-Path $ReportDir 'eslint-cognitive-complexity.txt'
if (Test-Path $eslintFull) {
    # Filter the full report to just cognitive-complexity lines + their file headers.
    # The stylish formatter prints a file path header line, then indented rule lines.
    $cogLines = @()
    $currentFile = $null
    foreach ($line in Get-Content $eslintFull) {
        if ($line -and -not $line.StartsWith(' ') -and $line -match '\.ts$') {
            $currentFile = $line
        } elseif ($line -match 'cognitive-complexity') {
            if ($currentFile) { $cogLines += $currentFile; $currentFile = $null }
            $cogLines += $line
        }
    }
    # Append the summary line if present
    foreach ($line in Get-Content $eslintFull) {
        if ($line -match '^\s*[✔✖].*problems') { $cogLines += $line }
    }
    if ($cogLines.Count -eq 0) { $cogLines += '(no cognitive-complexity warnings)' }
    $cogLines | Out-File -FilePath $eslintCog -Encoding utf8
}
$cogCount = (Get-Content $eslintCog -ErrorAction SilentlyContinue | Measure-Object).Count
$summaryLines += "ESLint (cognitive):      lines=$cogCount  -> $eslintCog"
Write-Host "  -> $eslintCog ($cogCount lines)"

# ----------------------------------------------------------------------------
# 3. TypeScript compiler — client + server
# ----------------------------------------------------------------------------
Write-Host "`n=== [3/4] TypeScript (tsc --noEmit) ===" -ForegroundColor Cyan
$tscReport = Join-Path $ReportDir 'tsc-report.txt'
$tscContent = @()

# Client
$tscContent += "=== CLIENT (client/tsconfig.json) ==="
Push-Location $ClientDir
try {
    $clientTsc = & npx tsc --noEmit --pretty false 2>&1
    $clientTscExit = $LASTEXITCODE
} finally {
    Pop-Location
}
$tscContent += $clientTsc
$tscContent += "exit=$clientTscExit"
$tscContent += ""

# Server (uses the client's tsc since server_bun has no typescript dep;
# Bun typechecks natively at runtime, but tsc catches type errors pre-deploy)
$tscContent += "=== SERVER (server_bun/tsconfig.json) ==="
Push-Location $ServerDir
try {
    $serverTsc = & npx --prefix $ClientDir tsc --noEmit --pretty false --project $ServerDir\tsconfig.json 2>&1
    $serverTscExit = $LASTEXITCODE
} finally {
    Pop-Location
}
# Filter out client/demo errors that leak in via the server tsconfig include paths
$serverTscFiltered = $serverTsc | Where-Object { $_ -notmatch '\\client\\src\\demo\\' -and $_ -notmatch 'tests\\demo-serializer' }
$tscContent += $serverTscFiltered
$tscContent += "exit=$serverTscExit"

$tscContent | Out-File -FilePath $tscReport -Encoding utf8
$tscCount = (Get-Content $tscReport -ErrorAction SilentlyContinue | Measure-Object).Count
$hasClientErrors = ($clientTsc | Select-String 'error TS').Count
$hasServerErrors = ($serverTscFiltered | Select-String 'error TS').Count
$summaryLines += "TypeScript:              clientErrors=$hasClientErrors serverErrors=$hasServerErrors  -> $tscReport"
Write-Host "  -> $tscReport ($tscCount lines, client errors: $hasClientErrors, server errors: $hasServerErrors)"

# ----------------------------------------------------------------------------
# 4. Knip — dead code / unused exports / unused dependencies
# ----------------------------------------------------------------------------
Write-Host "`n=== [4/4] Knip (dead code) ===" -ForegroundColor Cyan
$knipReport = Join-Path $ReportDir 'knip-report.txt'
Push-Location $ClientDir
try {
    & npx knip --no-exit-code 2>&1 | Out-File -FilePath $knipReport -Encoding utf8
    $knipExit = $LASTEXITCODE
} finally {
    Pop-Location
}
$knipCount = (Get-Content $knipReport -ErrorAction SilentlyContinue | Measure-Object).Count
$summaryLines += "Knip:                    exit=$knipExit  lines=$knipCount  -> $knipReport"
Write-Host "  -> $knipReport ($knipCount lines)"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
$elapsed = ((Get-Date) - $startTime).TotalSeconds
$summaryLines += ""
$summaryLines += "Completed in $([math]::Round($elapsed, 1))s"

$summaryPath = Join-Path $ReportDir 'summary.txt'
$summaryLines | Out-File -FilePath $summaryPath -Encoding utf8

Write-Host "`n=== SUMMARY ===" -ForegroundColor Green
$summaryLines | ForEach-Object { Write-Host "  $_" }
Write-Host "`nAll reports written to: $ReportDir" -ForegroundColor Green
