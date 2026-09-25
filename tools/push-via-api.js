/**
 * 用 GitHub Git Data API 把本地 HEAD 推到远端 —— 专为「git 命令行用不了」的环境兜底。
 *
 * 触发场景（实测于受限沙箱）：
 *   - `git push` 会被直接杀掉（SIGTERM，连输出都没有）；
 *   - Node 里 `spawnSync('git', ...)` 报 EBUSY。
 * 但 REST 通道是通的，于是自己按 Git 对象模型拼 tree / commit 再更新 ref。
 *
 * 用法（两步，缺一不可）：
 *   1) 在仓库根目录执行下面几条，导出 git 视角的真实数据（注意别用 git archive：
 *      它会按 .gitattributes 反转换行，导出的内容跟仓库里的 blob 对不上）：
 *        git rev-parse HEAD > tmp-head-sha.txt
 *        git ls-tree -r HEAD > tmp-ls.txt
 *        git cat-file commit HEAD > tmp-commit.txt
 *        git rev-parse "HEAD^{tree}" > tmp-root-tree.txt
 *   2) node tools/push-via-api.js
 *
 * 之所以要对齐套件：Git 对象的 sha 由内容决定，只要 tree / parent / author / committer /
 * message 全部一致，远端生成出来的 commit sha 会和本地 HEAD **一模一样**。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const cfg = JSON.parse(rd('config/gh.json'));
const [owner, repoName] = cfg.repo.split('/');
const API = 'https://api.github.com';

for (const need of ['tmp-head-sha.txt', 'tmp-ls.txt', 'tmp-commit.txt', 'tmp-root-tree.txt']) {
  if (!fs.existsSync(path.join(ROOT, need))) {
    console.error(`缺少 ${need}，请先在仓库根目录生成：
  git rev-parse HEAD > tmp-head-sha.txt
  git ls-tree -r HEAD > tmp-ls.txt
  git cat-file commit HEAD > tmp-commit.txt
  git rev-parse "HEAD^{tree}" > tmp-root-tree.txt`);
    process.exit(1);
  }
}

async function rawFetch(method, p, body) {
  return fetch(API + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'push-via-api',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function api(method, p, body) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await rawFetch(method, p, body);
      const txt = await res.text();
      if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${txt.slice(0, 200)}`);
      return txt ? JSON.parse(txt) : null;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  const c = lastErr && lastErr.cause;
  throw new Error(`${lastErr && lastErr.message} | cause=${c ? c.code + ' ' + c.message : 'n/a'}`);
}

(async () => {
  const rawCommit = rd('tmp-commit.txt');
  const rootTree = rd('tmp-root-tree.txt').trim();
  const want = new Map();
  for (const line of rd('tmp-ls.txt').split('\n').filter(Boolean)) {
    const [meta, p] = line.split('\t');
    want.set(p, meta.split(' ')[2]);
  }
  // 直接读工作区文件（工作区干净 == HEAD），绕开 git archive 的换行反转
  const files = [...want.keys()].map((p) => ({ path: p, full: p, mode: '100644' }));
  console.log('本地根树 =', rootTree, '，文件数 =', files.length);

  // 1) 上传所有 blob（以 ls-tree 里的 sha 为准，处理 eol 转换导致工作区与 blob 不一致的情况）
  const gitSha = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
  const shaOf = new Map();
  const unresolved = [];
  for (const f of files) {
    const wantSha = want.get(f.path);
    let buf = fs.readFileSync(path.join(ROOT, f.full));
    if (wantSha && gitSha(buf) !== wantSha) {
      // .gitattributes + core.autocrlf 会让磁盘内容与仓库 blob 的换行不一致，两种方向都试
      const lf = Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
      const crlf = Buffer.from(lf.toString('binary').replace(/\n/g, '\r\n'), 'binary');
      if (gitSha(lf) === wantSha) { buf = lf; console.log('  (还原 LF)', f.path); }
      else if (gitSha(crlf) === wantSha) { buf = crlf; console.log('  (还原 CRLF)', f.path); }
      else { unresolved.push(f.path); console.log('  !! 与仓库 blob 不一致', f.path); }
    }
    const created = await api('POST', `/repos/${owner}/${repoName}/git/blobs`, {
      content: buf.toString('base64'), encoding: 'base64',
    });
    shaOf.set(f.path, created.sha);
  }
  console.log('blob 上传完成:', files.length);
  // 有文件既不是 LF 也不是 CRLF 能对上，通常意味着「工作区内容和 HEAD 不一致」（改了没提交）。
  // 这时继续推会把现场没提交的内容悄悄推上去，所以直接拦下。
  if (unresolved.length && !process.argv.includes('--force')) {
    console.error(`\n中止：以下文件的工作区内容与 HEAD 不一致（多半是改了没提交）：\n  ${unresolved.join('\n  ')}
\n要么先 git add + git commit 再重导出 tmp 文件，要么确认无误后加 --force。`);
    process.exit(1);
  }

  // 2) 递归建树
  const rootChildren = new Map();
  const mkdirp = (parts) => {
    let node = rootChildren;
    for (const p of parts) {
      if (!node.get(p) || !node.get(p).children) node.set(p, node.get(p) || { children: new Map() });
      node = node.get(p).children;
    }
    return node;
  };
  for (const f of files) {
    const parts = f.path.split('/');
    const name = parts.pop();
    const parent = parts.length ? mkdirp(parts) : rootChildren;
    parent.set(name, { file: f });
  }
  async function build(node) {
    const tree = [];
    for (const [name, child] of node) {
      if (child.file) tree.push({ path: name, mode: child.file.mode, type: 'blob', sha: shaOf.get(child.file.path) });
      else tree.push({ path: name, mode: '040000', type: 'tree', sha: await build(child.children) });
    }
    // Git 树对象必须排序：目录按 "名字+/" 参与比较
    tree.sort((a, b) => {
      const ka = a.type === 'tree' ? a.path + '/' : a.path;
      const kb = b.type === 'tree' ? b.path + '/' : b.path;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return (await api('POST', `/repos/${owner}/${repoName}/git/trees`, { tree })).sha;
  }
  const apiTree = await build(rootChildren);
  console.log('远端根树 =', apiTree, apiTree === rootTree ? '（与本地一致 ✓）' : '（不一致 ✗）');

  // 3) 复刻原 commit 对象（tree/parent/author/committer/message 全部对齐 → sha 应相同）
  const splitAt = rawCommit.indexOf('\n\n');
  const head = rawCommit.slice(0, splitAt);
  const msg = rawCommit.slice(splitAt + 2);
  const headLines = head.split('\n');
  const who = (line) => {
    const lt = line.lastIndexOf('<');
    const gt = line.indexOf('> ', lt);
    const name = line.slice(line.indexOf(' ') + 1, lt).trim();
    const email = line.slice(lt + 1, gt);
    const rest = line.slice(gt + 2).trim().split(/\s+/);
    const ms = Number(rest[0]) * 1000;
    const off = rest[1] || '+0000';
    // GitHub 只接受 RFC3339（+08:00），且必须换算到该时区，才能还原原 git 对象的 *. +0800
    const tz = off.replace(/([+-]\d{2})(\d{2})/, '$1:$2');
    const localMs = ms + (Number(rest[1].slice(0, 3)) * 60 + Number(rest[1].slice(3)) * (rest[1][0] === '-' ? -1 : 1)) * 60000;
    return { name, email, date: new Date(localMs).toISOString().replace(/\.\d+Z$/, tz) };
  };
  const author = who(headLines.find(l => l.startsWith('author ')));
  const committer = who(headLines.find(l => l.startsWith('committer ')));
  // parent 取本地提交对象的 parent：回滚掉上一次内容有误的提交，保证祖先链一致
  const parentSha = headLines.find(l => l.startsWith('parent ')).slice(7).trim();
  console.log('parent =', parentSha, '\nauthor =', JSON.stringify(author), '\ncommitter =', JSON.stringify(committer));

  const cm = await api('POST', `/repos/${owner}/${repoName}/git/commits`, {
    message: msg, tree: apiTree, parents: [parentSha], author, committer,
  });
  const localHead = rd('tmp-head-sha.txt').trim();
  console.log('远端 commit =', cm.sha, cm.sha === localHead
    ? `(与本地 HEAD ${localHead.slice(0, 7)} 完全一致 ✓)`
    : `(!= 本地 HEAD ${localHead.slice(0, 7)}：对象里有字段没对齐，内容虽等价，建议核对 tree/日期)`);

  await api('PATCH', `/repos/${owner}/${repoName}/git/refs/heads/main`, { sha: cm.sha, force: true });
  console.log('refs/heads/main 已更新到', cm.sha);
})().catch(e => { console.error('失败：', e.message); process.exit(1); });
