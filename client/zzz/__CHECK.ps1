# Auto-check script - PowerShell version

$root = $PSScriptRoot
$ac = Join-Path $root "reports\AUTO_CHECK"
New-Item -ItemType Directory -Path $ac -Force | Out-Null

$jobs = @(
    @{Cmd = "npx -y oxlint"; Name = "1 - oxlint"; Env = @{NO_COLOR = "1" } },
    @{Cmd = "npx -y oxlint --quiet"; Name = "1a - oxlint-quiet"; Env = @{NO_COLOR = "1" } },
    @{Cmd = "npx -y oxlint --deny-warnings"; Name = "1b - oxlint-strict"; Env = @{NO_COLOR = "1" } },
    @{Cmd = "npx -y depcheck --ignore-dirs=zzz,merge"; Name = "2 - depcheck" },
    @{Cmd = "npm run knip"; Name = "3 - knip"; Env = @{NO_COLOR = "1" } },
    @{Cmd = "npx -y jscpd src"; Name = "4 - jscpd"; Env = @{FORCE_COLOR = "0" } },
    @{Cmd = "npx -y prettier --check src"; Name = "5 - prettier"; Env = @{NO_COLOR = "1" } },
    @{Cmd = "npx eslint src"; Name = "6 - eslint"; Env = @{NO_COLOR = "1" } },
    @{Cmd = "npm run check:plain"; Name = "7 - svelte-check" },
    @{Cmd = "npm audit --production"; Name = "8 - npm-audit-prod" }
)

function Invoke-Check {
    param($Cmd, $Name, $EnvVars)
    
    $start = Get-Date
    
    # Set environment variables if needed
    if ($EnvVars) {
        $EnvVars.GetEnumerator() | ForEach-Object { 
            [System.Environment]::SetEnvironmentVariable($_.Key, $_.Value, "Process")
        }
    }
    
    # Run command and capture output
    Start-Process -FilePath "cmd" -ArgumentList "/c", $Cmd -WorkingDirectory $root -NoNewWindow -Wait -RedirectStandardOutput "$ac\$Name.txt" -RedirectStandardError "$ac\$Name.err" | Out-Null
    
    $elapsed = [int]((Get-Date) - $start).TotalMilliseconds
    
    # Combine stdout and stderr, clean up paths
    $content = ""
    if (Test-Path "$ac\$Name.txt") {
        $content += Get-Content "$ac\$Name.txt" -Raw
    }
    if (Test-Path "$ac\$Name.err") {
        $content += Get-Content "$ac\$Name.err" -Raw
        Remove-Item "$ac\$Name.err"
    }
    
    $content = $content -replace [regex]::Escape($root + "\"), ""
    $content = $content -replace [regex]::Escape($root + "/"), ""
    $content | Out-File -FilePath "$ac\$Name.txt" -Encoding utf8 -NoNewline
    
    return $elapsed
}

Write-Host "Starting analysis.."
$totalStart = Get-Date

$jobs | ForEach-Object {
    $job = $_
    try {
        $elapsed = Invoke-Check -Cmd $job.Cmd -Name $job.Name -EnvVars $job.Env
        Write-Host "$($job.Name) $elapsed ms"
    }
    catch {
        Write-Host "$($job.Name) failed $($_.Exception.Message)"
    }
}

$total = [int]((Get-Date) - $totalStart).TotalMilliseconds
Write-Host "total $total ms"