'use strict';
/**
 * upstream.js — 上游实时元数据抓取层（零依赖，带磁盘缓存）
 *
 * 已验证可用的端点（2026-09-25 实抓）：
 *   https://downloads.openwrt.org/releases/                            → 版本目录列表（HTML）
 *   https://downloads.immortalwrt.org/releases/                        → 版本目录列表（HTML）
 *   <root>targets/                                                     → target 列表
 *   <root>targets/<t>/                                                 → subtarget 列表
 *   <root>targets/<t>/<s>/profiles.json                                → ["arch_packages"|"default_packages"|"linux_kernel"|"profiles"]
 *   <root>packages/<arch>/<feed>/index.json                            → {"version":2,"architecture":...,"packages":{name:ver}}
 *   <root>packages/<arch>/<feed>/Packages.gz                           → opkg 系旧格式的兜底
 *   <root>targets/<t>/<s>/feeds.buildinfo                              → 官方 feed 及其锁定 commit
 *
 * 所有结果缓存在 ./cache 下，默认 12 小时过期；加 ?force 或用 REFRESH_FILE 强制刷新。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DISTROS, releaseRoot, classify, seriesOf } = require('./distros');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const DEFAULT_TTL = 12 * 60 * 60 * 1000; // 12h

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function cacheKey(distro, version, kind, extra) {
  const v = String(version).replace(/[^\w.-]/g, '_');
  const parts = [distro, v, `${kind}${extra ? '-' + String(extra).replace(/[^\w.-]/g, '_') : ''}.json`];
  return path.join(CACHE_DIR, ...parts);
}

function readCache(file, ttl) {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) {
    /* 缓存写失败不影响主流程 */
  }
}

async function httpGet(url, { timeout = 25000, accept = '*/*', range = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { 'User-Agent': 'openwrt-custom-builder/2.0', Accept: accept };
  if (range) headers.Range = `bytes=${range}`;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers,
    });
    if (!res.ok && res.status !== 206) return { ok: false, status: res.status, body: null };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, body: buf };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

async function httpHeadOk(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    // 部分 CDN 不支持 HEAD 且不返回 content-length，这里用 Range GET 更稳
    const res = await fetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'openwrt-custom-builder/2.0' },
    });
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 Nginx autoindex 页面里的子目录名。
 *
 * 关键细节：这类页面的**面包屑导航是绝对路径**（/releases/25.12.2/targets/x86/），
 * 而**真实子目录是相对路径**（64/、generic/）。早期版本两着都收，导致再把
 * `releases` / `targets` / 版本号 / 自身目录名 当成子目标列出来。
 * 这里以「只收相对路径」为准；万一整页全是绝对链接（换服务器软件时可能碰到），
 * 退回用绝对路径解析并剔除已知噪声目录。
 */
function parseDirs(html) {
  const rel = [];
  const abs = [];
  const re = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1] || '';
    if (!href.endsWith('/')) continue;
    let name = href.replace(/\/+$/, '');
    if (!name) continue;
    if (/^https?:/i.test(name)) continue;
    if (name.includes('/')) name = name.split('/').filter(Boolean).pop() || '';
    if (!name || name === '.' || name === '..') continue;
    const isAbs = href.startsWith('/') || href.startsWith('../');
    const bucket = isAbs ? abs : rel;
    if (!bucket.includes(name)) bucket.push(name);
    void m[2];
  }
  const clean = (a) => a.filter((n) => !NOISE_DIRS.has(n));
  const relClean = clean(rel);
  return relClean.length ? relClean : clean(abs);
}

// ---------------------------------------------------------------- 版本列表

const VERSION_RE = /^(\d+)\.(\d+)(?:[.-].*)?$/i;

async function listVersions(distro, force = false) {
  const d = DISTROS[distro];
  if (!d) throw new Error(`未知发行版: ${distro}`);
  const file = cacheKey(distro, '_index', 'versions');
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }

  const versions = [];
  const r = await httpGet(d.releasesApi, { timeout: 30000 });
  if (r.ok) {
    const html = r.body.toString('utf8');
    for (const name of parseDirs(html)) {
      if (!VERSION_RE.test(name)) continue;
      if (/^(faillogs|packages|snapshots|profiles|targets|video)/i.test(name)) continue;
      versions.push({
        version: name,
        series: seriesOf(name),
        kind: classify(name),
      });
    }
  }

  versions.sort((a, b) => require('./distros').compareVersion(a.version, b.version));

  const payload = {
    distro,
    updatedAt: Date.now(),
    stale: !r.ok,
    error: r.ok ? null : `拉取失败(http=${r.status})`,
    versions,
  };
  // 只有成功且非空时才回写缓存，避免把空结果固化住
  if (r.ok && versions.length) writeCache(file, payload);
  return payload;
}

