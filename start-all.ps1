# ===============================================
# start-all.ps1 - Fully Self-Contained Node + ngrok
# ===============================================

# -----------------------
# Configuration
# -----------------------
$defaultPorts = @{ api = 8080; admin = 8081 }
$ngrokRegion = "auto"
$ngrokAuthToken = "ak_39V6zO2CEe59hykS7aEZm0673Xr"  # <-- Your ngrok token
$maxRetries = 5
$retryDelay = 2

# Postgres configuration (set via environment variables for security)
$env:PGHOST = "localhost"
$env:PGPORT = "5432"
$env:PGUSER = "postgres"
$env:PGPASSWORD = "yourpassword"
$env:PGDATABASE = "rideshare_scheduler"

# -----------------------
# Function: Cleanup old processes
# -----------------------
$cleanup = {
    Write-Host "Stopping old ngrok and Node processes..."
    Get-Process ngrok -ErrorAction SilentlyContinue | ForEach-Object { if ($_ -and -not $_.HasExited) { $_ | Stop-Process -Force } }
    Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { if ($_ -and -not $_.HasExited) { $_ | Stop-Process -Force } }
}

& $cleanup

# -----------------------
# Function: Ensure ngrok is installed
# -----------------------
function Ensure-Ngrok {
    $ngrokPath = "$PSScriptRoot\ngrok.exe"
    if (-Not (Test-Path $ngrokPath)) {
        Write-Host "ngrok not found. Downloading latest version..."
        $ngrokZip = "$PSScriptRoot\ngrok.zip"
        Invoke-WebRequest -Uri "https://bin.equinox.io/c/4VmDzA7iaHb/ngrok-stable-windows-amd64.zip" -OutFile $ngrokZip
        Expand-Archive -LiteralPath $ngrokZip -DestinationPath $PSScriptRoot -Force
        Remove-Item $ngrokZip
        Write-Host "ngrok downloaded successfully."
    }

    # Set auth token
    & $ngrokPath authtoken $ngrokAuthToken | Out-Null
    return $ngrokPath
}

$ngrokExe = Ensure-Ngrok

# -----------------------
# Function: Test Postgres connection
# -----------------------
function Test-PostgresConnection {
    try {
        $result = psql -c "\conninfo" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Postgres connection OK"
            return $true
        } else {
            Write-Host "❌ Failed to connect to Postgres:`n$result"
            return $false
        }
    } catch {
        Write-Host "❌ Error connecting to Postgres: $_"
        return $false
    }
}

if (-not (Test-PostgresConnection)) { exit 1 }

# -----------------------
# Function: Find free port
# -----------------------
function Get-FreePort($startPort) {
    for ($p = $startPort; $p -lt 65535; $p++) {
        $used = (Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)
        if (-not $used) { return $p }
    }
    throw "No free port found starting from $startPort"
}

# -----------------------
# Function: Start Node server
# -----------------------
function Start-NodeServer($name, $desiredPort) {
    $port = Get-FreePort $desiredPort
    Write-Host "Starting Node server for $name on port $port..."
    $process = Start-Process -FilePath "node" -ArgumentList "server.js", $port -PassThru
    return @{ Process = $process; Port = $port }
}

$apiServer = Start-NodeServer -name "api" -desiredPort $defaultPorts.api
$adminServer = Start-NodeServer -name "admin" -desiredPort $defaultPorts.admin

# -----------------------
# Function: Start ngrok tunnel with retries
# -----------------------
function Start-NgrokTunnel($name, $port) {
    $attempt = 1
    while ($attempt -le $maxRetries) {
        Write-Host "Starting ngrok tunnel for $name on port $port (attempt $attempt)..."
        try {
            Start-Process -FilePath $ngrokExe -ArgumentList "http", "$port", "--region=$ngrokRegion", "--log=stdout" -NoNewWindow -PassThru | Out-Null
            Start-Sleep -Seconds 2

            $tunnels = Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -ErrorAction SilentlyContinue
            $tunnel = $tunnels.tunnels | Where-Object { $_.config.addr -eq "http://localhost:$port" } | Select-Object -First 1

            if ($tunnel) {
                Write-Host "✅ ngrok tunnel for $name is running at $($tunnel.public_url)"
                return $tunnel.public_url
            }
        } catch { Write-Host "⚠ Failed: $_" }

        Start-Sleep -Seconds $retryDelay
        $attempt++
    }

    Write-Host "❌ Could not start ngrok tunnel for $name"
    return $null
}

$apiUrl = Start-NgrokTunnel -name "api" -port $apiServer.Port
$adminUrl = Start-NgrokTunnel -name "admin" -port $adminServer.Port

# -----------------------
# Self-healing tunnels
# -----------------------
function Monitor-NgrokTunnel($name, $port) {
    while ($true) {
        Start-Sleep -Seconds 5
        try {
            $tunnels = Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -ErrorAction SilentlyContinue
            $tunnel = $tunnels.tunnels | Where-Object { $_.config.addr -eq "http://localhost:$port" }
            if (-not $tunnel) {
                Write-Host "⚠ ngrok tunnel for $name went down. Restarting..."
                Start-NgrokTunnel -name $name -port $port | Out-Null
            }
        } catch { }
    }
}

Start-Job { Monitor-NgrokTunnel "api" $apiServer.Port } | Out-Null
Start-Job { Monitor-NgrokTunnel "admin" $adminServer.Port } | Out-Null

# -----------------------
# Summary
# -----------------------
Write-Host ""
Write-Host "==============================="
Write-Host "✅ Node servers and ngrok tunnels status"
Write-Host "API:    $apiUrl"
Write-Host "Admin:  $adminUrl"
Write-Host "==============================="
Write-Host ""
Write-Host "Press Ctrl+C to stop servers..."

# Keep script running
try { while ($true) { Start-Sleep -Seconds 5 } } finally { & $cleanup }
