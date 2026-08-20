/**
 * 构建脚本：生成 lib/ 发布产物。
 * - lib/index.js   host 端（ESM）
 * - lib/client.js  client bundle（CJS + __ModuleLoader__.load 包装，官方格式）
 *   three.js + 三个引擎 + GLSL + 鲸鱼 SVG(dataurl) 全部内联
 */
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const ID = 'dsh-plugin-backdrop';
rmSync('lib', { recursive: true, force: true });
mkdirSync('lib', { recursive: true });

// 1. host 端：ESM bundle
execSync(
  `npx esbuild src/index.js --bundle --format=esm --platform=node --target=es2022 ` +
  `--external:node:fs --external:node:path --external:node:sqlite --external:@deepseek-ai/* ` +
  `--outfile=lib/index.js`,
  { stdio: 'inherit' });

// 2. client bundle：CJS + load 包装（官方 banner/footer 格式）
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`;
const footer = `return module.exports; } });`;
execSync(
  `npx esbuild src/client-source.js --bundle --format=cjs --platform=browser --target=es2022 ` +
  `--loader:.svg=dataurl --external:@deepseek-ai/* ` +
  `--banner:js=${JSON.stringify(banner)} --footer:js=${JSON.stringify(footer)} ` +
  `--outfile=lib/client.js`,
  { stdio: 'inherit' });

// 3. 校验产物
const host = readFileSync('lib/index.js', 'utf8');
const client = readFileSync('lib/client.js', 'utf8');
if (!client.includes('__ModuleLoader__.load')) throw new Error('client bundle 缺 load 包装');
if (!client.includes('createWhaleCanvas')) throw new Error('client bundle 缺鲸鱼引擎');
if (!client.includes('createFishSchoolCanvas')) throw new Error('client bundle 缺鱼群引擎');
if (!client.includes('createFluidBackground')) throw new Error('client bundle 缺流体引擎');
if (!client.includes('createGridBackground')) throw new Error('client bundle 缺网格引擎');
console.log('构建完成：lib/index.js + lib/client.js');
console.log('host:', host.length, 'bytes | client:', client.length, 'bytes');
