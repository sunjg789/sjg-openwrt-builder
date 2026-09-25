'use strict';
/**
 * imagebuilder.js — ImageBuilder 支持层
 *
 * 为什么必须有这一层（参考实现 my-immortalwrt 的做法）：
 *   ImageBuilder 是上游为「每个版本的每个子目标」预编译好的打包工具，
 *   内含该版本的全部 .ipk/.apk 与内核/modules，不需要重新编译任何东西。
 *   => 任意设备 × 任意版本，都能在 3~10 分钟内出固件；而源码全编译要 1~3 小时、占用约 50GB 磁盘。
 *
 * 已实测（2026-09-25）：
 *   https://downloads.openwrt.org/releases/25.12.5/targets/x86/64/openwrt-imagebuilder-25.12.5-x86-64.Linux-x86_64.tar.zst      → 206
 *   https://downloads.immortalwrt.org/releases/25.12.2/targets/x86/64/immortalwrt-imagebuilder-25.12.2-x86-64.Linux-x86_64.tar.zst → 206
 *   https://downloads.immortalwrt.org/releases/24.10.4/targets/ath79/generic/openwrt-imagebuilder-24.10.4-ath79-generic...tar.xz  → 404（该版本已换 .zst）
 */
const fs = require('fs');
const path = require('path');
const { releaseRoot, classify } = require('./distros');
const { httpGet } = require('./upstream');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const EXT = ['tar.zst', 'tar.xz', 'tar.gz'];

function cacheFile(distro, version, target, subtarget) {
  const v = String(version).replace(/[^\w.-]/g, '_');
  const key = `${target}_${subtarget}`.replace(/[^\w.-]/g, '_');
  return path.join(CACHE_DIR, distro, v, `ib-${key}.json`);
}

/**
 * 生成该 (distro, version, target, subtarget) 的 ImageBuilder 候选 URL
 * release : <prefix>-imagebuilder-<ver>-<target>-<subtarget>.Linux-x86_64.<ext>
 * snapshot: <prefix>-imagebuilder-<target>-<subtarget>.Linux-x86_64.<ext>
 */
function candidateUrls(distro, version, target, subtarget) {
  const root = releaseRoot(distro, version);
  const prefix = distro === 'immortalwrt' ? 'immortalwrt' : 'openwrt';
  const ts = `${target}-${subtarget}`;
  const kind = classify(version);
  const base = kind === 'release'
    ? `${prefix}-imagebuilder-${version}-${ts}`
    : `${prefix}-imagebuilder-${ts}`;
  const dir = `${root}targets/${encodeURIComponent(target)}/${encodeURIComponent(subtarget)}/`;
  return EXT.map((e) => ({ url: `${dir}${base}.Linux-x86_64.${e}`, ext: e, base }));
}

/**
 * 探测真正存在的那个压缩包（HEAD 不够稳，用 Range GET 取前若干字节）
 * @returns {Promise<{ok:boolean,url:string|null,ext:string|null,tried:string[],ttl:number}>}
 */
async function resolveIbUrl(distro, version, target, subtarget, force = false) {
  const file = cacheFile(distro, version, target, subtarget);
  if (!force && fs.existsSync(file)) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { /* 缓存坏就重来 */ }
  }
  const tried = [];
  let okRes = null;
  for (const c of candidateUrls(distro, version, target, subtarget)) {
    // 用 Range 只取首字节：IB 压缩包动辄几百 MB，整包 GET 必然打到超时
    const r = await httpGet(c.url, { timeout: 25000, range: '0-0' });
    tried.push(`${c.ext}:${r.status}`);
    if (r.ok || r.status === 206) { okRes = c; break; }
  }
  const out = {
    ok: !!okRes,
    url: okRes ? okRes.url : null,
    ext: okRes ? okRes.ext : null,
    filename: okRes ? `${okRes.base}.Linux-x86_64.${okRes.ext}` : null,
    tried,
    checkedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
  } catch (e) { /* 忽略 */ }
  return out;
}

/** supervisor: 判断 tar 该用什么参数解压 */
function untarCmd(ext) {
  if (ext === 'tar.zst') return 'tar --zstd -xf';
  if (ext === 'tar.xz') return 'tar -xJf';
  return 'tar -xzf';
}

/** ImageBuilder 需要 zstd 支持；给出 Debian/Ubuntu/RHEL 三系安装提示 */
const ZSTD_HINT = {
  apt: 'sudo apt-get update && sudo apt-get install -y zstd xz-utils build-essential libncurses-dev zlib1g-dev gawk git gettext libssl-dev python3 python3-distutils rsync unzip',
  dnf: 'sudo dnf install -y zstd xz tar git-core perl-interpreter perl-FindBin perl-File-Copy gawk make gcc gcc-c++ ncurses-devel zlib-devel',
  apk: 'apk add zstd xz tar coreutils git gawk make gcc libc-dev linux-headers ncurses-dev zlib-dev openssl-dev python3 rsync',
};

module.exports = { candidateUrls, resolveIbUrl, untarCmd, ZSTD_HINT, EXT };
