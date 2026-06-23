# Start server and client
Write-Host "Starting server and client..."

# Start server as admin
$serverArgs = @(
    '-NoExit',
    '-Command',
    'cd C:\TEMP\_WEB\FPSWebTest\server; npm run dev'
)
Start-Process powershell -ArgumentList $serverArgs -Verb RunAs

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
