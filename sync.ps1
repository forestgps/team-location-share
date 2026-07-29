# Commit and push everything in one step, then wait for the GitHub Pages build.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\sync.ps1
#   powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Message "fix marker color"
#
# After a successful push, GitHub Pages rebuilds automatically and the live site
# at https://forestgps.github.io/team-location-share/ updates within a minute.

param(
    [string]$Message = "",
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

# git is not on PATH by default on this machine; fall back to the install path.
$git = 'git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $candidate = 'C:\Program Files\Git\cmd\git.exe'
    if (-not (Test-Path -LiteralPath $candidate)) {
        Write-Host "git not found. Install Git for Windows first." -ForegroundColor Red
        exit 1
    }
    $git = $candidate
}

# gh ships here as a portable zip; git's credential helper needs it reachable.
$env:PATH = 'C:\Program Files\Git\cmd;' + (Join-Path $root 'tools\gh\bin') + ';' + $env:PATH

# Fail fast instead of blocking forever on an interactive credential prompt.
$env:GIT_TERMINAL_PROMPT = '0'

Set-Location $root

# Anything to do?
$dirty = & $git status --porcelain
if ([string]::IsNullOrWhiteSpace($dirty)) {
    Write-Host "No local changes to publish." -ForegroundColor DarkGray
}
else {
    Write-Host "Changes to publish:" -ForegroundColor Cyan
    $dirty -split "`n" | Where-Object { $_ } | ForEach-Object { Write-Host "  $_" }

    if ([string]::IsNullOrWhiteSpace($Message)) {
        $Message = "update: " + (Get-Date -Format 'yyyy-MM-dd HH:mm')
    }

    & $git add -A
    & $git commit -m $Message
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Commit failed." -ForegroundColor Red
        exit 1
    }
}

# Bring in anything that was edited elsewhere (github.dev, another PC, a phone)
# before pushing. Without this the push is rejected, and forcing it would throw
# away someone else's work.
Write-Host "Fetching remote changes ..." -ForegroundColor Cyan
& $git pull --rebase origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Could not merge remote changes automatically." -ForegroundColor Red
    Write-Host "The same lines were probably edited both here and on GitHub." -ForegroundColor Red
    Write-Host "Fix the marked conflicts, then run:" -ForegroundColor Red
    Write-Host "  git add <file> ; git rebase --continue ; .\sync.ps1"
    Write-Host "Or abandon the local rebase with:  git rebase --abort"
    exit 1
}

Write-Host "Pushing to origin/main ..." -ForegroundColor Cyan
& $git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed. If this is an auth problem, run:" -ForegroundColor Red
    Write-Host "  $root\tools\gh\bin\gh.exe auth login --hostname github.com --git-protocol https --web"
    exit 1
}

Write-Host ""
Write-Host "Pushed. Live site: https://forestgps.github.io/team-location-share/" -ForegroundColor Green

if ($NoWait) { exit 0 }

# Poll the Pages build so you know when the live site actually has the change.
$gh = Join-Path $root 'tools\gh\bin\gh.exe'
if (-not (Test-Path -LiteralPath $gh)) { exit 0 }

$head = (& $git rev-parse HEAD).Trim()
Write-Host "Waiting for the GitHub Pages build of $($head.Substring(0,7)) ..." -ForegroundColor Cyan

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 6
    $json = & $gh api 'repos/forestgps/team-location-share/pages/builds/latest' 2>$null
    if (-not $json) { continue }
    try { $build = $json | ConvertFrom-Json } catch { continue }

    if ($build.commit -eq $head -and $build.status -eq 'built') {
        Write-Host "Build complete. The live site is up to date." -ForegroundColor Green
        exit 0
    }
    if ($build.commit -eq $head -and $build.status -eq 'errored') {
        Write-Host "Pages build failed: $($build.error.message)" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Still building. Check: https://github.com/forestgps/team-location-share/deployments" -ForegroundColor DarkYellow
