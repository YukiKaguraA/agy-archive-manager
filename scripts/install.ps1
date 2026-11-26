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

function Sync-Directory {
    param(
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)][string]$DestDir
    )

    $srcRoot = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\', '/')
    $dstRoot = [System.IO.Path]::GetFullPath($DestDir).TrimEnd('\', '/')
    New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null

    $expectedDirs = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $expectedFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    # Copy/update files in place without removing directories that may be locked as a running sidecar's CWD.
    Get-ChildItem -LiteralPath $srcRoot -Directory -Recurse | ForEach-Object {
        $rel = $_.FullName.Substring($srcRoot.Length + 1)
        [void]$expectedDirs.Add($rel)
        New-Item -ItemType Directory -Path (Join-Path $dstRoot $rel) -Force | Out-Null
    }

    Get-ChildItem -LiteralPath $srcRoot -File -Recurse | ForEach-Object {
        $rel = $_.FullName.Substring($srcRoot.Length + 1)
        [void]$expectedFiles.Add($rel)
        $dstFile = Join-Path $dstRoot $rel
        $dstParent = Split-Path -Parent $dstFile
        if (-not (Test-Path -LiteralPath $dstParent -PathType Container)) {
            New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $_.FullName -Destination $dstFile -Force
    }

    # Prune stale files and obsolete empty subdirectories after the new payload is in place.
    Get-ChildItem -LiteralPath $dstRoot -File -Recurse | ForEach-Object {
        $rel = $_.FullName.Substring($dstRoot.Length + 1)
        if (-not $expectedFiles.Contains($rel)) {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }

    Get-ChildItem -LiteralPath $dstRoot -Directory -Recurse |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
            $rel = $_.FullName.Substring($dstRoot.Length + 1)
            if (-not $expectedDirs.Contains($rel)) {
                try {
                    Remove-Item -LiteralPath $_.FullName -Force
                } catch [System.IO.IOException] {
                    Write-Warning "Skipped removing locked obsolete directory: $($_.FullName)"
                }
            }
        }
}

$files = @('plugin.json', 'logo.svg', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE')
foreach ($f in $files) {
    $src = Join-Path $repoRoot $f
    if (Test-Path -LiteralPath $src -PathType Leaf) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $TargetDir $f) -Force
    }
}

$screenshots = Join-Path $repoRoot 'docs/screenshots'
if (Test-Path -LiteralPath $screenshots -PathType Container) {
    Sync-Directory -SourceDir $screenshots -DestDir (Join-Path $TargetDir 'docs\screenshots')
}

$dirs = @('skills', 'sidecars')
foreach ($d in $dirs) {
    $src = Join-Path $repoRoot $d
    $dst = Join-Path $TargetDir $d
    if (Test-Path -LiteralPath $src -PathType Container) {
        Sync-Directory -SourceDir $src -DestDir $dst
    }
}

Write-Host "[OK] Installed/updated archive-manager at: $TargetDir" -ForegroundColor Green
Write-Host "Enable 'Session Manager (archive-manager)' in Antigravity Customizations -> Plugins on first install."
