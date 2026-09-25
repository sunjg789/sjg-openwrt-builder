'use strict';
/**
 * build.js — 在线构建任务簿
 *
 * 把「推构建包 → 触发 workflow → 轮询进度 → 拉回 Artifacts」这条链路的状态落盘，
 * 存在 out/builds/<id>/meta.json（out/ 已在 .gitignore 里，不会进仓库）。
 * 状态查询时顺带推进：run 一结束就自动把产物拉回本地，前端拿到即可下载。
 */
const fs = require('fs');
const path = require('path');
const { Gh } = require('./gh');

const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'out', 'builds');
// 正在拉产物的任务：同一任务可能被多个轮询同时打到，369MB 的产物并行下两份纯属浪费
const pulling = new Set();
const CONF_DIR = path.join(ROOT, 'config');
const CONF_FILE = path.join(CONF_DIR, 'gh.json');

function readConfig() {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  let repo = process.env.GH_REPO || '';
  let source = token ? 'env' : null;
  if (!token || !repo) {
    try {
      const c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
      if (!token && c.token) { token = c.token; source = 'file'; }
      if (!repo && c.repo) repo = c.repo;
    } catch (e) { /* 没配过就用默认值 */ }
  }
  return { token, repo, source };
}

function saveConfig({ token, repo }) {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  const cur = readConfig();
  const next = {
    token: token === undefined ? cur.token : String(token).trim(),
    repo: repo === undefined ? cur.repo : String(repo).trim(),
  };
  fs.writeFileSync(CONF_FILE, JSON.stringify(next, null, 2));
  return next;
}

function dirOf(id) { return path.join(STORE, String(id).replace(/[^\w.-]/g, '_')); }