// ---------------------------------------------------------------- target / subtarget

/** Nginx autoindex 页面顶部的面包屑/导航链接，不能被当成真实目录 */
const NOISE_DIRS = new Set([
  'releases', 'targets', 'packages', 'snapshots', 'faillogs', 'sources', 'kmods',
  'profiles', 'video', 'ci', 'translations', 'docs', 'logs',
]);

async function listTargets(distro, version, force = false) {
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'targets');
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }
  const r = await httpGet(`${root}targets/`, { timeout: 30000 });
  const targets = r.ok ? parseDirs(r.body.toString('utf8')).filter((t) => !NOISE_DIRS.has(t)).sort() : [];
  const payload = { distro, version, targets, ok: r.ok, http: r.status, updatedAt: Date.now() };
  if (r.ok && targets.length) writeCache(file, payload);
  return payload;
}

async function listSubtargets(distro, version, target, force = false) {
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'subtargets', target);
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }
  const t = encodeURIComponent(target);
  const r = await httpGet(`${root}targets/${t}/`, { timeout: 30000 });
  let subs = [];
  if (r.ok) {
    const all = parseDirs(r.body.toString('utf8'));
    subs = all
      .filter((s) => !NOISE_DIRS.has(s))
      .filter((s) => !/^(target\.mk|Makefile|config-|profiles\.json|sha256sums|packages|kmods|snapshots|\.config|Config|\.git)/i.test(s))
      .filter((s) => !s.includes('.'))
      .sort();
  }
  const payload = { distro, version, target, subtargets: subs, ok: r.ok, http: r.status, updatedAt: Date.now() };
  if (r.ok && subs.length) writeCache(file, payload);
  return payload;
}

// ---------------------------------------------------------------- profiles.json

async function getProfiles(distro, version, target, subtarget, force = false) {
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'profiles', `${target}_${subtarget}`);
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }
  const url = `${root}targets/${encodeURIComponent(target)}/${encodeURIComponent(subtarget)}/profiles.json`;
  const r = await httpGet(url, { timeout: 35000, accept: 'application/json' });
  let data = null;
  if (r.ok) {
    try {
      data = JSON.parse(r.body.toString('utf8'));
    } catch (e) {
      data = null;
    }
  }
  if (!data) {
    // status 为 0 表示请求根本没发出去（断网 / 超时 / 被限流），与 404 要区分开说
    const offline = !r.ok && !r.status;
    return {
      distro, version, target, subtarget,
      ok: false, http: r.status, arch_packages: null,
      default_packages: [], linux_kernel: null, profiles: [],
      note: offline
        ? '上游下载服务器不可达（断网或超时）；已缓存的版本不受影响，换个已缓存的版本仍可继续。'
        : '该版本/子目标不提供 profiles.json（多为 19.07 之前的格式），请手工填写 target profile。',
    };
  }

  // 归一化：把 profiles map 摊平为数组，并补一个可读名称
  const profiles = [];
  const rawProfiles = data.profiles || {};
  for (const id of Object.keys(rawProfiles)) {
    const p = rawProfiles[id] || {};
    profiles.push({
      id,
      name: guessDeviceName(id),
      device_packages: p.device_packages || [],
      supported_devices: p.supported_devices || p.supported_device || [],
      images: Array.isArray(p.images) ? p.images.map((i) => ({ type: i.type, filesystem: i.filesystem, name: i.name })) : [],
      image_prefix: p.image_prefix || null,
    });
  }
  profiles.sort((a, b) => a.id.localeCompare(b.id));

  const payload = {
    distro, version, target, subtarget,
    ok: true,
    http: 200,
    arch_packages: data.arch_packages || null,
    default_packages: data.default_packages || [],
    linux_kernel: data.linux_kernel || null,
    profiles,
    updatedAt: Date.now(),
  };
  writeCache(file, payload);
  return payload;
}

/** profiles 里只有 id（如 `xiaomi_mi-router-4a-gigabit`），生成人可读名称 */
function guessDeviceName(id) {
  return id
    .replace(/_/g, ' ')
    .replace(/-v\d+$/i, (s) => s.toUpperCase())
    .replace(/\b(\w)/g, (c) => c.toUpperCase())
    .trim();
}

// ---------------------------------------------------------------- 软件包索引

const FEEDS_TRY = ['base', 'packages', 'luci', 'routing', 'telephony', 'video', 'targets'];

async function detectPackageManager(distro, version, arch, force = false) {
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'pkgmgr', arch);
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }
  const adbOk = await httpHeadOk(`${root}packages/${encodeURIComponent(arch)}/packages/packages.adb`);
  const payload = { manager: adbOk ? 'apk' : 'opkg', updatedAt: Date.now() };
  writeCache(file, payload);
  return payload;
}

