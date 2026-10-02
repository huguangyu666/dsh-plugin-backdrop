# ============================================================
# release-github.ps1 - one-command release for dsh-plugin-backdrop
#
# Usage:
#   .\release-github.ps1 -Version 0.2.0              # bump -> npm publish -> GitHub Release
#   .\release-github.ps1                             # GitHub release only (current version)
#   .\release-github.ps1 -Npm                        # force npm publish too (current version)
#   .\release-github.ps1 -Version 0.2.0 -SkipGitHub  # bump + npm publish only
#
# Idempotent: if the npm version already exists it is skipped; runs can be
# re-executed safely.
#
# Prereqs: git + npm logged-in; gh installed+authenticated. Self-heals gh PATH
# for common user install dirs (e.g. $USERPROFILE\bin\gh).
# ============================================================
param(
  [string]$Version,     # e.g. 0.2.0 or v0.2.0 (bumps package.json when given)
  [switch]$Npm,         # also run npm publish even without -Version
  [switch]$SkipGitHub   # npm publish only, skip the GitHub release
)

# NOTE: deliberately NO global $ErrorActionPreference='Stop' - PS 5.1 turns
# native stderr (git LF/CRLF warnings, esbuild progress) into terminating
# errors under Stop mode. We check exit codes explicitly instead.

# --- helpers ---
function Invoke-Checked {
  param([string]$Msg, [scriptblock]$Body)
  Write-Host "== $Msg ==" -ForegroundColor Cyan
  # native stderr must not terminate; capture both streams, surface text
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Body 2>&1
    foreach ($line in $out) { Write-Host $line }
    if ($LASTEXITCODE -ne 0) { throw "Step failed (exit $LASTEXITCODE): $Msg" }
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

# run a native command quietly (suppress stderr warnings), return its exit code
function Invoke-Quiet {
  param([scriptblock]$Body)
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Body 2>$null | Out-Null } catch { }
  finally { $ErrorActionPreference = $prevEAP }
  return $LASTEXITCODE
}

# --- self-heal gh PATH ---
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  foreach ($d in @("$env:USERPROFILE\bin\gh", "$env:LOCALAPPDATA\Programs\GitHub CLI\bin", "$env:LOCALAPPDATA\Microsoft\WinGet\Links")) {
    if (Test-Path "$d\gh.exe") { $env:PATH = $d + ';' + $env:PATH; break }
  }
}

$repo = 'dsh-plugin-backdrop'
$npmName = 'dsh-plugin-backdrop'

# --- resolve version (via npm to dodge PS 5.1 ANSI/UTF-8 misreads) ---
$current = (npm pkg get version).Trim('"').Trim()
if ($Version) { $v = $Version.TrimStart('v') } else { $v = $current }
$tag = "v$v"
$tgz = "dsh-plugin-backdrop-$v.tgz"
$doNpmPublish = $Npm -or [bool]$Version

if ($v -ne $current) {
  Write-Host "Version: $current -> $v"
  Invoke-Checked "bump package.json to $v" { npm pkg set version=$v }
} else {
  Write-Host "Version: $v (package.json already at this version)" -ForegroundColor Yellow
}

# --- 1) npm publish (skipped if the version already exists) ---
if ($doNpmPublish) {
  $code = Invoke-Quiet { npm view "$npmName@$v" version }
  if ($code -eq 0) {
    Write-Host "npm: $v already published, skipping" -ForegroundColor Yellow
  } else {
    $step = if ($SkipGitHub) { "npm publish $v (with --SkipGitHub)" } else { "npm publish $v" }
    Invoke-Checked $step { npm publish }
  }
}

if ($SkipGitHub) { Write-Host 'Skipped GitHub steps (--SkipGitHub). Done.'; exit 0 }

# --- 2) pack the tgz (GitHub release asset) ---
if (-not (Test-Path $tgz)) {
  Invoke-Checked "npm pack -> $tgz" { npm pack --silent }
} else {
  Write-Host "Asset exists: $tgz (delete it first to regenerate)" -ForegroundColor Yellow
}

# --- 3) git: commit version bump, tag, push ---
Invoke-Quiet { git add package.json }
Invoke-Quiet { git commit -m "chore: release v$v" }
Invoke-Checked "git push origin main" { git push origin main }

$tagExists = Invoke-Quiet { git rev-parse --verify "refs/tags/$tag" }
if ($tagExists -eq 0) {
  Write-Host "tag $tag exists, pushing it" -ForegroundColor Yellow
  Invoke-Checked "git push origin $tag" { git push origin $tag }
} else {
  Invoke-Quiet { git tag -a $tag -m "dsh-plugin-backdrop $v" }
  Invoke-Checked "git push origin $tag" { git push origin $tag }
}

# --- 4) GitHub Release ---
$notes = @"
## $v

- Loop-seam cyberpunk glitch whale: the video last->first frame jump is hidden by a seam burst (white flash + RGB split + slice tear + magenta ghost + drop frame + noise)
- Vertical/horizontal lines off by default (vBars / scanlines / sliceEdges configurable)
- pokeBurst() manual glitch hook + standalone preview page preview-cyber.html
- Official install: dsh plugin --profile web add $npmName
"@
Invoke-Checked "gh release create $tag" { gh release create $tag $tgz --repo "huguangyu666/$repo" --title "dsh-plugin-backdrop $v" --notes $notes }

Write-Host ""
Write-Host "== Release complete: v$v ==" -ForegroundColor Green
Write-Host "  npm   : https://www.npmjs.com/package/$npmName"
Write-Host "  github: https://github.com/huguangyu666/$repo/releases/tag/$tag"
