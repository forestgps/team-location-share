# Creates the release keystore (if missing) and writes the Digital Asset Links file
# that lets the Android app open the site without a browser address bar.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\make-assetlinks.ps1
#
# What it does
#   1. creates android\release.keystore if it does not exist yet
#   2. writes android\keystore.properties (read by app\build.gradle, never committed)
#   3. reads the SHA-256 certificate fingerprint
#   4. writes ..\.well-known\assetlinks.json with that fingerprint
#
# The keystore signs your app. KEEP IT SAFE: if you lose it you cannot publish an
# update that Android will accept as the same app.

param(
    [string]$Alias = 'teamloc',
    [string]$ApplicationId = 'kr.teamloc.share',
    [string]$StorePassword = '',
    [int]$ValidityDays = 10950 # 30 years
)

$ErrorActionPreference = 'Stop'
$here = [System.IO.Path]::GetFullPath($PSScriptRoot)
$webRoot = [System.IO.Path]::GetFullPath((Join-Path $here '..'))
$keystore = Join-Path $here 'release.keystore'
$propsFile = Join-Path $here 'keystore.properties'

# --- locate keytool (ships with the JDK) ---
$keytool = 'keytool'
if (-not (Get-Command keytool -ErrorAction SilentlyContinue)) {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME 'bin\keytool.exe') }
    $candidates += Get-ChildItem -Path 'C:\Program Files\Eclipse Adoptium','C:\Program Files\Java' `
        -Filter 'keytool.exe' -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }

    $found = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $found) {
        Write-Host "keytool not found. Install a JDK 17 first." -ForegroundColor Red
        exit 1
    }
    $keytool = $found
}
Write-Host "keytool: $keytool" -ForegroundColor DarkGray

# --- 1. keystore ---
if (-not (Test-Path -LiteralPath $keystore)) {
    if ([string]::IsNullOrWhiteSpace($StorePassword)) {
        $secure = Read-Host "Enter a password for the new keystore (remember it!)" -AsSecureString
        $StorePassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }

    Write-Host "Creating $keystore ..." -ForegroundColor Cyan
    & $keytool -genkeypair -v `
        -keystore $keystore `
        -alias $Alias `
        -keyalg RSA -keysize 2048 `
        -validity $ValidityDays `
        -storepass $StorePassword -keypass $StorePassword `
        -dname "CN=Team Location Share, OU=Field, O=Team, L=Seoul, C=KR"
    if ($LASTEXITCODE -ne 0) { throw "keystore creation failed" }
}
else {
    Write-Host "Using existing keystore: $keystore" -ForegroundColor DarkGray
    if ([string]::IsNullOrWhiteSpace($StorePassword)) {
        $secure = Read-Host "Enter the keystore password" -AsSecureString
        $StorePassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
}

# --- 2. keystore.properties (gitignored) ---
@(
    "storeFile=release.keystore",
    "storePassword=$StorePassword",
    "keyAlias=$Alias",
    "keyPassword=$StorePassword"
) | Set-Content -LiteralPath $propsFile -Encoding ASCII
Write-Host "Wrote $propsFile" -ForegroundColor Green

# --- 3. SHA-256 fingerprint ---
$listing = & $keytool -list -v -keystore $keystore -alias $Alias -storepass $StorePassword
$match = [regex]::Match(($listing -join "`n"), 'SHA256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})')
if (-not $match.Success) {
    Write-Host "Could not read the SHA-256 fingerprint." -ForegroundColor Red
    exit 1
}
$fingerprint = $match.Groups[1].Value.ToUpperInvariant()
Write-Host "SHA-256: $fingerprint" -ForegroundColor Green

# --- 4. assetlinks.json ---
$wellKnown = Join-Path $webRoot '.well-known'
New-Item -ItemType Directory -Force -Path $wellKnown | Out-Null

$json = @"
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "$ApplicationId",
      "sha256_cert_fingerprints": ["$fingerprint"]
    }
  }
]
"@
Set-Content -LiteralPath (Join-Path $wellKnown 'assetlinks.json') -Value $json -Encoding ASCII

Write-Host ""
Write-Host "Wrote $wellKnown\assetlinks.json" -ForegroundColor Green
Write-Host "Next: publish it with sync.ps1, then build the APK." -ForegroundColor Cyan
