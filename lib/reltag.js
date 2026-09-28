'use strict';
/**
 * Release tag 的**唯一权威定义**。
 *
 * 这个字符串同时被两方使用：
 *   - 生成工作流时：决定 `gh release create` 用哪个 tag；
 *   - app 拉产物时：决定去查哪个 Release。
 * 一旦两边漂移，症状是「构建全绿、产物在 GitHub 上明明躺着、app 却说没有产物」，
 * 而且不会报任何错——极难排查。所以规则只写在这里，谁都不许各自拼一遍。
 *
 * 为什么用 run_id 而不是时间戳：
 *   app 在 dispatch 之后就知道 run_id 了，但**不可能预知**工作流运行时才生成的
 *   时间戳。tag 必须完全由 app 已知的信息构成，否则就只能拉列表做模糊匹配，
 *   一旦并发构建或同名前缀就撞车。run_id 全局唯一，天然够用。
 */

/**
 * tag 前缀（不含 run_id）。生成器把它拼进 shell，app 用它查 Release。
 * @param {{engine?: string, distro: string, version: string, target: string, subtarget: string, profile: string}} p
 */
function releaseTagPrefix(p) {
  const prefix = p.engine === 'src' ? 'src-' : '';
  return `${prefix}${p.distro}-${p.version}-${p.target}-${p.subtarget}-${p.profile}-r`;
}

/**
 * 完整 tag。
 * @param {object} p  specs 或 meta.summary 都可（字段相同）
 * @param {string|number} runId
 */
function releaseTag(p, runId) {
  return releaseTagPrefix(p) + String(runId);
}

module.exports = { releaseTagPrefix, releaseTag };
