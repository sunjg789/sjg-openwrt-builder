'use strict';
/**
 * gh.js — 极简 GitHub API 客户端（零依赖，只用 Node 内置 fetch）
 *
 * 支撑「站点一键 push → workflow_dispatch → 轮询 → 拉回 Artifacts」这条闭环：
 *   1. pushKit()      用 Git Data API 直接落一个孤儿分支（不需要本地 git）
 *   2. dispatch()     触发 workow_dispatch
 *   3. runStatus()    轮询 run / jobs
 *   4. artifacts()    列出产物
 *   5. downloadArtifact() 下载 zip（接口是 302，需要手动跟跳转）
 *
 * 注意：
 * - 提交信息统一带 `[skip ci]`，否则 push 触发器会和我们的 dispatch 各起一个 run，白烧一倍分钟数。
 * - dispatch 用的是**工作流文件名**而不是 id，因为 id 要等到工作流注册后才有。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const API = 'https://api.github.com';
const UA = 'openwrt-custom-builder/2.0';

/**
 * 极简 ZIP 读取器（仅支持 deflate / stored，够读 GitHub 的 logs.zip）。
 * 不引第三方包的代价就是得自己走一遍中央目录；实际比想象中简单：
 * EOCD → 中央目录项 → 拿 local header 偏移 → 读偏移处的真实数据。
 */
function unzip(buf) {
  const out = [];
  // 1) 从尾部倒着找 EOCD（0x06054b50），注释最多 64KB
  let eocd = -1;
  const maxScan = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');

  let cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = buf.readUInt16LE(eocd + 10);

  for (let n = 0, p = cdOffset; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Zip64 扩展里才是真值（日志一般到不了 4GB，但读 ../localOff 时防御一下不亏）
    let realCompSize = compSize;
    let realLocalOff = localOff;
    if (compSize === 0xffffffff || localOff === 0xffffffff) {
      let q = p + 46 + nameLen;
      const end = q + extraLen;
      while (q + 4 <= end) {
        const tag = buf.readUInt16LE(q);
        const size = buf.readUInt16LE(q + 2);
        let v = q + 4;
        if (tag === 0x0001) {
          if (rawSize === 0xffffffff) v += 8;
          if (compSize === 0xffffffff) { realCompSize = Number(buf.readBigUInt64LE(v)); v += 8; }
          if (localOff === 0xffffffff) { realLocalOff = Number(buf.readBigUInt64LE(v)); }
          break;
        }
        q += 4 + size;
      }
    }
    localOff = realLocalOff;
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const chunk = buf.slice(dataStart, dataStart + realCompSize);

    let content;
    if (method === 0) content = chunk;
    else if (method === 8) content = zlib.inflateRawSync(chunk);
    else continue; // 其它压缩方式先不处理

    out.push({ name, content });
  }
  return out;
}

/**
 * 只问总长度，不拖数据：Range 只要 1 字节，从 Content-Range 里读回 xxx/total。
 * 取不到就退回 HEAD 看 Content-Length；再不行抛错由调用方决定怎么办。
 */
