# Canvas 渲染说明（鲸鱼 / 鱼群）

本文档介绍 `dsh-plugin-backdrop` 中鲸鱼和鱼群的新版 Canvas 2D 渲染实现，以及如何调整它们的外观与运动。

## 为什么从 WebGL 瓦片改成 Canvas 2D

旧版鲸鱼/鱼群使用 Three.js + InstancedMesh 的“瓦片方块”方案：

- 瓦片在视觉上偏“科技感”，但很多人觉得不够像真的鲸鱼/鱼；
- InstancedMesh 在部分环境（如 SwiftShader）下容易出现整条鲸鱼空白；
- 包体较大（client bundle 曾接近 800KB）。

新版改成 Canvas 2D 预渲染精灵：

- 视觉更平滑：渐变身体、发光轮廓、清晰尾鳍；
- 包体大幅缩小（当前 client bundle 约 55KB）；
- 不依赖 Three.js，渲染更稳定；
- 从用户提供的 MP4 中提取鲸鱼轮廓，转成 Path2D 关键帧；
  用代码插值播放，全分辨率、不切割、不拉伸。

## 分层结构

```
dsh-plugin-backdrop/
├── src/
│   ├── client-source.js          # 注入 DOM、透明化、主题、配置、四层调度
│   ├── engine/
│   │   ├── fluid-background.js   # WebGL2 流体（沿用原官网逆向）
│   │   ├── grid-background.js    # Canvas 2D 点线网格（沿用）
│   │   ├── whale-canvas.js       # 新版 Canvas 鲸鱼
│   │   ├── fish-canvas.js        # 新版 Canvas 鱼群
│   │   ├── whale-engine.js       # 旧版 WebGL 鲸鱼（保留，未使用）
│   │   ├── fish-school.js        # 旧版 WebGL 鱼群（保留，未使用）
│   │   ├── shaders.js            # 旧版瓦片 shader（保留，未使用）
│   │   └── fluid-shaders.js      # 流体 shader
│   └── hero-whale.svg            # 官网鲸鱼 SVG 剪影
└── lib/
    ├── index.js                  # host 端 bundle
    └── client.js                 # client 端 bundle（esbuild 构建产物）
```

## 鲸鱼：`whale-canvas.js`

### 实现要点

1. **路径提取**
   - 从 MP4 中按固定间隔提取 25 个关键帧；
   - 用 OpenCV 把每帧鲸鱼轮廓重采样成 64 个点；
   - 保存为 `whale-video-paths.js`，运行时用 Path2D 插值播放。

2. **游动**
   - 使用双频率正弦扰动生成弧线漫游路径；
   - 靠近边界时平滑转向；
   - `heading` 让鲸鱼头朝向运动方向；
   - `swim.turnRate` 产生转弯侧倾。

3. **插值播放**
   - 25 个关键帧之间线性插值，播放流畅；
   - 保留视频里的游动/尾巴动画；
   - 身体整体只做轻微俯仰和漫游。

### 可调参数

在 `createWhaleCanvas()` 内部 `cfg` 或 `src/client-source.js` 的 `DEFAULT_CONFIG.whale` 中修改：

| 配置项 | 作用 | 默认 |
|---|---|---|
| `swim` | 是否自由漫游 | `true` |
| `swimSpeed` | 游动速度系数 | `1.35` |
| `swimTurn` | 漫游转向幅度 | `0.6` |
| `opacity` | 鲸鱼整体透明度 | `1` |

如果想要调整动画循环速度，可修改 `whale-canvas.js` 中的：

```js
const LOOP_DURATION = 6.25; // 一个完整动画循环的秒数
```

想快一点就调小，想慢一点就调大。

## 鱼群：`fish-canvas.js`

### 实现要点

1. **预渲染精灵**
   - 每个配色 × 6 帧尾摆，启动时生成一次；
   - 每条鱼由：流线身体 + 分叉尾鳍 + 背鳍 + 胸鳍 + 眼睛组成；
   - 使用 `shadowBlur` 烘焙发光效果，主循环只做 `drawImage`。

2. **鱼群运动**
   - 鱼群中心（school）按弧线漫游，边界转向；
   - 每条鱼围绕中心点旋转偏移，形成松散鱼群；
   - 个体使用双频率 wander + 向目标点转向；
   - 转弯时根据角速度计算 `bank`（侧倾）；
   - 呼吸缩放、深度透明度、尾摆帧切换。

3. **氛围**
   - 额外绘制向上飘的微光气泡，增加水底感。

### 可调参数

在 `src/client-source.js` 的 `DEFAULT_CONFIG.fish` 中修改：

| 配置项 | 作用 | 默认 |
|---|---|---|
| `count` | 鱼数量 | `55` |
| `scaleMin/scaleMax` | 鱼的大小比例 | `0.22 / 0.5` |
| `speedBase` | 基础游速系数 | `2.6` |
| `speedVary` | 速度变化幅度 | `1.3` |
| `schoolSpeed` | 鱼群中心漫游速度 | `1.25` |
| `schoolRadius` | 鱼群散布半径 | `6.0` |
| `opacity` | 鱼群透明度 | `0.95` |
| `color` | 基础配色（RGB 0~1） | `{r:0.62,g:0.82,b:1.0}` |

### 注意

`density`、`light` 等旧版瓦片参数在新版 Canvas 渲染中不会生效，仅保留在配置对象里防止旧 localStorage 报错。

## 配置兼容

- `loadConfig()` 里加入了 `v: 2` 配置版本；
- 旧版本 localStorage 中如果缺少 `v: 2`，会自动迁移：
  - 保留 `opacity`、`fluid`、`grid`、`themeMode`；
  - 鲸鱼/鱼群使用新版默认值覆盖旧瓦片参数；
  - 迁移后写回 localStorage。

## 性能

- 鲸鱼启动时生成 16 帧，主循环每帧 1 次 `drawImage` + 少量数学运算；
- 鱼群主循环：55 条鱼 × 1 次 `drawImage`，加上 20~30 个气泡；
- 四层全部 30fps 节流；
- 视口外通过 `IntersectionObserver` 暂停绘制；
- dpr 上限 1.5，避免高分屏过度消耗。

## 构建与验证

```bash
# 构建 lib/index.js + lib/client.js
node build.mjs

# 语法检查
node --check src/client-source.js
node --check src/engine/whale-canvas.js
node --check src/engine/fish-canvas.js
node --check lib/client.js

# 真实 dsh 注入验证（需要本机 dsh web 已启动）
node verify-inject.mjs "http://127.0.0.1:3080/" /tmp/backdrop-check.png
```

## 维护指引

- 想重新提取路径：用脚本处理新的 MP4 并更新 `whale-video-paths.js`；
- 想调整动画速度：改 `LOOP_DURATION`；
- 想改鱼形：改 `fish-canvas.js` 里 `makeFishSprite()` 的路径；
- 想改鱼群速度：改 `src/client-source.js` 的 `DEFAULT_CONFIG.fish`；
- 改完源码后必须执行 `node build.mjs`，然后刷新 dsh 页面。
