'use strict';
/**
 * distros.js — 发行版定义与「版本 → 源码 git 引用」映射
 *
 * 事实依据（2026-09-25 实时抓取核对）：
 *  - OpenWrt     : downloads.openwrt.org/releases/<ver>/targets/...  ；快照走 /snapshots/
 *  - ImmortalWrt : downloads.immortalwrt.org/releases/<ver>/targets/... ；快照版本直接在 releases/ 下（如 25.12-SNAPSHOT）
 *  - 两者均提供 <ver>/targets/<t>/<s>/profiles.json（19.07 起就有，已逐版本验证 200）
 *  - 两者软硬件包索引均提供 index.json（{"packages":{name:version}}），19.07/21.02/23.05/24.10/25.12 全部返回 200
 *  - 25.12 起包管理器由 opkg 切换为 apk（alpha-1 起），索引文件为 packages.adb
 */

const DISTROS = {
  immortalwrt: {
    id: 'immortalwrt',
    name: 'ImmortalWrt',
    label: 'ImmortalWrt（国内优化 / 默认带 ntfs、多固件驱动）',
    accent: '#c0392b',
    downloadBase: 'https://downloads.immortalwrt.org',
    gitBase: 'https://github.com/immortalwrt/immortalwrt.git',
    releasesApi: 'https://downloads.immortalwrt.org/releases/',
    snapshot: {
      // ImmortalWrt 没有独立的 /snapshots/ 根，快照以 <series>-SNAPSHOT 形式落在 releases/ 下
      mode: 'inReleases',
      suffix: '-SNAPSHOT',
    },
    // 版本系列 → 长期维护分支（用于「跟进分支」而非锁定 tag）
    branchOfSeries: {
      '25.12': 'master',
      '24.10': 'openwrt-24.10',
      '23.05': 'openwrt-23.05',
      '21.02': 'openwrt-21.02',
      '18.06': 'openwrt-18.06',
      '18.06-k5.4': 'openwrt-18.06-k5.4',
    },
    defaultVersion: '25.12.2',
    notes: [
      '默认集成 default-settings-chn、autocore、automount 等国内常用组件',
      'x86/64 默认已带大量 kmod-* 网卡驱动（igb/igc/ixgbe/i40e/r8125/r8168 等），软路由开箱即用',
      '25.12 起同样使用 apk 包管理器',
    ],
  },
  openwrt: {
    id: 'openwrt',
    name: 'OpenWrt 官方',
    label: 'OpenWrt 官方（上游原生 / 无第三方内容）',
    accent: '#3b82f6',
    downloadBase: 'https://downloads.openwrt.org',
    gitBase: 'https://github.com/openwrt/openwrt.git',
    releasesApi: 'https://downloads.openwrt.org/releases/',
    snapshot: {
      mode: 'separate',
      path: 'https://downloads.openwrt.org/snapshots/',
    },
    branchOfSeries: {
      '25.12': 'main',
      '24.10': 'openwrt-24.10',
      '23.05': 'openwrt-23.05',
      '21.02': 'openwrt-21.02',
      '19.07': 'openwrt-19.07',
      '18.06': 'openwrt-18.06',
      '17.01': 'lede-17.01',
    },
    defaultVersion: '25.12.5',
    notes: [
      '纯净上游：所有 luci-app-* 之外的第三方插件都必须自行挂 feed',
      '19.07 及更早版本默认软件包数量少、无 apk，全新 Environment 更省磁盘',
      '25.12 起 opkg 已移除，改由 apk 管理',
    ],
  },
};

function compareVersion(a, b) {
  const pa = String(a).split(/[.-]/);
  const pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? '' : pa[i];
    const y = pb[i] === undefined ? '' : pb[i];
    const nx = /^\d+$/.test(x) ? Number(x) : x;
    const ny = /^\d+$/.test(y) ? Number(y) : y;
    if (nx === ny) continue;
    if (typeof nx === 'number' && typeof ny === 'number') return ny - nx;
    return String(nx) < String(ny) ? 1 : -1;
  }
  return 0;
}

/** 版本系列，如 25.12.5 -> 25.12，18.06-k5.4-SNAPSHOT -> 18.06-k5.4 */
function seriesOf(version) {
  const s = String(version);
  const m = s.match(/^(\d+\.\d+)(?:-k(\d+\.\d+))?/);
  if (!m) return s;
  return m[2] ? `${m[1]}-k${m[2]}` : m[1];
}

/** 是否 RC / 快照 */
function classify(version) {
  if (/-rc\d+/i.test(version)) return 'rc';
  if (/-SNAPSHOT$/i.test(version) || version === 'SNAPSHOT') return 'snapshot';
  return 'release';
}

/**
 * 解析该版本的下载根路径（含结尾斜杠）
 */
function releaseRoot(distro, version) {
  const d = DISTROS[distro];
  if (!d) throw new Error(`未知发行版: ${distro}`);
  if (version === 'SNAPSHOT' || version === 'snapshot') {
    if (d.snapshot.mode === 'separate') return d.snapshot.path;
    // ImmortalWrt 理论不会走这里，但兜底到 master 快照
    return `${d.downloadBase}/snapshots/`;
  }
  return `${d.downloadBase}/releases/${version}/`;
}

/**
 * 源码 git 引用策略
 * @returns {{ref:string, refType:'tag'|'branch', refName:string, note:string}}
 */
function gitRefInfo(distro, version, policy) {
  const d = DISTROS[distro];
  const kind = classify(version);
  const series = seriesOf(version);
  const branch = d.branchOfSeries[series];

  if (kind !== 'release') {
    // 快照 / RC：快照必须跟分支；RC 也建议跟分支（tag 可能与下载的预编译不一致）
    return {
      ref: branch || 'master',
      refType: 'branch',
      refName: branch || 'master',
      note: `${series} 系列的滚动更新分支，包含该系列的持续安全修复`,
    };
  }
  const tag = `v${version}`;
  const useTag = policy !== 'branch';
  if (useTag) {
    return {
      ref: tag,
      refType: 'tag',
      refName: tag,
      note: `锁定 ${tag}，产物可完整复现（推荐用于交付/归档）`,
    }
  }
  if (!branch) {
    return {
      ref: tag,
      refType: 'tag',
      refName: tag,
      note: `该系列没有对应的维护分支，只能锁定 ${tag}`,
    };
  }
  return {
    ref: branch,
    refType: 'branch',
    refName: branch,
    note: `跟踪 ${branch} 分支，含 ${version} 之后的续发安全补丁；注意：换分支前必须 make distclean`,
  };
}

/** 目标 tuple 转成 .config 里的设备符号（已与 config.buildinfo 逐字段核对） */
function deviceSymbol(target, subtarget, profileId) {
  return `CONFIG_TARGET_${target}_${subtarget}_DEVICE_${profileId}`;
}
function targetSymbols(target, subtarget) {
  return [`CONFIG_TARGET_${target}=y`, `CONFIG_TARGET_${target}_${subtarget}=y`];
}

module.exports = {
  DISTROS,
  DISTRO_IDS: Object.keys(DISTROS),
  compareVersion,
  seriesOf,
  classify,
  releaseRoot,
  gitRefInfo,
  deviceSymbol,
  targetSymbols,
};
