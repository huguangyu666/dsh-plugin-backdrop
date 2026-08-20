# dsh-plugin-backdrop 架构与技术原理

逆向 deepseek.com/harness 官网 hero 的完整背景，移植为 dsh Web UI 动态背景插件。
本文档面向想改引擎/加功能的开发者，覆盖：逆向来源、瓦片化渲染核心概念、
四层引擎设计与 GLSL 原理、性能策略、UI 融入机制、验证工具链。

> **当前状态**：鲸鱼和鱼群已切换为 Canvas 2D 平滑渲染，
> 不再使用旧版 Three.js 瓦片化实现。新版说明见
> [`CANVAS_RENDERING.md`](CANVAS_RENDERING.md)。
> 本文档中的瓦片化/GLSL 部分属于历史逆向记录，保留供参考。

---

## 1. 逆向来源

官网页面是 Next.js，hero 部分由 page chunk + 懒加载 chunk 组成：

| 素材 | 位置 | 组件 | 说明 |
|---|---|---|---|
| 瓦片鲸鱼 | chunk `776.7b3219fa93f8a656.js` | `HeroDigitileR3F` | React + react-three-fiber，13KB |
| 流体背景 | page chunk `u` 组件 | `HeroFluid`（内部名 u） | 原生 WebGL2，19.6KB |
| 点线网格 | page chunk `m` 组件 | 2D canvas 点阵 | 90px 点阵 + 弹簧力学 |
| 鲸鱼剪影 | `/images/hero-whale.svg` | — | 24×18 viewBox 的白色 path，3.5KB |

提取手法：下载 chunk → 定位组件函数体 → 原样截取 GLSL 字符串字面量
（注意 chunk 里 shader 是 JS 双转义字符串，提取时补引号边界）→ 存为
`shaders.js` / `fluid-shaders.js`。提取脚本见同仓库 `whale-demo/extract-*.mjs`。

官网 hero 还有多层结构：z-0 流体（带顶部渐隐 mask）→ z-2 鲸鱼（`mix-blend-mode: screen`）
→ z-3 网格（同 mask）。本插件复刻该层级并适配聊天 UI。

---

## 2. 核心概念：瓦片化渲染

整套效果的灵魂是**把一张 2D 剪影变成会动的 3D 点阵**，全程不建模、不绑骨骼：

```
SVG/PNG 剪影
  → 离屏 canvas 按 N×N 网格采样灰度（0.299R+0.587G+0.114B）
  → 提取形状边缘像素，生成每瓦片属性：
      positions          目标位置（×0.18 缩放展成世界坐标）
      opacities          原图灰度 → 透明度（暗部半透明，素描质感）
      edges              8 邻域中非形状像素占比（边缘=1 内部=0）
      scatteredPositions 随机球面散点（"散开"形态的落点）
  → 每瓦片 = 一个 0.06×0.06×0.018 的小 box，随机缩放 0.5~1.5
  → 全部运动/光照在顶点+片元着色器里完成
```

### 2.1 官网鲸鱼 shader 的运动分层（shaders.js）

顶点着色器按优先级叠加位移：

| 效果 | 实现 |
|---|---|
| 开场组装 | `uAssembly` 2.5s easeOutCubic 0→1，瓦片从散点 lerp 回轮廓（聚沙成鲸） |
| 松散游动 | 每瓦片按 `aIndex` 错相位抖动 + 漂移；**尾摆**沿 +x 由 `smoothstep(0.5,4.5,x)` 加权——尾巴摆、身体稳 |
| 滚动散开 | `uScatter` 时瓦片漂向散点，边缘瓦片先散（`mix(0.5,1.0,aEdge)`） |
| 中心波纹 | 组装完成后 `sin(dist*3 - t*speed)` 沿 z 起伏，中心衰减避免"抬升" |
| 鼠标推开 | 半径内径向推力，三次方衰减 + per-particle 噪声旋转方向 |
| 散开漂浮 | `assembly<0.9` 时自由漂浮 |

### 2.2 伪光照（关键技巧）

**没有光源，只有距离计算**：