async function getPackageIndex(distro, version, arch, opts = {}) {
  const { force = false, feeds = FEEDS_TRY } = opts;
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'packages', arch);

  if (!force) {
    const hit = readCache(file, DEFAULT_TTL * 4); // 包索引相对稳定，缓存 48h
    if (hit) {
      return { ...hit, names: new Set(Object.keys(hit.map)), cached: true };
    }
  }

  const manager = (await detectPackageManager(distro, version, arch, force)).manager;
  const map = Object.create(null);
  const foundFeeds = [];

  // 并发拉取各 feed 的索引，任一失败不影响其它
  await Promise.all(
    feeds.map(async (feed) => {
      const base = `${root}packages/${encodeURIComponent(arch)}/${feed}/`;
      // 首选 index.json（apk 系 + opkg 系都提供，纯 JSON，体积 ~160KB）
      const rj = await httpGet(`${base}index.json`, { timeout: 40000, accept: 'application/json' });
      if (rj.ok) {
        try {
          const j = JSON.parse(rj.body.toString('utf8'));
          const pkgs = j.packages || {};
          for (const n of Object.keys(pkgs)) map[n] = { version: pkgs[n], feed };
          foundFeeds.push(feed);
          return;
        } catch (e) { /* 落到 Packages.gz */ }
      }
      // 兜底：opkg 的 Packages.gz
      const rg = await httpGet(`${base}Packages.gz`, { timeout: 40000 });
      if (rg.ok) {
        try {
          const txt = zlib.gunzipSync(rg.body).toString('utf8');
          const re = /^Package:\s*(.+)$/gm;
          let m;
          let n = 0;
          while ((m = re.exec(txt))) { map[m[1].trim()] = { version: '', feed }; n++; }
          if (n) foundFeeds.push(feed);
        } catch (e) { /* 忽略 */ }
      }
    })
  );

  const payload = {
    distro, version, arch, manager, map, feeds: foundFeeds,
    count: Object.keys(map).length, updatedAt: Date.now(),
  };
  if (Object.keys(map).length) writeCache(file, payload);
  return { ...payload, names: new Set(Object.keys(map)), cached: false };
}

// ---------------------------------------------------------------- feeds.buildinfo

async function getFeedsBuildinfo(distro, version, target, subtarget, force = false) {
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'feeds', target && subtarget ? `${target}_${subtarget}` : 'root');
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }
  const candidates = [];
  if (target && subtarget) {
    candidates.push(`${root}targets/${encodeURIComponent(target)}/${encodeURIComponent(subtarget)}/feeds.buildinfo`);
  }
  candidates.push(`${root}feeds.buildinfo`);
  candidates.push(`${root}targets/feeds.buildinfo`);

  let raw = null;
  let used = null;
  for (const url of candidates) {
    const r = await httpGet(url, { timeout: 25000 });
    if (r.ok && r.body && r.body.length > 10) { raw = r.body.toString('utf8'); used = url; break; }
  }
  const feeds = [];
  if (raw) {
    for (const line of raw.split('\n')) {
      // 形如：src-git packages https://git.openwrt.org/feed/packages.git^commitish
      const m = line.match(/^src-(git|git-full|bzr|svn|link|hg)\s+(\S+)\s+(\S+?)(?:\^(.+?))?\s*$/);
      if (m) feeds.push({ method: m[1], name: m[2], url: m[3], commit: m[4] || null });
    }
  }
  const payload = { distro, version, ok: !!raw, url: used, feeds, updatedAt: Date.now() };
  if (raw && feeds.length) writeCache(file, payload);
  return payload;
}

// ---------------------------------------------------------------- 版本元信息

async function getVersionInfo(distro, version, force = false) {
  const root = releaseRoot(distro, version);
  const file = cacheKey(distro, version, 'info');
  if (!force) {
    const hit = readCache(file, DEFAULT_TTL);
    if (hit) return hit;
  }
  // .buildinfo / config.buildinfo 里的 Build-Version 之类
  const out = { revision: null, kernel: null, version };
  let r = await httpGet(`${root}.manifest`, { timeout: 20000 });
  if (!r.ok) r = await httpGet(`${root}version.buildinfo`, { timeout: 20000 });
  if (r.ok && r.body.length < 4096) out.revision = r.body.toString('utf8').trim();
  if (out.revision) writeCache(file, out);
  return out;
}

module.exports = {
  listVersions,
  listTargets,
  listSubtargets,
  getProfiles,
  getPackageIndex,
  getFeedsBuildinfo,
  getVersionInfo,
  detectPackageManager,
  httpGet,
  cacheKey,
  CACHE_DIR,
};
