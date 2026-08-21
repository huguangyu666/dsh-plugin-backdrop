# dsh-plugin-backdrop — DeepSeek Harness 动态背景插件
<img width="2549" height="1361" alt="image" src="https://github.com/user-attachments/assets/6ffb84c4-462c-4aeb-a2dc-12af14e08f21" />
<img width="2549" height="1361" alt="image" src="https://github.com/user-attachments/assets/5e01be73-0747-4dab-8495-86e1eff62800" />

把 DeepSeek Harness 官网 hero 的完整氛围（**流体 + 平滑鲸鱼 + 发光鱼群 + 点线网格**）
注入 dsh Web UI 作为动态背景。当前实现为混合渲染：
- 流体背景沿用 WebGL2（原官网 GLSL 逆向）
- 鲸鱼 / 鱼群使用 Canvas 2D 预渲染精灵，全分辨率平滑渲染
- 点线网格沿用 Canvas 2D

> 完整技术原理见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；
> 新版 Canvas 渲染说明见 [`docs/CANVAS_RENDERING.md`](docs/CANVAS_RENDERING.md)。

---

## 目录

- [效果一览](#效果一览)
- [安装启用](#安装启用)
- [配置](#配置)
- [调试 API](#调试-api)
- [工作原理](#工作原理)
- [常见问题 FAQ](#常见问题-faq)
- [开发指南](#开发指南)
- [踩坑记录](#踩坑记录)
- [文件结构](#文件结构)
- [已知限制](#已知限制)

---

## 效果一览

> 截图：`docs/screenshot.png`（效果预览，可用浏览器 F12 对 3090 实例截图后放入）。

- **流体背景**：WebGL2 flowmap 双缓冲 + fbm/curl-noise 域扭曲，5 层深蓝-暖金渐变，
  自发光 bloom + 虚拟光源（跟随鼠标 X）+ 颗粒噪点 + 暗角
- **路径复刻鲸鱼**：视频抽帧的游动动画（35 帧字符画，~6fps），
  整只鲸鱼在界面里水平无缝漫游、上下呼吸浮动、气泡；
  **循环接缝赛博朋克故障**：视频末帧与首帧不重合（循环重启会"拉回"），
  在接缝瞬间自动打一个故障爆发（白闪 + RGB 色差 + 横条撕裂 + 品红残影 +
  掉帧跳变 + 扫描线 + 噪点）把位置跳变盖住——曲线救国式赛博朋克转场
- **发光鱼群**：55 条预渲染平滑鱼形精灵（4 配色 × 6 帧尾摆），
  鱼群中心弧线漫游，鱼在群内绕圈跟随；带转弯侧倾、呼吸缩放、深度透明、气泡
- **点线网格**：90px 点阵 + 邻点连线 + 鼠标波纹推开（canvas 2D）
- **UI 融入**：dsh 页面级容器透明化（已知类名 + 全视口扫描 fallback），
  强制 dsh 官方暗色主题保证文字可读性（实测对比度 9~19:1）
- **性能**：四层全部 30fps 节流 + 视口外停帧 + 静止自停 + dpr 上限 1.5

---

## 安装启用

> **推荐直接用官方安装命令**（一条命令，自动挂载，见方式 ①）。
> 本地改代码想立即生效再看方式 ②；方式 ③ 是官方命令不可用时的备份。

### 方式 ①：官方安装（推荐给所有用户）

插件已发 npm，且包内声明了 `dsh.bundle.patch`（`cordis.patch.yml`）与
`dsh.client.platform: web`，所以能用 dsh 官方插件管理命令直接装：

```bash
# 安装（在 profile 目录自动 pnpm add + 识别 dsh.bundle.patch 写入 bundles）
dsh plugin --profile web add dsh-plugin-backdrop

# 卸载
dsh plugin --profile web remove dsh-plugin-backdrop
```

装完 **重启 dsh**（重启会断开当前会话，挑空闲时操作）刷新页面即可。
官方命令内部会跑 `pnpm`，需要 `pnpm` 在 PATH；Windows 下若无代理 pnpm 挂起，
请给 `HTTPS_PROXY` 配置代理。

> ⚠️ 二选一：如果你已经走「方式 ② 本地开发」手动挂过 backdrop，
> **别再跑官方 add**，否则报 `duplicate loader entry id: backdrop`。

### 方式 ②：本地源码开发（改代码立即生效）

前提：仓库源码在你机器上，例如 `C:\Users\www13\Documents\AAA项目集\dsh-plugins\dsh-plugin-backdrop`。

1. **链接到 profile**（junction，指向源码目录；改源码 build 后无需重装）：
   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-backdrop" -Target "C:\Users\www13\Documents\AAA项目集\dsh-plugins\dsh-plugin-backdrop"
   ```
2. **挂载到配置**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`：
   ```yaml
   - insert:
       - id: backdrop
         name: 'dsh-plugin-backdrop'
   ```
3. **重启** `dsh web`（重启会断开当前会话，挑空闲时操作），刷新页面。

### 方式 ③：手动发布安装（官方命令不可用时的备份）

```powershell
cd ~/.dsh/profiles/web
pnpm add dsh-plugin-backdrop
# 然后同样在 cordis.patch.yml 加 insert 片段，重启
```

### 快速预览（不动正式实例）

在**插件已按方式 A 链接好**的前提下：

```powershell
# 1. 建 overlay 文件（放哪都行，建议 profile 目录，命令里用绝对路径）
#    C:\Users\www13\.dsh\profiles\web\overlay-backdrop.yml 内容：
#    - insert:
#        - id: backdrop
#          name: 'dsh-plugin-backdrop'
# 2. 起预览实例
dsh --patch "C:\Users\www13\.dsh\profiles\web\overlay-backdrop.yml" --profile web --port 3090
# 3. 浏览器打开 http://127.0.0.1:3090/
```

> 注意：如果 cordis.patch.yml 已经包含 backdrop，**不要再加 --patch**，
> 否则报 `duplicate loader entry id: backdrop`。此时直接 `dsh --profile web --port 3090` 即可。

---

## 配置

配置存 `localStorage['dsh-backdrop-config']`（JSON）。首次加载用默认值；
通过 `window.__backdrop.setConfig()` 修改会自动持久化。

```json
{
  "enabled": true,
  "opacity": 1,
  "layers": { "fluid": true, "whale": true, "fish": true, "grid": true },

  "fluid": {
    "glowIntensity": 0.07, "lightCore": 0.1, "lightHalo": 0.12,
    "vignette": 0.42, "interactive": false
  },

  "whale": {
    "density": 60, "spin": false, "loose": 1,
    "swim": true, "swimSpeed": 1.35, "swimTurn": 0.6,
    "light": { "x": 4.5, "y": 5.5, "z": 3, "range": 14, "shadeMin": 0.2, "shadeMax": 1.35, "followX": 1.05 },
    "mouse": { "radius": 4.9, "strength": 0.8, "decay": 0.2, "distort": 5 },
    "offsetRight": 0,
    "glitch": {
      "enabled": true, "burstWidth": 0.06, "intensity": 1,
      "rgbSplit": 26, "slices": 8, "maxShift": 56,
      "flash": true, "ghost": true, "flicker": true,
      "scanlines": false, "scanAlpha": 0.5, "sliceEdges": false,
      "noise": 0.5, "vBars": false
    }
  },

  "fish": {
    "count": 55, "density": 40, "scaleMin": 0.22, "scaleMax": 0.5,
    "speedBase": 2.6, "speedVary": 1.3,
    "schoolSpeed": 1.25, "schoolRadius": 6.0, "opacity": 0.95,
    "light": { "x": 4.5, "y": 5.5, "z": 3, "range": 14, "shadeMin": 0.3, "shadeMax": 1.5, "followX": 1.05 },
    "color": { "r": 0.62, "g": 0.82, "b": 1.0 }
  },

  "grid": { "lineOpacity": 0.06, "dotOpacity": 0.12 },

  "themeMode": "force-dark"
}
```

### 字段说明

| 字段 | 含义 | 备注 |
|---|---|---|
| `layers.*` | 四层独立开关 | `whale` 与 `fish` 可同时开 |
| `opacity` | 背景层整体透明度 | 0~1，聊天时调低可降存在感 |
| `fluid.interactive` | 流体鼠标笔刷（flowmap） | **聊天场景必须 false**，否则"一团光斑跟手" |
| `fluid.glowIntensity` | 鼠标光晕强度 | 0 关闭 |
| `whale.swim` | 是否让鲸鱼自由漫游 | `false` 时鲸鱼停在初始位置 |
| `whale.swimSpeed` | 鲸鱼漫游速度系数 | 默认 1.35，越大游得越快 |
| `whale.swimTurn` | 鲸鱼转弯/漫游幅度 | 默认 0.6 |
| `whale.glitch.enabled` | 循环接缝赛博朋克故障开关 | `false` = 保留生硬接缝（还原旧行为） |
| `whale.glitch.burstWidth` | 故障爆发窗口（循环比例） | 默认 0.06 = 循环前后各 6%（≈±0.35s），峰值命中接缝 |
| `whale.glitch.intensity` | 故障整体幅度主控 | 0~1 |
| `whale.glitch.rgbSplit` | RGB 色差峰值（px） | 默认 26 |
| `whale.glitch.slices/maxShift` | 横向切片数 / 位移峰值 | 默认 8 / 56（切片越少越厚、切口越明显） |
| `whale.glitch.flash` | 接缝白闪 | 默认开 |
| `whale.glitch.ghost` | 品红残影错位 | 默认开 |
| `whale.glitch.flicker` | 掉帧/闪烁（坏帧跳变） | 默认开 |
| `whale.glitch.scanlines/scanAlpha` | 扫描横线开关 / 强度 | 默认关（嫌横线多），想开设 `true` |
| `whale.glitch.sliceEdges` | 切片分隔横线 | 默认关（靠平移缺口已够明显），想开切块描边设 `true` |
| `whale.glitch.noise` | 噪点小方块强度 | 0~1，默认 0.5 |
| `whale.glitch.vBars` | CRT 竖条（满高竖线） | 默认 `false`（嫌竖线多，关掉）；想开设 `true` |
| ~~`whale.density/light/mouse/offsetRight`~~ | 旧版 WebGL 瓦片参数 | 新版 Canvas 渲染已不使用，保留仅为兼容旧配置 |
| `fish.count` | 鱼数量 | 默认 55 条 |
| `fish.scaleMin/Max` | 鱼的大小比例 | 相对视口尺寸，默认 0.22~0.5 |
| `fish.speedBase/Vary` | 游动速度系数 | 默认 2.6 / 1.3 |
| `fish.schoolSpeed` | 鱼群中心漫游速度 | 默认 1.25 |
| `fish.schoolRadius` | 鱼群散布半径 | 默认 6.0，越大鱼群越散 |
| `fish.opacity` | 鱼群整体透明度 | 默认 0.95 |
| ~~`fish.density/light`~~ | 旧版瓦片参数 | 新版 Canvas 渲染已不使用，保留仅为兼容旧配置 |
| `themeMode` | `force-dark` 强制暗色 / `follow` 跟随用户主题 | **force-dark 才能保证可读性** |

### 最小配置示例

只要鲸鱼、其他全关：

```js
__backdrop.setConfig({
  layers: { fluid: false, whale: true, fish: false, grid: false },
  opacity: 0.8,
});
```

只要鱼群、鲸鱼也留：

```js
__backdrop.setConfig({
  layers: { fluid: false, whale: true, fish: true, grid: false },
});
```

---

## 调试 API

浏览器 F12 控制台：

```js
window.__backdrop.toggleLayer('whale', false)        // 关鲸鱼层
window.__backdrop.toggleLayer('fish', true)          // 开鱼群层
window.__backdrop.setOpacity(0.6)                    // 整体透明度
window.__backdrop.setConfig({                        // 实时调参（自动存 localStorage）
  whale: { swimSpeed: 2.2, glitch: { burstWidth: 0.08, noise: 0.8 } },
  fish: { count: 30, scaleMax: 0.8 },
  fluid: { interactive: true },                      // 想要"鼠标划出光痕"再开
});
window.__backdrop.config                            // 查看当前生效配置
window.__backdrop.dispose()                          // 卸载背景（还原主题与容器）
```

> 新版鲸鱼为字符帧动画（视频抽帧），`src` 换剪影仅旧版瓦片引擎支持、
> 现在无效；想调鲸鱼就调 `whale.swim*` 与 `whale.glitch.*`。
> 手动爆一次故障：`__backdrop` 下的鲸鱼实例暴露 `pokeBurst()`，预览页有对应按钮。

> `whale.src` 接受 `Image.src` 支持的格式：URL、data URI（如 `data:image/svg+xml;utf8,...`）。
> 换 src 会自动重新采样并重建瓦片，无需刷新。

---

## 工作原理

```
┌─ body
│  ├─ #root → dsh UI（容器透明化后透出背景）
│  └─ .backdrop-root（z-index:0，pointer-events:none）   ← 插件注入
│     ├─ canvas#fluid  流体背景（WebGL2，mask 底部渐隐）
│     ├─ canvas#whale  瓦片鲸鱼（Three.js，screen 混合，右移）
│     ├─ canvas#fish   瓦片鱼群（Three.js，screen 混合，全屏）
│     └─ canvas#grid   点线网格（canvas 2D，mask 渐隐）
```

- **注入**：`client-source.js` 在 `apply()` 时向 body 插入背景容器 + 覆盖 CSS，不依赖 React
- **透明化**：硬编码 rc.6 类名（`.pI_x6G_frame` 等）+ `transparentizeFullscreenSolids()`
  全视口扫描兜底（覆盖 ≥90% 视口且实底的容器置透明）
- **主题**：默认给 `<body>` 挂 `data-ds-dark-theme`（dsh 官方暗色属性），
  组件级配色整体切暗、文字变白，可读性由 dsh 自己的样式保证；
  MutationObserver 在用户手动切主题时把属性挂回去
- **可读性实测**：新会话按钮 9.18:1 / 侧边栏 13.14:1 / 输入框 18.95:1（WCAG ≥4.5 达标）

详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 常见问题 FAQ

**Q: 字看不清 / 界面还是亮的？**
A: 确认 `themeMode: "force-dark"`（默认）。旧版本（强制文字 token 方案）会导致白字浅底，
已废弃。改配置后 `location.reload()`。

**Q: 鼠标拖着"一大坨光斑"跑？**
A: `fluid.interactive` 被设成了 `true`。设为 `false`（默认）并刷新。
官网在 Windows 上本来就默认关闭此交互。

**Q: 鱼不像鱼 / 鱼在甩头？**
A: 确认 `fish.density` ≥ 30。旧版尾摆方向与鱼形相反（鱼头朝右但 shader 按尾巴在 +x 摆动），
已修复为 `smoothstep(-4.5, -0.5, x)`。还觉得丑就把 FISH_SVG 换成自己画的剪影（`src/engine/fish-school.js`）。

**Q: 鲸鱼循环时"被拉回"一下？**
A: 这是视频抽帧动画的固有跳变（末帧与首帧位置不重合）。当前用**接缝赛博朋克故障**盖住它：
接缝瞬间自动白闪 + 色差 + 撕裂 + 噪点。如果不想要故障，把 `whale.glitch.enabled` 设 `false`
（会回到生硬拉回）。想调凶一点：`whale.glitch = { maxShift: 90, rgbSplit: 44, noise: 0.9 }`。

**Q: 想换成别的形状（logo、猫、狗）？**
A: 新版鲸鱼是视频抽帧的字符动画（帧内嵌在 `src/engine/whale-ascii-frames.js`），
`src` 换剪影只对旧版瓦片引擎有效、现在无效。真想换形状要重新抽帧生成字符帧。
（旧版瓦片引擎备份在 `src/engine/whale-engine.js`，仍可换回。）

**Q: 升级 dsh 后背景不显示了 / 容器又变白？**
A: dsh 的容器类名是 CSS Modules hash，升级可能变化。fallback 扫描会自动透明化全视口实底容器；
若失效，把新类名补进 `client-source.js` 的 CSS 覆盖列表。

**Q: 想完全还原回默认界面？**
A: `localStorage.removeItem('dsh-backdrop-config'); location.reload()`，
再在 `cordis.patch.yml` 里删掉 backdrop 条目并重启。

---

## 开发指南

```powershell
# 改代码后重新构建（产出 lib/index.js + lib/client.js）
node build.mjs

# 重启预览实例（两种情形二选一）：
#   · cordis.patch.yml 已含 backdrop → 直接起
dsh --profile web --port 3090
#   · patch 未写入正式配置 → 用 overlay（见"安装启用 → 快速预览"）
dsh --patch "C:\Users\www13\.dsh\profiles\web\overlay-backdrop.yml" --profile web --port 3090

# headless 验证注入状态（backdrop-root/canvas 数/容器透明/主题）
node verify-inject.mjs "http://127.0.0.1:3090/" out.png 25000
```

**本地开发要点**

- 引擎在 `src/engine/`，全部 ESM、零框架依赖；`client-source.js` 负责注入与配置
- client bundle 会把 three.js + 四引擎 + GLSL + 鲸鱼 SVG(dataurl) 全部内联（~780KB），
  改引擎后必须 `node build.mjs` 再重启
- 想加第五层：写引擎 → `client-source.js` 里创建 canvas + 启动 + 加进 `toggleLayer` map → build

---

## 踩坑记录

1. **`setConfig` 覆盖引用 bug**：`Object.assign(cfg, patch)` 会把 `patch.light` 整体覆盖
   `cfg.light` 引用，导致 `uLightPos = (NaN, undefined, z)`，鲸鱼变全透明但"看起来没渲染"。
   必须逐字段合并（见 `whale-engine.js` 的 `setConfig`）。
2. **three.min.js（UMD）无法被 esbuild 打包导出**：`import * as THREE` 拿到空对象。
   改用 npm `three@0.150.1`（纯 ESM）。
3. **尾摆方向**：官网 shader 假设尾巴在 +x；鱼形头朝右时尾摆反了（鱼甩头）。
   fish 引擎里把 tail 因子替换为 `smoothstep(-4.5, -0.5, x)`。
4. **light 模式可读性**：强制文字 token 变白但组件背景仍是浅色 → 白字浅底看不清。
   正确做法是挂 `data-ds-dark-theme` 让 dsh 自己的暗色样式接管。
5. **headless 验证**：SwiftShader 下 `readPixels` 极慢且 present 后缓冲不可读；
   用 CDP 截图 + DOM 计算（背景色/对比度）验证，别读像素。
6. **Windows 中文路径**：`new URL(import.meta.url).pathname` 是 percent-encoded，
   静态服务器需 `decodeURIComponent`，否则 404。
7. **PowerShell 内联后台任务**：`Start-Job` 随调用进程退出被杀死；长驻进程
   必须用工具的后台任务机制。
8. **重复挂载报错** `duplicate loader entry id: backdrop`：cordis.patch.yml 和
   `--patch overlay` 同时挂同一插件导致；二选一。

---

## 文件结构

```
dsh-plugin-backdrop/
├── package.json               # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml           # 插件挂载片段
├── build.mjs                  # esbuild 打包（host ESM + client CJS 包装）
├── README.md                  # 本文档
├── docs/
│   ├── ARCHITECTURE.md        # 架构与技术原理（含旧版瓦片逆向记录）
│   └── CANVAS_RENDERING.md    # 新版 Canvas 鲸鱼/鱼群渲染说明
├── verify-inject.mjs          # headless 验证工具（注入状态 + 截图）
├── probe-*.mjs                # 调试探针（对比度/鱼群/交互开关）
└── src/
    ├── index.js               # host 端（挂载点，预留配置服务）
    ├── client-source.js       # client 端：DOM 注入 + 透明化 + 主题联动 + 配置
    ├── hero-whale.svg         # 官网原版鲸鱼剪影
    └── engine/
        ├── whale-canvas.js        # 字符动画鲸鱼 + 循环接缝赛博朋克故障（当前）
        ├── whale-ascii-frames.js  # 视频抽帧的鲸鱼字符帧数据（35 帧）
        ├── whale-video-paths.js   # 从视频提取的鲸鱼关键帧轮廓数据
        ├── fish-canvas.js         # 新版 Canvas 发光鱼群（预渲染精灵）
        ├── fluid-background.js    # 流体背景（WebGL2 flowmap 双缓冲）
        ├── grid-background.js     # 点线网格（canvas 2D）
        ├── fluid-shaders.js       # 流体 GLSL（官网 page chunk 原样提取）
        ├── whale-engine.js        # 旧版瓦片鲸鱼（保留，未使用）
        ├── fish-school.js         # 旧版瓦片鱼群（保留，未使用）
        └── shaders.js             # 旧版瓦片 shader（保留，未使用）
```

---

## 已知限制

- UI 容器类名是 CSS Modules hash（rc.6 硬编码），dsh 升级后可能失效；
  fallback 扫描兜底，极端情况下可能误伤全屏弹层（有白名单可调）
- `force-dark` 会覆盖用户手动选择的亮色主题（可在设置里改 `themeMode: "follow"`，但亮色下背景融入效果差）
- 鱼群共享几何导致每条鱼内部瓦片抖动相位一致（mesh 级尾摆仍有差异），
  追求个体差异可改为每鱼独立几何
- 官网原版在 Windows 上默认关鼠标扰动；本插件流体笔刷默认关闭，鲸鱼/网格交互保留

---

## 逆向来源

- deepseek.com/harness → chunk `776.7b3219fa93f8a656.js`（HeroDigitileR3F 瓦片鲸鱼）
- deepseek.com/harness → page chunk `u` 组件（WebGL2 流体）、`m` 组件（点线网格）
- 完整逆向过程与独立 demo：见同仓库 `whale-demo/`（浏览器直接打开可玩）