```glsl
float lightDist = distance(worldPos.xyz, uLightPos);   // uLightPos 世界空间固定
float lit = clamp(1.0 - lightDist / uLightRange, 0.0, 1.0);
vLight = mix(uShadeMin, uShadeMax, lit * lit);          // 二次衰减
```

光锚定在屏幕固定点，瓦片转动时明暗变化 → 伪 3D 旋转感。
官网注释原话：*"helm rotates underneath it, so the lit face stays anchored on screen"*。
片元着色器再叠：发光（`smoothstep(8,0,dist)*0.3`）、闪烁（`sin(uTime*1.5+pos*…)`）、
亮面暖色偏移（`*(1.07,1.02,0.94)`）、`AdditiveBlending` 叠加。

---

## 3. 四层引擎

### 3.1 流体背景（fluid-background.js，WebGL2）

官网 `u` 组件复刻，双 pass 架构：

```
pass 1  flowmap 更新（1/4 分辨率 FBO，ping-pong 双缓冲）
        └ 鼠标 brush：influence=exp(-d²/(r²·0.5))，r 通道强度、gb 通道方向
          decay 0.925 每帧衰减 → 痕迹缓慢消散
pass 2  主渲染（全屏 quad）
        └ 采样 flowmap → uv 扰动（distortBoost/swirlBoost）
          fluidNoise：3 层 fbm + curl-noise（curlish）域扭曲
          blend_multi：5 层色 smoothstep 渐变
          glow：鼠标邻近 3 色光晕 × glowIntensity
          grain：hash 颗粒噪点
          bloom：亮度自发光（threshold/range/strength）
          虚拟光源：exp(-d²·4.5) 暖核心 + exp(-d·1.8) 冷光晕（lightX 跟随鼠标）
          vignette：暗角
```

关键参数（官网 hero 默认值）：
`colors: ['#000000','#1A3870','#204a7e','#eed8aa','#000000']`（深蓝→暖金）
`glowColors: ['#fff7d1','#538dca','#2d448b']`，`scale 1.77`，`offset (-124,-48)`。

**聊天场景适配**：`interactive: false` 关闭 flowmap 鼠标笔刷——
否则鼠标在输入区活动会拖着一团光斑。这是用户反馈后修的默认值。

### 3.2 瓦片鲸鱼（whale-engine.js，Three.js InstancedMesh）

官网 `HeroDigitileR3F` 的 vanilla 移植：

- `InstancedMesh` + `InstancedBufferAttribute`（aOpacity/aIndex/aScattered/aEdge）
- 每实例 matrix = 采样点位置 + 随机缩放
- 帧循环 30fps 节流（官网 `frameloop:'never'` + 手动 rAF 同款思路）
- `IntersectionObserver(rootMargin:100px)` 视口外停帧
- 灯光跟随鼠标 X（`uLightPos.x = light.x + mouse.x * followX`）
- 鼠标离开窗口/切后台 → 推力指数衰减归零

### 3.3 瓦片鱼群（fish-school.js，共享几何 + 普通 Mesh）

把鲸鱼引擎拆给"每条鱼一个小 Mesh"的场景，重点差异：

1. **采样一次，几何共享**：小鱼剪影（`FISH_SVG`，鱼雷身体 + 分叉尾鳍 + 背鳍）
   按 36 网格采样一次 → `buildFishGeometry()` 把每瓦片展开成 24 顶点 box
   （6 面 × 4 顶点，36 索引）→ 所有鱼共享同一 BufferGeometry
2. **shader 改造**：`instanceMatrix → modelMatrix`（普通 Mesh 没有实例矩阵；
   顶点位移的语义等价——modelMatrix 原点 = 鱼的位置）
3. **尾摆反转**：官网 shader 假设尾巴在 +x，鱼形头朝右 → 替换为
   `smoothstep(-4.5, -0.5, targetCenter.x)`，否则鱼甩头
4. **游动模型**（JS 每帧更新）：
   ```
   angle  += sin(t*0.3+phase)*0.55 + cos(t*0.17+phase*2.1)*0.32   // wander 漂移
   speed  += (base + vary*sin(t*0.23+phase*3.7) - speed) * 0.8dt  // 速度波动
   x/y    += cos/sin(angle) * speed * dt                          // 移动
   软边界：距边缘一定距离时 lerpAngle 转向场内
   z      = sin(t*0.4+phase*5.3) * 0.45                           // 深度浮动
   rotation.z = angle + sin(t*(1.4+speed*0.35)+phase) * 0.09      // 尾摆（mesh 级）
   ```
