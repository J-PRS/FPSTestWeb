# Function to find what process is using a port
function Get-PortProcess {
    param([int]$Port)
    # Check for any state (LISTENING, ESTABLISHED, TIME_WAIT, CLOSE_WAIT) as they can all block the port
    $result = netstat -ano | Select-String ":$Port\s"
    if ($result) {
        $parts = $result.Line -split '\s+'
        $processId = $parts[-1]
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            return @{
                Port = $Port
                PID = $processId
                ProcessName = $process.ProcessName
                Path = $process.Path
                State = ($result.Line -split '\s+')[-2]
            }
        }
    }
    return $null
}

# Start server and client
Write-Host "Starting server and client..."

# Check ports before starting
$ports = @(5300)
Write-Host "Checking port 5300..."
foreach ($port in $ports) {
    $portInfo = Get-PortProcess -Port $port
    if ($portInfo) {
        Write-Host "Port $($portInfo.Port) is in use by:"
        Write-Host "  PID: $($portInfo.PID)"
        Write-Host "  Process: $($portInfo.ProcessName)"
        Write-Host "  Path: $($portInfo.Path)"
        Write-Host "  State: $($portInfo.State)"
    } else {
        Write-Host "Port $port is available"
    }
}

# Start server as admin in popup window
$serverArgs = @(
    '-NoExit',
    '-Command',
    'cd C:\TEMP\_WEB\FPSWebTest\server; npm run dev; $Host.UI.RawUI.WindowTitle = "FPS Server"'
)
Start-Process powershell -ArgumentList $serverArgs -Verb RunAs

# Wait a moment for server to start
Start-Sleep -Seconds 2

# Start client in current CLI window
Write-Host "Starting client in this window..."
Set-Location C:\TEMP\_WEB\FPSWebTest\client
npm run dev
