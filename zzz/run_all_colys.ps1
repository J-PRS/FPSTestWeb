# Start Colyseus server and client
Write-Host "Starting Colyseus server and client..."

# Fast port cleanup using netstat
function Kill-ProcessOnPort {
    param($port)
    $output = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
    if ($output) {
        $pid = ($output -split '\s+')[-1]
        Write-Host "Killing process $pid using port $port..."
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
}

Kill-ProcessOnPort 2567  # Colyseus server
Kill-ProcessOnPort 5174  # Vite client

# Start Colyseus server (no admin needed)
$serverArgs = @(
    '-NoExit',
    '-Command',
    'cd C:\TEMP\_WEB\FPSWebTest\server_colyseus; npm start'
)
Start-Process powershell -ArgumentList $serverArgs

# Wait a moment for server to start
Start-Sleep -Seconds 2

# Start client (no admin needed)
$clientArgs = @(
    '-NoExit',
    '-Command',
    'cd C:\TEMP\_WEB\FPSWebTest\client; npm run dev'
)
Start-Process powershell -ArgumentList $clientArgs

Write-Host "Both processes started."