5. 每条鱼一个 `THREE.Mesh`（共享材质），40+ 条 = 40+ draw call，每帧约 27 万顶点

### 3.4 点线网格（grid-background.js，canvas 2D）

官网 `m` 组件复刻：90px 点阵，鼠标 140px 半径推开（`(1-d/r)*30` 径向力 +
`0.05` 弹簧 + `0.85` 阻尼），邻点连线（间距 <20 跳过、两端缩短 10px 制造断点），
静止（最大速度 <0.01）自动停帧。

---

## 4. 性能策略

| 手段 | 实现 |
|---|---|
| 帧率节流 | 四层全部 30fps：rAF 里 `if (dt < 1/30) return` |
| 视口停帧 | `IntersectionObserver(rootMargin:'100px')`，离开视口停止渲染循环 |
| 静止自停 | 网格层最大速度 <0.01 停帧（流体/鲸鱼常动不适用） |
| 像素比上限 | `dpr = min(devicePixelRatio, 1.5)`（流体 1.5 / 网格 2 / three 1.5） |
| 混合模式 | `screen` 叠加只加不减，暗部自然透明，避免整层不透明重绘 |
| 几何复用 | 鱼群共享 BufferGeometry；瓦片 box 顶点一次生成 |

实测：4 层 + 45 条鱼在 SwiftShader 下 ~30fps 可达（帧计数验证），真 GPU 无压力。

---

## 5. UI 融入机制（client-source.js）

### 5.1 DOM 注入

不碰 React，`apply()` 时直接操作 DOM：

```js
// body 最底层插入背景容器
const root = document.createElement('div');
root.className = 'backdrop-root';
root.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;';
// 4 个 canvas：fluid(mask) / whale(screen, translateX) / fish(screen) / grid(mask)
document.body.insertBefore(root, document.body.firstChild);
```

`pointer-events:none` 保证不挡交互；z-index:0 且在 #root 之前 → 永远在 UI 下层。

### 5.2 容器透明化

```css
/* rc.6 硬编码类名（CSS Modules hash） */
.backdrop-root ~ * .pI_x6G_frame { background: transparent !important; }
.backdrop-root ~ * .wSkVaW_root { background: transparent !important; }
...
```

兜底：`transparentizeFullscreenSolids()` 扫描所有 div，
**覆盖 ≥90% 视口 + 背景不透明 + 无大量直接文本** 的元素置透明
（排除消息气泡等小元素；全屏弹层可能误伤，有白名单可调）。

### 5.3 主题机制（可读性的关键）

dsh 主题服务（`dsh-client-ui-layout`）用 body 属性切换配色：

```js
const DARK_ATTRIBUTE = 'data-ds-dark-theme';   // body 挂此属性 → 组件整体切暗色
```

插件默认 `themeMode: 'force-dark'`：给 body 挂该属性，
`MutationObserver` 监听属性变化（用户手动切亮色时挂回去）。
**这比手动改 CSS token 可靠得多**——dsh 所有组件（气泡/按钮/输入框）的暗色
样式都由官方样式表保证，对比度实测：

| 元素 | 对比度 |
|---|---|
| 新会话按钮 | 9.18:1 |
| 侧边栏项 | 13.14:1 |
| 输入框 / logo | 18.95:1 |

`themeMode: 'follow'` 则跟随用户主题（亮色下背景融入效果差，不推荐）。

### 5.4 配置系统

- `localStorage['dsh-backdrop-config']` JSON，默认值见 `DEFAULT_CONFIG`
- `loadConfig()` 深合并（layers/fluid/whale/fish/grid 各自合并，light/color 再嵌套）
- `window.__backdrop` 暴露：`toggleLayer / setOpacity / setConfig / config / dispose`

---

## 6. 验证工具链

