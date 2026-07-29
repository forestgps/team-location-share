# Publish the site to a public HTTPS URL so phones on ANY network (LTE/5G,
# other wifi) can join, not just devices on the same wifi.
#
# How it works:
#   1) starts the local static server (serve.ps1) on http://localhost:<Port>
#   2) starts a Cloudflare Quick Tunnel that maps a public
#      https://<random>.trycloudflare.com address to that local server
#
# Why a tunnel is needed: browser Geolocation only works in a secure context,
# so a plain LAN address like http://192.168.x.x will NOT get location
# permission. The tunnel gives real HTTPS.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\share.ps1
# Stop:   Ctrl + C  (both the tunnel and the local server are shut down)
#
# SECURITY: while this is running, ANYONE on the internet who has the URL can
# open the site. There is no login. The URL changes every run and dies when you
# press Ctrl + C. Do not leave it running unattended.

param(
    [int]$Port = 8080,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$toolsDir = Join-Path $root 'tools'
$exe = Join-Path $toolsDir 'cloudflared.exe'
$logDir = Join-Path $root '.logs'
$tunnelLog = Join-Path $logDir 'cloudflared.log'

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- 1. make sure cloudflared is available -----------------------------------
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "Downloading cloudflared (Cloudflare official release, ~50 MB)..." -ForegroundColor Cyan
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    $prev = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    }
    finally {
        $ProgressPreference = $prev
    }
    Write-Host "Downloaded to $exe" -ForegroundColor Green
}

# --- 2. start the local static server ---------------------------------------
$serverProc = $null
$alreadyUp = $false
try {
    $probe = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 3
    if ($probe.StatusCode -eq 200) { $alreadyUp = $true }
}
catch {
    $alreadyUp = $false
}

if ($alreadyUp) {
    Write-Host "Local server already running on port $Port - reusing it." -ForegroundColor DarkGray
}
else {
    Write-Host "Starting local server on port $Port ..." -ForegroundColor Cyan
    $serverProc = Start-Process -FilePath 'powershell' `
        -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'serve.ps1'), '-Port', $Port) `
        -WindowStyle Minimized -PassThru

    $ready = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 400
        try {
            $probe = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 2
            if ($probe.StatusCode -eq 200) { $ready = $true; break }
        }
        catch { }
    }
    if (-not $ready) {
        Write-Host "Local server did not come up on port $Port." -ForegroundColor Red
        if ($serverProc) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
        exit 1
    }
    Write-Host "Local server is up." -ForegroundColor Green
}

# --- 3. start the Cloudflare quick tunnel -----------------------------------
if (Test-Path -LiteralPath $tunnelLog) { Remove-Item -LiteralPath $tunnelLog -Force }

Write-Host "Opening public HTTPS tunnel ..." -ForegroundColor Cyan
$tunnelProc = Start-Process -FilePath $exe `
    -ArgumentList @(
        'tunnel', '--no-autoupdate',
        '--url', "http://localhost:$Port",
        # serve.ps1 binds only the "localhost" prefix, so the Host header must be
        # rewritten. Without this the origin answers 400 Bad Request.
        '--http-host-header', "localhost:$Port",
        '--logfile', $tunnelLog
    ) `
    -WindowStyle Hidden -PassThru

# cloudflared prints the generated hostname into the log; poll for it.
$publicUrl = $null
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-Path -LiteralPath $tunnelLog) {
        $text = Get-Content -LiteralPath $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($text) {
            $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
            if ($m.Success) { $publicUrl = $m.Value; break }
        }
    }
    if ($tunnelProc.HasExited) { break }
}

if (-not $publicUrl) {
    Write-Host "Could not obtain a public URL. See $tunnelLog for details." -ForegroundColor Red
    if (-not $tunnelProc.HasExited) { Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue }
    if ($serverProc) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

# Save the URL, and build a tiny page with a QR code for easy phone access.
Set-Content -LiteralPath (Join-Path $logDir 'public-url.txt') -Value $publicUrl -Encoding UTF8
try { Set-Clipboard -Value $publicUrl } catch { }

$line = '=' * 62
Write-Host ""
Write-Host $line -ForegroundColor DarkGray
Write-Host "  PUBLIC URL (works on any mobile network, HTTPS):"
Write-Host "  $publicUrl" -ForegroundColor Green
Write-Host ""
Write-Host "  Copied to clipboard. Share it with your team members."
Write-Host "  QR code for scanning: open invite.html in this folder"
Write-Host "  Press Ctrl + C here to shut everything down."
Write-Host $line -ForegroundColor DarkGray
Write-Host ""

# invite.html (a static UTF-8 file) reads this to render the URL + a QR code.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI, so any
# non-ASCII text written from here would come out mangled.
$urlJs = 'window.PUBLIC_URL = "' + $publicUrl + '";'
Set-Content -LiteralPath (Join-Path $root 'public-url.js') -Value $urlJs -Encoding ASCII

if (-not $NoBrowser) {
    Start-Process ("http://localhost:$Port/invite.html")
}

# --- 4. keep running until Ctrl + C -----------------------------------------
try {
    while (-not $tunnelProc.HasExited) {
        Start-Sleep -Seconds 1
    }
    Write-Host "Tunnel process exited. Check $tunnelLog" -ForegroundColor DarkYellow
}
finally {
    if (-not $tunnelProc.HasExited) { Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue }
    if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "Tunnel closed. The public URL is dead now." -ForegroundColor Cyan
}