function readMeta(id) {
  const f = path.join(dirOf(id), 'meta.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

function writeMeta(id, meta) {
  fs.mkdirSync(dirOf(id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(id), 'meta.json'), JSON.stringify(meta, null, 2));
}

function listBuilds() {
  if (!fs.existsSync(STORE)) return [];
  return fs.readdirSync(STORE)
    .map((d) => { try { return JSON.parse(fs.readFileSync(path.join(STORE, d, 'meta.json'), 'utf8')); } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .map((m) => ({
      id: m.id, repo: m.repo, branch: m.branch, state: m.state, runUrl: m.runUrl,
      startedAt: m.startedAt, finishedAt: m.finishedAt, files: m.files || [],
      summary: m.summary, error: m.error || null,
    }));
}

/**
 * 启动一次在线构建
 * @param {object} spec 前端 buildSpec()
 * @param {Array<{path:string,content:string}>} files 已生成的构建套件
 */
async function startBuild(spec, files, { token: tokenIn, repo: repoIn } = {}) {
  const conf = readConfig();
  const token = tokenIn || conf.token;
  const repo = repoIn || conf.repo;
  if (!token) throw new Error('还没有配置 GitHub Token，请先在「在线构建」里保存');
  if (!repo) throw new Error('还没有配置 GitHub 仓库，请填 owner/repo');

  const gh = new Gh(token, repo);
  const login = await gh.whoami();

  const wf = files.find((f) => /^\.github\/workflows\/[^/]+\.yml$/.test(f.path));
  if (!wf) throw new Error('构建套件里没有 .github/workflows/*.yml，无法触发在线构建');
  const workflowFile = wf.path.split('/').pop();

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const slug = [spec.distro, spec.version, spec.target, spec.subtarget, spec.engine]
    .filter(Boolean).join('-').replace(/[^\w.-]/g, '_').slice(0, 60);
  const id = `${stamp}-${slug}`;
  const branch = `build/${slug}-${stamp}`;

  const meta = {
    id, repo, branch, workflowFile, login,
    summary: { distro: spec.distro, version: spec.version, target: spec.target, subtarget: spec.subtarget, engine: spec.engine, profile: spec.profile },
    filesCount: files.length,
    startedAt: new Date().toISOString(),
    finishedAt: null, state: 'pushing', runId: null, runUrl: null, checked: null,
    jobs: [], artifacts: [], downloaded: false, files: [], error: null,
  };
  writeMeta(id, meta);

  try {
    // GitHub 的 workflow_dispatch 只认**默认分支**上的工作流文件：推到临时分支的 yml
    // 即使内容正确，dispatches 也会 404（实测确认）。所以先探一下走哪条路。
    const registered = await gh.isRegisteredOnDefault(workflowFile).catch(() => null);
    meta.trigger = registered ? 'workflow_dispatch' : 'push';
    meta.registeredOnDefault = !!registered;
    writeMeta(id, meta);

    const pushed = await gh.pushKit(
      files,
      branch,
      `build: ${spec.distro} ${spec.version} ${spec.target}/${spec.subtarget} (${spec.engine})`,
      // 工作流已在默认分支时，提交信息带 [skip ci]，避免 push 与 dispatch 各起一个 run；
      // 否则必须让 push 触发器干活（这是唯一能跑起来的路径）。
      { skipCi: !!registered },
    );
    meta.state = 'dispatching';
    meta.commit = pushed.commit;
    meta.treeUrl = pushed.htmlUrl;
    writeMeta(id, meta);

    if (registered) {
      await gh.dispatch(workflowFile, branch);
    }
    meta.state = 'queued';
    writeMeta(id, meta);

    // 轮询把 run 找出来（分支是独享的，取该分支最新 run 即可）
    for (let i = 0; i < 30 && !meta.runId; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const run = await gh.findRun(branch);
      if (run) {
        meta.runId = run.id;
        meta.runUrl = run.htmlUrl;
        meta.state = run.status;
        meta.triggeredBy = run.event;
        writeMeta(id, meta);
      }
    }
    if (!meta.runId) {
      // 「工作流已注册」这个结论未必可靠（同一文件名曾跑过就可能被列出），
      // 于是会出现：dispatch 返回成功、[skip ci] 又掐掉了 push 触发器 → 一个 run 都没有。
      // 兜底：去掉 [skip ci] 再推一次，让 push 触发器接管。
      meta.state = 'retrying';
      meta.retriedPush = true;
      writeMeta(id, meta);
      try {
        const rep = await gh.pushKit(
          files, branch,
          `retry: ${spec.distro} ${spec.version} ${spec.target}/${spec.subtarget} (${spec.engine})`,
          { skipCi: false },
        );
        meta.commit = rep.commit;
        writeMeta(id, meta);
        for (let i = 0; i < 20 && !meta.runId; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const run = await gh.findRun(branch);
          if (run) {
            meta.runId = run.id;
            meta.runUrl = run.htmlUrl;
            meta.state = run.status;
            meta.triggeredBy = run.event;
            writeMeta(id, meta);
          }
        }
      } catch (e) {
        meta.pushRetryError = e.message;
        writeMeta(id, meta);
      }
    }
    if (!meta.runId) {
      meta.state = 'unknown';
      meta.error = registered
        ? '已推送并触发，但没查到运行记录，请打开仓库 Actions 页面确认'
        : '已推送到专属分支，但工作流没有自动运行。可能是工作流里缺少 push 触发器，'
          + '或该仓库限制了非默认分支的 Actions，请到 Actions 页面手动运行';
      meta.runUrl = await guessRepoUrl(gh, branch);
      writeMeta(id, meta);
    }
  } catch (e) {
    meta.state = 'failed';
    meta.error = e.message;
    meta.finishedAt = new Date().toISOString();
    writeMeta(id, meta);
  }
  return meta;
}

/**
 * 构建失败时把云端日志尾部拉回来。
 * 只保留 job 级汇总日志（名字不含 '/' 的那个），同一步骤的独立文件是它的重复内容，
 * 全塞进来只会让任务簿膨胀。
 */
async function attachLogTail(gh, id, meta) {
  if (meta.logTail) return meta;
  const all = await gh.logsTail(meta.runId, 120).catch(() => []);
  const main = all.filter((f) => !f.name.includes('/'));
  if (!main.length) return meta;
  const last = main[main.length - 1];
  const lines = last.tail.split('\n');
  meta.logFile = last.name;
  meta.logLines = last.lines;
  meta.logTail = last.tail;
  // 从尾部揪出真正报错那几行，前端一眼能看到，不必读几百行 make 输出
  meta.errorLines = lines
    .filter((l) => /make(\[\d+\])?: \*\*\*|##\[error\]|Error [0-9]+$|cannot stat|No such file or directory|command not found|WARNING: Install/i.test(l))
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, ''))
    .slice(-10);
  writeMeta(id, meta);
  return meta;
}

/**
 * 后台回传产物。
 * 断点续传已经写在下载里，这里只负责把进度写回台账，让前台能显示「已回传 x/y MB」。
 * 写盘按 5 秒节流，避免几百 MB 的下载把 meta.json 刷爆。
 */
async function pullArtifacts(gh, id, meta, arts) {
  // 上一轮已经拉成功的不再重下：大产物重复下载代价太大
  const prevOk = new Map((meta.files || []).filter((f) => !f.error).map((f) => [f.file, f]));
  const got = [];
  for (const a of arts) {
    const file = `${String(a.name).replace(/[^\w.-]/g, '_')}.zip`;
    const dest = path.join(dirOf(id), file);
    if (prevOk.has(file) && fs.existsSync(dest)) { got.push(prevOk.get(file)); continue; }
    const resumed = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const rec = {
      name: `${a.name}.zip`, file, origin: a.name, pulling: true,
      written: resumed, total: a.size || 0, resumed,
      startedAt: new Date().toISOString(),
    };
    meta.files = got.concat([rec]);
    let lastWrite = 0;
    try {
      const out = await gh.downloadArtifact(a.id, dest, {
        onProgress: (written, total) => {
          rec.written = written;
          rec.total = total;
          const now = Date.now();
          if (now - lastWrite > 5000) { lastWrite = now; writeMeta(id, meta); }
        },
      });
      rec.size = out.size; rec.total = out.total || out.size;
      rec.pulling = false;
      rec.finishedAt = new Date().toISOString();
    } catch (e) {
      rec.error = e.message;
      rec.pulling = false;
      rec.finishedAt = new Date().toISOString();
    }
    got.push(rec);
  }
  meta.files = got;
  meta.downloadAttempts = (meta.downloadAttempts || 0) + 1;
  meta.downloaded = got.every((f) => !f.error && !f.pulling);
  writeMeta(id, meta);
}

async function guessRepoUrl(gh, branch) {
  const info = await gh.repoExists().catch(() => null);
  return info ? `${info.html_url}/actions` : '';
}

/** 查询并推进一次构建状态；run 结束会自动拉回 artifacts */
async function getBuild(id) {
  const meta = readMeta(id);
  if (!meta) return null;
  // terminal 表示这一轮已经把「拉日志 / 拉产物」的收尾做完了，后续轮询直接读盘，不再打 API
  if (meta.terminal || meta.state === 'failed') return meta;

  const conf = readConfig();
  const gh = new Gh(conf.token, meta.repo);

  if (meta.runId) {
    try {
      const st = await gh.runStatus(meta.runId);
      meta.state = st.status;
      meta.checked = new Date().toISOString();
      // 轮询过程中的抖动不该留下历史错误，这里每轮成功就清掉
      meta.error = null;
      if (st.conclusion) meta.conclusion = st.conclusion;
      const jobs = await gh.jobs(meta.runId).catch(() => []);
      if (jobs.length) meta.jobs = jobs;
      writeMeta(id, meta);

      if (st.status === 'completed') {
        if (st.conclusion !== 'success') await attachLogTail(gh, id, meta);
        const arts = await gh.artifacts(meta.runId).catch(() => []);
        meta.artifacts = arts;
        if (arts.length && !pulling.has(id)) {
          pulling.add(id);
          // 不 await：让这次 HTTP 立刻返回，回传在后台继续，前台按进度刷新
          pullArtifacts(gh, id, meta, arts).finally(() => pulling.delete(id));
        }
        meta.finishedAt = meta.finishedAt || new Date().toISOString();
        const pullingNow = (meta.files || []).some((f) => f.pulling);
        if (!arts.length) {
          meta.terminal = true;
        } else if (meta.downloaded) {
          meta.terminal = true;
        } else if (pullingNow) {
          meta.terminal = false; // 正在回传，继续轮询看进度
        } else if (meta.downloadAttempts >= 3) {
          // 下载抖动不能把这次永久判死：多次重试后才判为失败
          meta.terminal = true;
          meta.error = `产物拉取失败（已重试 ${meta.downloadAttempts} 次）：${(meta.files || []).filter((f) => f.error).map((f) => f.error).join('；')}`;
        }
        writeMeta(id, meta);
      }
    } catch (e) {
      meta.error = e.message;
      writeMeta(id, meta);
    }
  }
  return meta;
}

module.exports = { readConfig, saveConfig, startBuild, getBuild, listBuilds, readMeta, dirOf, STORE };