| 脚本 | 用途 |
|---|---|
| `verify-inject.mjs` | headless Edge + CDP：查 backdrop-root/canvas 数/容器透明/主题/错误事件 + 截图 |
| `probe-contrast2.mjs` | 计算代表性元素前景/背景对比度（WCAG） |
| `probe-fish.mjs` | 查四层 canvas 渲染状态 + console 错误 |
| `probe-interactive.mjs` | 查配置合并结果与 localStorage |

**为什么不用 readPixels**：SwiftShader 下 `readPixels` 极慢，且 WebGL
`preserveDrawingBuffer:false` 时 present 后缓冲不可读（读到全 0 是假象）。
验证渲染用**截图 + DOM computed style**，验证逻辑用 **CDP evaluate 读运行时状态**。

对比度计算公式（WCAG）：`(L1+0.05)/(L2+0.05)`，L 为 sRGB 线性化亮度。

---

## 7. 扩展指南

### 加一层新背景（如"流星"）

1. `src/engine/` 写引擎：`export function createXxx(canvas, config) { ... return { dispose } }`
2. `client-source.js`：
   - `import { createXxx } from './engine/xxx.js'`
   - 创建 canvas + 样式（参考 fishCanvas）
   - `root.append(...)` 加入层级
   - `DEFAULT_CONFIG.layers.xxx` + `xxx: {...}` 配置
   - 引擎实例化 + `toggleLayer` map 加 `xxx` + dispose 加 `xxx.dispose()`
3. `node build.mjs` → 重启 → `verify-inject.mjs` 验证

### 换剪影

- 鲸鱼：替换 `src/hero-whale.svg`（或运行时换，见下）
- 鱼：改 `fish-school.js` 的 `FISH_SVG` 字符串
- 剪影要求：**纯白填充、轮廓饱满**（瓦片化会抹平细枝末节）、
  建议 viewBox 比例 2:1 左右

运行时换鲸鱼剪影（`whale.src` 接受 `Image.src` 支持的一切：URL / data URI /
相对路径；`client-source.js` 的 `setConfig` 检测到 `src` 字段会调用 `loadSrc`
重新采样重建，无需刷新）：

```js
__backdrop.setConfig({ whale: { src: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg>…</svg>') } })
```

### 调参速查

```js
// 鱼变多变小
__backdrop.setConfig({ fish: { count: 60, scaleMin: 0.2, scaleMax: 0.45 } })
// 鲸鱼更亮
__backdrop.setConfig({ whale: { light: { shadeMax: 2.0 } } })
// 流体更淡（不抢视线）
__backdrop.setConfig({ fluid: { glowIntensity: 0.03, vignette: 0.5 } })
// 整体弱化
__backdrop.setOpacity(0.5)
```

**参数边界速查**（不会崩，但超范围会没效果或很夸张）：

| 参数 | 有效范围 | 说明 |
|---|---|---|
| `opacity` | 0~1 | 0 全透明 |
| `fish.count` | 1~200 | 建议 ≤80（draw call 数） |
| `fish.density` | 20~48 | <30 鱼形模糊，>40 瓦片过多（每鱼瓦片 ≈ density²×0.06） |
| `whale.density` | 40~100 | 瓦片 ≈ density²×0.22（60≈800） |
| `fish.scale*` | 0.1~1.5 | 世界单位（视野宽约 16.8） |
| `fluid.glowIntensity` | 0~0.5 | 0 关闭鼠标光晕 |
| `whale.light.shadeMax` | 0.1~4 | 越高越亮 |
| `themeMode` | `force-dark` / `follow` | follow 在亮色下背景融入差 |

---

## 8. 版本历史（迭代备忘）

| 版本 | 变更 |
|---|---|
| v0.1 初版 | 鲸鱼单层 + 蓝渐变背景（用户反馈"没有原版高级"） |
| v0.2 | 补流体 + 网格 + mask + 黑底（官网四层结构） |
| v0.3 | 插件化：ESM 引擎 + client 注入 + 容器透明化 + force-dark |
| v0.4 | 强制官方暗色主题（修"看不清字"）；流体笔刷默认关（修"光斑跟手"） |
| v0.5 | 新增瓦片鱼群（重画鱼形 + 尾摆反转 + 尺寸调优） |
| v0.5.1 | `setConfig` 支持 `whale.src` 热替换（自动重新采样）；文档盲测修订（安装路径/src 格式/参数边界） |
