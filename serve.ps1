# Local static file server for development (PowerShell only, no install required).
#
# Browser Geolocation requires a secure context. Opening index.html via file://
# will NOT get location permission, so we serve it over http://localhost instead.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\serve.ps1
# Stop:   Ctrl + C
#
# NOTE: This server has no authentication and binds to localhost only.
#       It is intended for local development, not for exposing to a network.

param(
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
    $listener.Start()
}
catch {
    Write-Host "Cannot bind port $Port. Try another one: .\serve.ps1 -Port 8081" -ForegroundColor Red
    throw
}

Write-Host ""
Write-Host "  Team live location sharing - dev server running" -ForegroundColor Cyan
Write-Host "  http://localhost:$Port/" -ForegroundColor Green
Write-Host "  Press Ctrl + C to stop"
Write-Host ""

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $relative = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
        if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }

        # Resolve the path defensively: a malformed URL (illegal characters, a
        # bare drive letter, ...) must return 400 instead of killing the server.
        $fullPath = $null
        try {
            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        }
        catch {
            $response.StatusCode = 400
            $response.Close()
            Write-Host ("  400  /" + $relative) -ForegroundColor Red
            continue
        }

        # Prevent directory traversal.
        if (-not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $response.StatusCode = 403
            $response.Close()
            Write-Host ("  403  /" + $relative) -ForegroundColor Red
            continue
        }

        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $ext = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
            if ($mime.ContainsKey($ext)) {
                $response.ContentType = $mime[$ext]
            }
            else {
                $response.ContentType = 'application/octet-stream'
            }
            $response.Headers.Add('Cache-Control', 'no-store')
            $response.StatusCode = 200
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host ("  200  /" + $relative)
        }
        else {
            $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $response.StatusCode = 404
            $response.ContentType = 'text/plain; charset=utf-8'
            $response.ContentLength64 = $body.Length
            $response.OutputStream.Write($body, 0, $body.Length)
            Write-Host ("  404  /" + $relative) -ForegroundColor DarkYellow
        }

        $response.Close()
    }
}
finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "Server stopped."
}
