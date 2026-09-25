'use strict';
/**
 * server.js — 零依赖 HTTP 服务 + 元数据 / 生成 API
 *
 * 端点一览：
 *   GET  /api/distros                                    发行版列表
 *   GET  /api/versions?distro=                           该发行版全部可用版本（实时抓取）
 *   GET  /api/targets?distro=&version=                   该版本的全部 CPU 架构
 *   GET  /api/subtargets?distro=&version=&target=        该架构的子目标
 *   GET  /api/profiles?distro=&version=&target=&sub=     该子目标的全部设备 profile
 *   GET  /api/packages?distro=&version=&arch=            该版本软件索引 + 可用插件清单（随版本变换）
 *   GET  /api/ib?distro=&version=&target=&sub=           ImageBuilder 可用性 / 真实下载地址
 *   GET  /api/images?distro=&version=&target=&sub=&profile=
 *                                                        该 profile 的**官方预编译固件**清单
 *                                                        （以上游 sha256sums 为权威来源，附 SHA256）
 *   GET  /api/imm-plugins?series=                        内置的版本专属插件清单（24.10 / 25.12）
 *   POST /api/repo/test                                  校验第三方软件源是否可用
 *   POST /api/preview                                    生成全部产物预览
 *   POST /api/zip                                        打包下载
 *   GET  /api/build/config                               在线构建的凭据 / 仓库配置
 *   POST /api/build/config                               保存并校验 GitHub Token + 仓库
 *   POST /api/build/start                                推构建包到 GitHub 并触发 workflow_dispatch
 *   GET  /api/build/status?id=                           查询进度（run 结束会自动拉回 Artifacts）
 *   GET  /api/build/list                                 历史在线构建
 *   GET  /api/build/file?id=&name=                       下载已拉回本地的产物 zip
 *   GET|POST /api/preset/...                             预设存取
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { DISTROS, DISTRO_IDS, seriesOf } = require('./lib/distros');
const U = require('./lib/upstream');
const IB = require('./lib/imagebuilder');
const P = require('./lib/plugins');
const { generateIB, estimateIB } = require('./lib/genib');
const { generateSRC, estimateSRC } = require('./lib/gensrc');
const { createZip } = require('./lib/zip');
const B = require('./lib/build');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PRESET_DIR = path.join(ROOT, 'presets');
const PORT = Number(process.env.PORT || 8730);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC, rel);
  if (!target.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

function ensurePresetDir() {
  if (!fs.existsSync(PRESET_DIR)) fs.mkdirSync(PRESET_DIR, { recursive: true });
}

/** 版本号是否符合 X.Y.Z 的发布形态 */
function looksRelease(v) {
  return /^\d+\.\d+(\.\d+)?(-rc\d+)?$/.test(v);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = (k, d) => u.searchParams.get(k) || d;
  try {
    // ---------------- 元数据 ----------------
    if (req.method === 'GET' && u.pathname === '/api/distros') {
      return json(res, 200, {
        distros: DISTRO_IDS.map((id) => {
          const d = DISTROS[id];
          return { id, name: d.name, label: d.label, downloadBase: d.downloadBase, gitBase: d.gitBase, defaultVersion: d.defaultVersion, notes: d.notes };
        }),
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/versions') {
      const distro = q('distro');
      const force = q('refresh') === '1';
      if (!DISTROS[distro]) return json(res, 400, { error: '未知发行版' });
      const data = await U.listVersions(distro, force);
      const series = {};
      for (const v of data.versions) {
        const s = v.series;
        (series[s] = series[s] || []).push(v);
      }
      return json(res, 200, { ...data, grouped: series, defaultVersion: DISTROS[distro].defaultVersion });
    }

    if (req.method === 'GET' && u.pathname === '/api/targets') {
      const { distro, version } = { distro: q('distro'), version: q('version') };
      if (!distro || !version) return json(res, 400, { error: '缺少 distro/version' });
      return json(res, 200, await U.listTargets(distro, version, q('refresh') === '1'));
    }

    if (req.method === 'GET' && u.pathname === '/api/subtargets') {
      const distro = q('distro'), version = q('version'), target = q('target');
      if (!target) return json(res, 400, { error: '缺少 target' });
      return json(res, 200, await U.listSubtargets(distro, version, target, q('refresh') === '1'));
    }

    if (req.method === 'GET' && u.pathname === '/api/profiles') {
      const distro = q('distro'), version = q('version'), target = q('target'), sub = q('sub');
      if (!target || !sub) return json(res, 400, { error: '缺少 target/sub' });
      return json(res, 200, await U.getProfiles(distro, version, target, sub, q('refresh') === '1'));
    }

    if (req.method === 'GET' && u.pathname === '/api/images') {
      const distro = q('distro'), version = q('version'), target = q('target'), sub = q('sub');
      const profile = q('profile');
      if (!target || !sub || !profile) return json(res, 400, { error: '缺少 target/sub/profile' });
      return json(res, 200, await U.getImageList(distro, version, target, sub, profile, q('refresh') === '1'));
    }

    if (req.method === 'GET' && u.pathname === '/api/packages') {
      const distro = q('distro'), version = q('version'), arch = q('arch');
      if (!arch) return json(res, 400, { error: '缺少 arch' });
      const data = await P.resolve({ distro, version, arch, includeDiscovered: q('discover') !== '0' });
      return json(res, 200, { ...data, categories: P.CATEGORIES });
    }

    if (req.method === 'GET' && u.pathname === '/api/ib') {
      const distro = q('distro'), version = q('version'), target = q('target'), sub = q('sub');
      if (!target || !sub) return json(res, 400, { error: '缺少 target/sub' });
      return json(res, 200, await IB.resolveIbUrl(distro, version, target, sub, q('refresh') === '1'));
    }

    if (req.method === 'GET' && u.pathname === '/api/imm-plugins') {
      const file = path.join(ROOT, 'data', 'imm-plugins.json');
      if (!fs.existsSync(file)) return json(res, 404, { error: '内置清单缺失' });
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = q('series');
      return json(res, 200, key ? { key, entries: data[key] || [] } : { keys: Object.keys(data), data });
    }

    if (req.method === 'POST' && u.pathname === '/api/repo/test') {
      const { url } = JSON.parse((await readBody(req)) || '{}');
      if (!url) return json(res, 400, { ok: false, error: '未提供地址' });
      const base = String(url).replace(/\/+$/, '');
      const out = { base, ok: false, manager: null, count: 0, checked: [] };
      // index.json 最优先（apk 系与新版 opkg 都生成，且是纯 JSON）
      const rj = await U.httpGet(`${base}/index.json`, { timeout: 30000 });
      if (rj.ok) {
        try {
          const j = JSON.parse(rj.body.toString('utf8'));
          out.ok = true; out.manager = 'apk+json'; out.count = Object.keys(j.packages || {}).length;
          out.checked.push(`index.json → ${out.count} 个包`);
          return json(res, 200, out);
        } catch (e) { out.checked.push('index.json 存在但解析失败'); }
      } else out.checked.push(`index.json → HTTP ${rj.status}`);
      // opkg 的 Packages.gz
      const rg = await U.httpGet(`${base}/Packages.gz`, { timeout: 40000 });
      if (rg.ok) {
        try {
          const txt = zlib.gunzipSync(rg.body).toString('utf8');
          const names = new Set();
          const re = /^Package:\s*(.+)$/gm; let m;
          while ((m = re.exec(txt))) names.add(m[1].trim());
          out.ok = true; out.manager = 'opkg'; out.count = names.size;
          out.checked.push(`Packages.gz → ${names.size} 个包`);
          out.sample = Array.from(names).slice(0, 40);
          return json(res, 200, out);
        } catch (e) { out.checked.push('Packages.gz 解压失败'); }
      } else out.checked.push(`Packages.gz → HTTP ${rg.status}`);
      // apk 的二进制索引，无法解析但能确认存在
      const ra = await U.httpGet(`${base}/packages.adb`, { timeout: 30000 });
      if (ra.ok || ra.status === 206) {
        out.ok = true; out.manager = 'apk'; out.count = -1;
        out.checked.push(`packages.adb → 存在(${ra.status})，二进制索引无法在线清点`);
        return json(res, 200, out);
      }
      out.checked.push(`packages.adb → HTTP ${ra.status}`);
      out.error = '三种索引都没取到：确认这是「软件源根」而不是仓库主页（应直接包含 packages.adb 或 Packages.gz）';
      return json(res, 200, out);
    }

    // ---------------- 生成 ----------------
    if (req.method === 'POST' && u.pathname === '/api/validate') {
      const spec = JSON.parse((await readBody(req)) || '{}');
      const warnings = [];
      const errors = [];
      const tot = { packages: (spec.packages || []).length, excludes: (spec.excludes || []).length };

      const ib = spec.target && spec.subtarget
        ? await IB.resolveIbUrl(spec.distro, spec.version, spec.target, spec.subtarget)
        : { ok: false };
      const idx = spec.archPackages ? await U.getPackageIndex(spec.distro, spec.version, spec.archPackages).catch(() => null) : null;

      if (!ib.ok) {
        errors.push(`该版本没有对应的 ImageBuilder（${spec.distro} ${spec.version} ${spec.target}/${spec.subtarget}），ImageBuilder 引擎不可用；请改用源码全编译。`);
      }
      if (spec.engine === 'ib' && !ib.ok) errors.push('当前选择的是 ImageBuilder 引擎，但 IB 不可用。');

      if (idx) {
        const miss = (spec.packages || []).filter((p) => !idx.names.has(p));
        if (miss.length) {
          warnings.push(`以下 ${miss.length} 个包不在 ${spec.distro} ${spec.version} 的官方软件源里：${miss.slice(0, 12).join(' ')}${miss.length > 12 ? ' …' : ''}。若已把它们加进「第三方软件源」则可正常打包，否则 ImageBuilder 会报 package not found。`);
        }
        if (!idx.names.has('luci-i18n-base-zh-cn') && (spec.packages || []).includes('luci-i18n-base-zh-cn')) {
          warnings.push('该版本的汉化包拆分方式不同（新版常按应用拆成 luci-i18n-<app>-zh-cn），建议按插件清单里实际列出来的名字勾选。');
        }
      } else {
        warnings.push('未能读取该版本的软件索引，包名可用性未校验。');
      }

      const size = spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB : 1024;
      const pkgSize = spec.packagesSizeMB || 0;
      if (pkgSize > size * 0.75) {
        warnings.push(`所选插件预计占用 ${pkgSize} MB，接近 ${size} MB 的根分区上限；固件可能超出闪存容量。建议调大「根分区大小」或精简插件。`);
      }
      if (spec.distro === 'immortalwrt' && seriesOf(spec.version) === '18.06') {
        warnings.push('ImmortalWrt 18.06 已停止维护，不建议用于新部署。');
      }
      if (spec.system && spec.system.password && String(spec.system.password).length < 6) {
        warnings.push('root 密码少于 6 位；OpenWrt 不设的弱密码会被某些 dropbear 策略拒绝。');
      }
      if (looksRelease(spec.version) === false) {
        warnings.push(`「${spec.version}」不是正式发布版本号，不建议用于生产。`);
      }
      const nw = spec.network || {};
      if (nw.wanProto === 'pppoe') {
        // 前端字段名是 pppoeUser / pppoePass，历史预设里出现过 pppoePassword，两者都认
        const user = nw.pppoeUser || nw.pppoeUsername || '';
        const pass = nw.pppoePass || nw.pppoePassword || '';
        if (!user || !pass) errors.push('选择了 PPPoE 拨号，但未填写宽带账号或密码。');
      }
      if (nw.mode === 'bypass' && !nw.bypassGateway) {
        errors.push('选择了旁路由模式，但未填写上级主路由网关 IP。');
      }
      return json(res, 200, { ok: errors.length === 0, errors, warnings, totals: tot, ib: { ok: ib.ok, url: ib.url, ext: ib.ext } });
    }

    if (req.method === 'POST' && u.pathname === '/api/preview') {
      const spec = JSON.parse((await readBody(req)) || '{}');
      const ib = spec.target && spec.subtarget
        ? await IB.resolveIbUrl(spec.distro, spec.version, spec.target, spec.subtarget)
        : { ok: false, url: null, ext: null };
      if (spec.engine === 'src') {
        const files = await generateSRC(spec);
        return json(res, 200, { engine: 'src', files, estimate: estimateSRC(spec), ib });
      }
      const files = generateIB(spec, ib);
      return json(res, 200, { engine: 'ib', files, estimate: estimateIB(spec), ib });
    }

    if (req.method === 'POST' && u.pathname === '/api/zip') {
      const spec = JSON.parse((await readBody(req)) || '{}');
      const ib = spec.target && spec.subtarget
        ? await IB.resolveIbUrl(spec.distro, spec.version, spec.target, spec.subtarget)
        : { ok: false, url: null, ext: null };
      const files = spec.engine === 'src' ? await generateSRC(spec) : generateIB(spec, ib);
      const zip = createZip(files.map((f) => ({ name: f.path, content: f.content })));
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.length,
        'Content-Disposition': `attachment; filename="openwrt-${spec.distro}-${spec.version}-${spec.target}-${spec.subtarget}.zip"`,
      });
      return res.end(zip);
    }

    // ---------------- 在线构建（GitHub Actions 闭环）----------------
    if (req.method === 'GET' && u.pathname === '/api/build/config') {
      const c = B.readConfig();
      return json(res, 200, {
        hasToken: !!c.token, source: c.source, repo: c.repo, repoExample: 'owner/repo',
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/build/config') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const saved = B.saveConfig({ token: body.token, repo: body.repo });
      const c = B.readConfig();
      let login = null;
      try {
        const { Gh } = require('./lib/gh');
        login = await new Gh(c.token, c.repo).whoami();
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      return json(res, 200, { ok: true, login, repo: saved.repo });
    }

    if (req.method === 'POST' && u.pathname === '/api/build/start') {
      const spec = JSON.parse((await readBody(req)) || '{}');
      const ib = spec.target && spec.subtarget
        ? await IB.resolveIbUrl(spec.distro, spec.version, spec.target, spec.subtarget)
        : { ok: false, url: null, ext: null };
      const files = spec.engine === 'src' ? await generateSRC(spec) : generateIB(spec, ib);
      const meta = await B.startBuild(spec, files);
      return json(res, 200, meta);
    }

    if (req.method === 'GET' && u.pathname === '/api/build/status') {
      const meta = await B.getBuild(q('id'));
      if (!meta) return json(res, 404, { error: '未找到该构建任务' });
      return json(res, 200, meta);
    }

    if (req.method === 'GET' && u.pathname === '/api/build/list') {
      return json(res, 200, { builds: B.listBuilds() });
    }

    if (req.method === 'GET' && u.pathname === '/api/build/file') {
      const meta = B.readMeta(q('id'));
      if (!meta) return json(res, 404, { error: '未找到该构建任务' });
      const name = String(q('name') || '');
      const hit = (meta.files || []).find((f) => f.file === name || f.name === name);
      if (!hit || hit.error) return json(res, 404, { error: '没有这个文件' });
      const file = path.join(B.dirOf(meta.id), hit.file);
      if (!file.startsWith(B.dirOf(meta.id)) || !fs.existsSync(file)) return json(res, 404, { error: '文件已不在本地' });
      // 上百 MB 的产物支持 Range：浏览器/下载工具断线后能续传，不用重头再下
      const total = fs.statSync(file).size;
      const base = {
        'Content-Type': 'application/zip',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(hit.name)}"`,
      };
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : total - 1;
        if (start >= total || end >= total) {
          res.writeHead(416, Object.assign({ 'Content-Range': `bytes */${total}` }, base));
          return res.end();
        }
        if (start > end) start = end;
        res.writeHead(206, Object.assign({
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        }, base));
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, Object.assign({ 'Content-Length': total }, base));
      return fs.createReadStream(file).pipe(res);
    }

    // ---------------- 预设 ----------------
    if (req.method === 'POST' && u.pathname === '/api/preset/save') {
      const { name, spec } = JSON.parse((await readBody(req)) || '{}');
      ensurePresetDir();
      const safe = String(name || 'preset').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
      fs.writeFileSync(path.join(PRESET_DIR, `${safe}.json`), JSON.stringify(spec, null, 2));
      return json(res, 200, { ok: true, name: safe });
    }
    if (req.method === 'GET' && u.pathname === '/api/preset/list') {
      ensurePresetDir();
      return json(res, 200, { presets: fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json')) });
    }
    if (req.method === 'GET' && u.pathname === '/api/preset/load') {
      const name = String(u.searchParams.get('name') || '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const file = path.join(PRESET_DIR, `${name}.json`);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }

    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenWrt 定制站已启动: http://${HOST}:${PORT}`);
  console.log(`数据源: downloads.openwrt.org / downloads.immortalwrt.org （首次抓取会写入 ./cache）`);
  console.log('Ctrl+C 停止');
});
