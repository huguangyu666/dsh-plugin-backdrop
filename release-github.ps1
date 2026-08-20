# release-github.ps1 — 推 GitHub 仓库并创建 v0.1.1 Release
# 前置：任选其一
#   ① 安装 GitHub CLI 并登录：  winget install GitHub.cli  →  gh auth login
#   ② 或设置环境变量 GH_TOKEN=<fine-grained PAT 或 classic PAT，权限 Contents:write + 创建 release>
#
# 用法：在 dsh-plugin-backdrop 目录下  ./release-github.ps1
$ErrorActionPreference = 'Stop'
$repo  = 'huguangyu666/dsh-plugin-backdrop'
$ver   = 'v0.1.1'
$tgz   = 'dsh-plugin-backdrop-0.1.1.tgz'
$title = 'dsh-plugin-backdrop v0.1.1'
$notes = @'
## 0.1.1

- 循环接缝赛博朋克故障鲸鱼：视频末帧→首帧位置跳变用接缝故障盖住（白闪 + RGB 色差 + 切片撕裂 + 品红残影 + 掉帧 + 噪点）
- 竖线/横线默认关闭（`vBars` / `scanlines` / `sliceEdges` 可配）
- `pokeBurst()` 手动故障调试口 + 独立预览页 `preview-cyber.html`
- 补 LICENSE(MIT)
'@

$hasGh = [bool](Get-Command gh -ErrorAction SilentlyContinue)
$hasToken = [bool]$env:GH_TOKEN

if (-not $hasGh -and -not $hasToken) {
  Write-Error '需要 gh CLI（gh auth login）或 GH_TOKEN 环境变量之一，先做认证再重跑。'
}

# 1) tgz
if (-not (Test-Path $tgz)) { npm pack --silent | Out-Null }

# 2) remote
if (-not (git remote | Select-String '^origin$')) { git remote add origin "https://github.com/$repo.git" }

# 3) 仓库存在？不存在则创建
git ls-remote "https://github.com/$repo.git" HEAD *> $null
if ($LASTEXITCODE -ne 0) {
  if ($hasGh) { gh repo create $repo --public --source=. --push --description 'dsh Web UI 动态背景：流体 + 字符鲸鱼游动(循环接缝赛博故障) + 鱼群 + 网格' }
  else { Write-Error '仓库不存在且无 gh，无法自动创建；请先手动建 public 仓库 https://github.com/new 或装 gh。' }
}

# 4) 推送代码与 tag
git push -u origin main --tags

# 5) 创建/更新 Release
if ($hasGh) {
  gh release create $ver $tgz --title $title --notes $notes
} else {
  $uri  = "https://api.github.com/repos/$repo/releases"
  $body = @{ tag_name = $ver; name = $title; body = $notes; draft = $false; prerelease = $false } | ConvertTo-Json
  $rel  = Invoke-RestMethod -Uri $uri -Method POST -Headers @{ Authorization = "Bearer $env:GH_TOKEN" } -ContentType 'application/json' -Body $body
  # 上传附件
  $up  = "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets?name=$tgz&label=$tgz"
  Invoke-RestMethod -Uri $up -Method POST -Headers @{ Authorization = "Bearer $env:GH_TOKEN"; 'Content-Type' = 'application/octet-stream' } -InFile $tgz | Out-Null
  Write-Output ("Release URL: " + $rel.html_url)
}

Write-Output 'GitHub Release 完成 ✔'
