<#
.SYNOPSIS
    Install or update the archive-manager plugin into Antigravity's local plugins directory.
#>
[CmdletBinding()]
param(
    [string]$TargetDir = (Join-Path $env:USERPROFILE '.gemini\config\plugins\archive-manager')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

$files = @('plugin.json', 'logo.svg', 'README.md', 'README.en.md', 'LICENSE')
foreach ($f in $files) {
    $src = Join-Path $repoRoot $f
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $TargetDir $f) -Force
    }
}

$screenshots = Join-Path $repoRoot 'docs/screenshots'
if (Test-Path -LiteralPath $screenshots -PathType Container) {
    $targetDocs = Join-Path $TargetDir 'docs'
    $targetScreenshots = Join-Path $targetDocs 'screenshots'
    New-Item -ItemType Directory -Path $targetDocs -Force | Out-Null
    if (Test-Path -LiteralPath $targetScreenshots) {
        Remove-Item -LiteralPath $targetScreenshots -Recurse -Force
    }
    Copy-Item -LiteralPath $screenshots -Destination $targetDocs -Recurse -Force
}

$dirs = @('skills', 'sidecars')
foreach ($d in $dirs) {
    $src = Join-Path $repoRoot $d
    $dst = Join-Path $TargetDir $d
    if (Test-Path $src) {
        if (Test-Path $dst) {
            Remove-Item -Path $dst -Recurse -Force
        }
        Copy-Item -Path $src -Destination $TargetDir -Recurse -Force
    }
}

Write-Host "[OK] Installed/updated archive-manager at: $TargetDir" -ForegroundColor Green
Write-Host "Enable 'Session Manager (archive-manager)' in Antigravity Customizations -> Plugins on first install."
