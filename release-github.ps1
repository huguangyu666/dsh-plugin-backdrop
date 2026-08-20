# ============================================================
# release-github.ps1 — 一条命令发布 dsh-plugin-backdrop
#
# 用法:
#   .\release-github.ps1 -Version 0.2.0    # 升到 0.2.0 → npm publish → GitHub Release
#   .\release-github.ps1                   # 只用当前 package.json 版本发 GitHub（npm 假定已发）
#   .\release-github.ps1 -Npm              # 不传版本也跑 npm publish（当前版本）
#   .\release-github.ps1 -Version 0.2.0 -SkipGitHub   # 只 bump + npm publish，不建 GitHub
#
# 前置: gh 在 PATH 且已登录（gh auth login）；npm 已登录
#       （gh 路径如在 C:\Users\www13\bin\gh，先加进 PATH 或在本脚本里补）
# ============================================================
param(
  [string]$Version,      # 新版本号，如 0.2.0 / v0.2.0（传递时会自动 bump package.json）
  [switch]$Npm,          # 即使不传 Version 也执行 npm publish（用当前版本）
  [switch]$SkipGitHub    # 只做 npm publish，跳过 GitHub release
)
$ErrorActionPreference = 'Stop'

# 自愈：gh 不在 PATH 时，自动补常见用户安装路径
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  foreach ($d in @("$env:USERPROFILE\bin\gh", "$env:LOCALAPPDATA\Programs\GitHub CLI\bin", "$env:LOCALAPPDATA\Microsoft\WinGet\Links")) {
    if (Test-Path "$d\gh.exe") { $env:PATH = $d + ';' + $env:PATH; break }
  }
}

$repo = 'huguangyu666/dsh-plugin-backdrop'

# --- 工具函数：执行并校验退出码 ---
function Invoke-Checked {
  param([string]$Msg, [scriptblock]$Body)
  Write-Host "== $Msg ==" -ForegroundColor Cyan
  & $Body 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "上一步失败（exit $LASTEXITCODE）：$Msg" }
}

# --- 解析版本 ---
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($Version) { $v = $Version.TrimStart('v') } else { $v = $current }
$tag = "v$v"
$tgz = "dsh-plugin-backdrop-$v.tgz"
$doNpmPublish = $Npm -or [bool]$Version

if ($v -ne $current) {
  Write-Host "版本: $($current) -> $v"
  Invoke-Checked "bump package.json 到 $v" { npm pkg set version=$v }
} else {
  Write-Host "版本: $v（package.json 已是此版本）" -ForegroundColor Yellow
}

# --- 1) npm publish（prepack 自动 build lib） ---
if ($doNpmPublish -and -not $SkipGitHub) {
  Invoke-Checked "npm publish $v" { npm publish }
} elseif ($doNpmPublish) {
  Invoke-Checked "npm publish $v（--SkipGitHub）" { npm publish }
}

if ($SkipGitHub) { Write-Host '已按 --SkipGitHub 跳过 GitHub 步骤。'; exit 0 }

# --- 2) 打 tgz（GitHub 附件） ---
if (-not (Test-Path $tgz)) {
  Invoke-Checked "npm pack 生成 $tgz" { npm pack --silent }
} else {
  Write-Host "附件已存在：$tgz（如需重新生成请先删掉旧文件）" -ForegroundColor Yellow
}

# --- 3) git：提交 + tag + push ---
git add package.json 2>$null
git commit -m "chore: release v$v" 2>$null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { throw "git commit 失败（$LASTEXITCODE）" }
Invoke-Checked "git push origin main" { git push origin main }
if (git rev-parse --verify "refs/tags/$tag" 2>$null) {
  Write-Host "tag $tag 已存在，直接推送" -ForegroundColor Yellow
  Invoke-Checked "git push origin $tag" { git push origin $tag }
} else {
  git tag -a $tag -m "dsh-plugin-backdrop $v"
  Invoke-Checked "git push origin $tag" { git push origin $tag }
}

# --- 4) GitHub Release ---
$notes = @"
## $v

- 循环接缝赛博朋克故障鲸鱼：视频末帧→首帧位置跳变用接缝故障盖住（白闪 + RGB 色差 + 切片撕裂 + 品红残影 + 掉帧 + 噪点）
- 竖线/横线默认关闭（vBars / scanlines / sliceEdges 可配）
- pokeBurst() 手动故障调试口 + 独立预览页 preview-cyber.html
"@
Invoke-Checked "gh release create $tag" { gh release create $tag $tgz --repo $repo --title "dsh-plugin-backdrop $v" --notes $notes }

Write-Host ""
Write-Host "✔ 发布完成：v$v" -ForegroundColor Green
Write-Host "  npm   : https://www.npmjs.com/package/dsh-plugin-backdrop"
Write-Host "  github: https://github.com/$repo/releases/tag/$tag"