async function probeSize(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) return Number(m[1]);
    }
    const cl = res.headers.get('content-length');
    if (cl) return Number(cl);
    throw new Error(`探不到产物大小（HTTP ${res.status}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 去掉 ANSI 颜色/定位控制序列，日志才能干净显示 */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

class Gh {
  constructor(token, repo) {
    this.token = String(token || '').trim();
    this.repo = String(repo || '').trim();
  }

  get loginHint() {
    const m = this.repo.match(/^([^/]+)\//);
    return m ? m[1] : null;
  }

  async req(method, urlPath, body, { raw = false, timeout = 30000 } = {}) {
    if (!this.token) throw new Error('未配置 GitHub Token');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const headers = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${this.token}`,
    };
    let payload;
    if (body && !raw) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    } else {
      payload = body;
    }
    try {
      const res = await fetch(urlPath.startsWith('http') ? urlPath : API + urlPath, {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: ctrl.signal,
      });
      if (res.status === 204) return { ok: true, status: 204, json: null };
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
      return { ok: res.status < 300, status: res.status, json, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 校验 token / repo 是否可用，顺便拿到登录用户名 */
  async whoami() {
    const r = await this.req('GET', '/user');
    if (!r.ok) throw new Error(`Token 不可用：${r.json && r.json.message ? r.json.message : 'HTTP ' + r.status}`);
    return r.json.login;
  }

  async repoExists() {
    const r = await this.req('GET', `/repos/${this.repo}`);
    return r.ok ? r.json : null;
  }

  /**
   * 把构建套件推到一个新建的孤儿分支
   * @param {Array<{path:string,content:string}>} files
   * @param {string} branch
   * @returns {{branch, commit, htmlUrl}}
   */
  async pushKit(files, branch, message, { skipCi = true } = {}) {
    const exist = await this.repoExists();
    if (!exist) throw new Error(`仓库 ${this.repo} 不存在（或 Token 无权限访问）。请先在 GitHub 上建好仓库，或换一个有权限的地址。`);

    // 1) blobs
    const tree = [];
    for (const f of files) {
      const r = await this.req('POST', `/repos/${this.repo}/git/blobs`, {
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      if (!r.ok) throw new Error(`写入 ${f.path} 失败：${r.json && r.json.message}`);
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: r.json.sha });
    }

    // 2) tree（不带 base_tree：孤儿分支，天然不与现有内容冲突）
    const t = await this.req('POST', `/repos/${this.repo}/git/trees`, { tree });
    if (!t.ok) throw new Error(`生成 tree 失败：${t.json && t.json.message}`);

    // 3) commit（parents 为空 → 根提交）
    const full = skipCi
      ? `${message}\n\n[skip ci]  // 工作流已注册在默认分支上，避免 push 与 dispatch 各起一个 run`
      : `${message}\n\n由 push 触发器发起（该工作流未注册在默认分支，dispatch 会 404）`;
    const c = await this.req('POST', `/repos/${this.repo}/git/commits`, {
      message: full,
      tree: t.json.sha,
      parents: [],
    });
    if (!c.ok) throw new Error(`创建 commit 失败：${c.json && c.json.message}`);

    // 4) ref
    const ref = await this.req('POST', `/repos/${this.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: c.json.sha,
    });
    if (!ref.ok) {
      // 分支已存在就强推到新 commit
      const patch = await this.req('PATCH', `/repos/${this.repo}/git/refs/heads/${branch}`, { sha: c.json.sha, force: true });
      if (!patch.ok) throw new Error(`创建/更新分支失败：${ref.json && ref.json.message}`);
    }
    return { branch, commit: c.json.sha, htmlUrl: `${exist.html_url}/tree/${branch}` };
  }

  /**
   * 默认分支上已注册的工作流里有没有这个文件？
   * GitHub 的 workflow_dispatch **只认默认分支**上的工作流文件——推到临时分支上的 yml
   * 即使内容正确，dispatches 也只会返回 404（实测确认）。所以要么工作流在默认分支
   * （走 dispatch），要么只能用 push 触发器。
   */
  async registeredWorkflows() {
    const r = await this.req('GET', `/repos/${this.repo}/actions/workflows?per_page=100`);
    if (!r.ok) return [];
    return (r.json && r.json.workflows || []).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
  }

  async isRegisteredOnDefault(workflowFile) {
    const ws = await this.registeredWorkflows();
    return ws.find((w) => w.path === `.github/workflows/${workflowFile}`) || null;
  }

  /** 触发 workflow_dispatch。新分支上的工作流要稍等才会注册，所以带重试 */
  async dispatch(workflowFile, branch, inputs = {}) {
    let last = null;
    for (let i = 0; i < 6; i++) {
      const r = await this.req('POST', `/repos/${this.repo}/actions/workflows/${workflowFile}/dispatches`,
        { ref: branch, inputs });
      if (r.ok || r.status === 204) return true;
      last = `${r.status} ${r.json && r.json.message ? r.json.message : ''}`.trim();
      if (r.status !== 404) break; // 404 多为尚未注册，其余错误不必重试
      await new Promise((x) => setTimeout(x, 1500 * (i + 1)));
    }
    throw new Error(`触发工作流失败：${last}（确认分支 ${branch} 上存在 .github/workflows/${workflowFile}）`);
  }

  /**
   * 找出这次构建对应的 run。
   *
   * 注意：**不要**加 `created>=` 之类的时间过滤——实测踩过坑：本机 Date.now() 与 GitHub
   * 的 created_at 并非严格同步，加上时间戳过滤会把明明已经跑完的 run 筛掉，表现为「查不到」。
   * 每次构建都推到独一无二的分支，所以直接取该分支最新的 run 就是最可靠的判据。
   * @returns {object|null}
   */
  async findRun(branch) {
    const r = await this.req('GET',
      `/repos/${this.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`);
    if (!r.ok) return null;
    const runs = (r.json && r.json.workflow_runs) || [];
    if (!runs.length) return null;
    runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    // 手动触发的优先，其次 push 触发的——两者都算我们自己这次构建发起的
    const headSha = runs[0].head_sha;
    const sameHead = runs.filter((x) => x.head_sha === headSha);
    const pick = sameHead.find((x) => x.event === 'workflow_dispatch') || sameHead[0];
    return {
      id: pick.id, htmlUrl: pick.html_url, status: pick.status,
      conclusion: pick.conclusion, event: pick.event,
      displayTitle: pick.display_title, createdAt: pick.created_at, updatedAt: pick.updated_at,
      headSha,
    };
  }

  async runStatus(runId) {
    const r = await this.req('GET', `/repos/${this.repo}/actions/runs/${runId}`);
    if (!r.ok) throw new Error(`查询运行状态失败：${r.json && r.json.message}`);
    const j = r.json;
    return { status: j.status, conclusion: j.conclusion, htmlUrl: j.html_url, updatedAt: j.updated_at };
  }

  /** job / step 级别的进度，便于前端显示「正在 xxx」 */
  async jobs(runId) {
    const r = await this.req('GET', `/repos/${this.repo}/actions/runs/${runId}/jobs?per_page=20`);
    if (!r.ok) return [];
    return (r.json && r.json.jobs || []).map((j) => ({
      name: j.name, status: j.status, conclusion: j.conclusion, startedAt: j.started_at,
      steps: (j.steps || []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number })),
    }));
  }

  async artifacts(runId) {
    const r = await this.req('GET', `/repos/${this.repo}/actions/runs/${runId}/artifacts?per_page=50`);
    if (!r.ok) throw new Error(`查询产物失败：${r.json && r.json.message}`);
    return (r.json && r.json.artifacts || []).map((a) => ({
      id: a.id, name: a.name, size: a.size_in_bytes, expired: a.expired, updatedAt: a.updated_at,
    }));
  }

  /**
   * 拉一次运行的完整日志（GitHub 给的是 zip，每个 job 一个 txt）。
   * 构建失败时用它回答「到底哪一步为什么炸」，而不是让用户自己翻 Actions 页面。
   * @returns {Promise<Array<{name:string, text:string}>>}
   */
  async logs(runId) {
    const r = await this.req('GET', `/repos/${this.repo}/actions/runs/${runId}/logs`, null, { timeout: 60000 });
    let finalUrl = null;
    if (r.status === 302 || r.status === 301) finalUrl = r.headers.get('location');
    else if (r.ok && r.json && typeof r.json.url === 'string') finalUrl = r.json.url;
    if (!finalUrl) throw new Error(`取不到日志下载地址（HTTP ${r.status}）`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let buf;
    try {
      const res = await fetch(finalUrl, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
      if (!res.ok) throw new Error(`下载日志失败：HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    return unzip(buf).map((e) => ({ name: e.name, text: stripAnsi(e.content.toString('utf8')) }));
  }

  /**
   * 只看最后若干行——失败信息基本都在尾部，没必要把几 MB 日志灌给前端。
   * @param {string|number} runId
   * @param {number} tailLines
   */
  async logsTail(runId, tailLines = 80) {
    const all = await this.logs(runId);
    return all.map((f) => {
      const lines = f.text.split('\n');
      return { name: f.name, lines: lines.length, tail: lines.slice(-tailLines).join('\n') };
    });
  }

  /**
   * 单独取一次 artifact 的下载直链（REST 返回 302，需要自己跟 Location）。
   *
   * 注意：这条直链本质是 **Azure 的短期 SAS 令牌**（实测十几分钟就返回 403）。
   * 所以续传过程中一旦重试，必须重新换一张下载票，而不是抱着旧链接死磕。
   */
  async artifactZipUrl(artifactId) {
    const r = await this.req('GET', `/repos/${this.repo}/actions/artifacts/${artifactId}/zip`);
    let finalUrl = null;
    if (r.status === 302 || r.status === 301) {
      finalUrl = r.headers.get('location');
    } else if (r.ok && r.json && typeof r.json.url === 'string') {
      finalUrl = r.json.url;
    }
    if (!finalUrl) throw new Error(`取不到下载跳转地址（HTTP ${r.status}）`);
    return finalUrl;
  }

  /**
   * 分片下载单个 artifact（Range 续传 + 逐片换票 + 逐片重试）。
   *
   * firmware 这类产物动辄几百 MB（实测 168~386MB），整包流式下载只要网络一抖就前功尽弃，
   * 报错还永远是干巴巴的 terminated——看不出进度、也续不上。
   */
  async downloadArtifact(artifactId, destFile, opt = {}) {
    const { retries = 5, onProgress } = opt;
    // 4MB／片：家里到 blob 实测几十 KB/s，一片拖太久会撞上 SAS 过期
    const chunk = opt.chunk || 4 * 1024 * 1024;
    let finalUrl = await this.artifactZipUrl(artifactId);
    const refresh = async () => { finalUrl = await this.artifactZipUrl(artifactId); return finalUrl; };
    const getUrl = async () => finalUrl;

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const total = await probeSize(finalUrl);
    // 已有半成品且长度对得上 total 的中间态才复用；否则从头来，避免把脏数据拼进 zip
    let base = fs.existsSync(destFile) ? fs.statSync(destFile).size : 0;
    if (base > total) base = 0;
    const fh = fs.openSync(destFile, base === total ? 'r' : fs.existsSync(destFile) ? 'r+' : 'w');
    if (base !== total) fs.ftruncateSync(fh, base);

    let written = base;
    try {
      while (written < total) {
        const end = Math.min(written + chunk, total) - 1;
        const buf = await this.fetchRange(getUrl, written, end, retries, refresh);
        fs.writeSync(fh, buf, 0, buf.length, written);
        written += buf.length;
        if (onProgress) onProgress(written, total);
      }
    } finally {
      fs.closeSync(fh);
    }

    const got = fs.statSync(destFile).size;
    if (got !== total) throw new Error(`下载不完整：${got}/${total} 字节`);
    const head = Buffer.alloc(2);
    const fd = fs.openSync(destFile, 'r');
    try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1') !== 'PK') throw new Error('下载到的不是 zip（魔数不是 PK）');
    return { file: destFile, size: got };
  }

  /** 单个 Range 分片，失败重试——整包重来太贵，单片重来很便宜 */
  async fetchRange(getUrl, start, end, retries, refresh) {
    let last = null;
    for (let i = 0; i <= retries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000); // 单片 4MB，2 分钟还没下完就是有问题
      try {
        const url = await getUrl();
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` },
          redirect: 'follow',
          signal: ctrl.signal,
        });
        // 206 = 拿到分片；200 = 服务端不支持 Range，那只能整包来（此时拿到的就是全量）
        if (res.status !== 206 && res.status !== 200) {
          throw new Error(`HTTP ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('空响应');
        return buf;
      } catch (e) {
        last = e;
        await new Promise((x) => setTimeout(x, 800 * (i + 1)));
        // 重试一律先换一张新下载票：旧 SAS 过期时只有重新取值才可能成功
        try { if (refresh) await refresh(); } catch { /* 换票失败就按原错误往上抛 */ }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`第 ${start}-${end} 分片拉取失败（重试 ${retries} 次）：${last && last.message}`);
  }
}

module.exports = { Gh };
