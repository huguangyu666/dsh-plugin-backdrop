/**
 * dsh-plugin-backdrop host 端（最小实现）。
 * 背景替换全部在 client 端完成；host 仅作为插件挂载点存在。
 * 后续可在此暴露配置服务（如 /api-backdrop/config）。
 */
export const name = 'dsh-plugin-backdrop';
export const inject = [];

export function apply(ctx) {
  // 预留：配置持久化服务、剪影资源路由等
}
