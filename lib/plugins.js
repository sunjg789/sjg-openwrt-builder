'use strict';
/**
 * plugins.js — 版本驱动的插件注册表
 *
 * 三类来源：
 *   A. 第三方源码插件（THIRD_PARTY）——来自用户仓库 sunjg789/sjg-openwrt-packages 的 plugins.conf，
 *      每一项都带真实上游 git 地址与编译目标目录；这些只能「源码编译」进固件，official 源里没有。
 *   B. 官方源精选插件（OFFICIAL_EXTRA）——走版本软件源即可，既可在编译时预装进固件，
 *      也可事后 apk/opkg 安装。
 *   C. 版本运行时发现的 luci-app-* / luci-theme-*（resolve 时按所选版本的 packages 索引动态生成）
 *
 * 「插件随版本变换」的实现方式：
 *   resolve() 接收该版本的包索引 sign ή set，逐项校对包名是否存在 =>
 *   state: 'ok' | 'partial' | 'repo' | 'third' | 'missing'
 */
const { getPackageIndex } = require('./upstream');

// ============================================================================
// A. 第三方源码插件（严格对齐 plugins.conf 的 46 条记录）
//    dirs:      需要落地的源码目录（SMALLPKG 条目为逗号分隔的多目录）
//    upstream:  git 仓库地址，SMALLPKG 表示从 kenzok8/small-package 稀疏拉取
//    compile:   make package/<compile>/compile 的目标；'-' 表示只克隆不单独编译
//    pkgs:      最终会产生的包名（用于写进 .config）
// ============================================================================
const SMALLPKG_SRC = 'https://github.com/kenzok8/small-package.git';

const THIRD_PARTY = [
  // ---------- 代理 / 出海 ----------
  {
    id: 'openclash', label: 'OpenClash', cat: 'proxy',
    dirs: ['OpenClash'], upstream: 'https://github.com/vernesong/OpenClash.git', compile: 'OpenClash',
    pkgs: ['luci-app-openclash'], sizeMB: 90, buildSec: 40,
    desc: 'Clash 客户端 LuCI 界面（内核 clash 需联网下载或用 core 包）',
    warn: '首次启动时需联网下载 Clash 内核；离线环境请预先准备 core',
  },
  {
    id: 'passwall', label: 'PassWall', cat: 'proxy',
    dirs: ['passwall', 'passwall-packages'],
    upstream: 'https://github.com/xiaorouji/openwrt-passwall.git', compile: 'passwall',
    extraRepos: [{ dirs: ['passwall-packages'], upstream: 'https://github.com/xiaorouji/openwrt-passwall-packages.git', compile: '-' }],
    pkgs: ['luci-app-passwall'], sizeMB: 260, buildSec: 900,
    desc: '科学上网主力插件（依赖 chinadns-ng / xray / sing-box 等 core）',
    warn: '依赖 passwall-packages，必须一并克隆；core 编译耗时较长',
  },
  {
    id: 'passwall2', label: 'PassWall2', cat: 'proxy',
    dirs: ['passwall2', 'passwall-packages'],
    upstream: 'https://github.com/xiaorouji/openwrt-passwall2.git', compile: 'passwall2',
    extraRepos: [{ dirs: ['passwall-packages'], upstream: 'https://github.com/xiaorouji/openwrt-passwall-packages.git', compile: '-' }],
    pkgs: ['luci-app-passwall2'], sizeMB: 260, buildSec: 900,
    desc: 'PassWall 新一代版本',
    warn: '与 PassWall 1 不建议同时启用',
  },
  {
    id: 'homeproxy', label: 'HomeProxy', cat: 'proxy',
    dirs: ['luci-app-homeproxy', 'homeproxy'], upstream: SMALLPKG_SRC, compile: 'luci-app-homeproxy', smallpkg: true,
    pkgs: ['luci-app-homeproxy', 'homeproxy'], sizeMB: 130, buildSec: 700,
    desc: '基于 sing-box 的代理前端（ImmortalWrt 官方常用）',
  },
  {
    id: 'nikki', label: 'Nikki', cat: 'proxy',
    dirs: ['luci-app-nikki', 'sing-box'], upstream: SMALLPKG_SRC, compile: 'luci-app-nikki', smallpkg: true,
    pkgs: ['luci-app-nikki', 'sing-box'], sizeMB: 140, buildSec: 900,
    desc: 'sing-box 内核代理客户端',
  },
  {
    id: 'fchomo', label: 'Fchomo (mihomo)', cat: 'proxy',
    dirs: ['luci-app-fchomo', 'mihomo'], upstream: SMALLPKG_SRC, compile: 'luci-app-fchomo', smallpkg: true,
    pkgs: ['luci-app-fchomo', 'mihomo'], sizeMB: 120, buildSec: 800,
    desc: 'mihomo / Clash Meta 前端',
  },
  {
    id: 'v2raya', label: 'v2rayA', cat: 'proxy',
    dirs: ['luci-app-v2raya', 'v2raya'], upstream: SMALLPKG_SRC, compile: 'luci-app-v2raya', smallpkg: true,
    pkgs: ['luci-app-v2raya', 'v2raya'], sizeMB: 110, buildSec: 600,
    desc: 'v2rayA 网页端代理管理',
  },

  // ---------- DNS / 广告过滤 ----------
  {
    id: 'adguardhome', label: 'AdGuardHome', cat: 'dns',
    dirs: ['adguardhome'], upstream: 'https://github.com/rufengsuixing/luci-app-adguardhome.git', compile: 'adguardhome',
    pkgs: ['luci-app-adguardhome'], sizeMB: 40, buildSec: 300,
    desc: 'AdGuardHome 的 LuCI 管理界面',
    warn: 'AdGuardHome 主程序由插件运行时下载；建议在出国手段就绪后再启用更新',
  },
  {
    id: 'mosdns', label: 'MosDNS', cat: 'dns',
    dirs: ['luci-app-mosdns', 'mosdns'], upstream: SMALLPKG_SRC, compile: 'luci-app-mosdns', smallpkg: true,
    pkgs: ['luci-app-mosdns', 'mosdns'], sizeMB: 40, buildSec: 500,
    desc: '本地 DNS 分流器（常与 AdGuardHome 配合做国内外分流）',
  },
  {
    id: 'smartdns', label: 'SmartDNS', cat: 'dns',
    dirs: ['luci-app-smartdns', 'smartdns'], upstream: SMALLPKG_SRC, compile: 'luci-app-smartdns', smallpkg: true,
    pkgs: ['luci-app-smartdns', 'smartdns'], sizeMB: 30, buildSec: 400,
    desc: '智能 DNS：多上游并发测速取最快结果',
  },
  {
    id: 'dnsproxy', label: 'dnsproxy', cat: 'dns',
    dirs: ['luci-app-dnsproxy', 'dnsproxy'], upstream: SMALLPKG_SRC, compile: 'luci-app-dnsproxy', smallpkg: true,
    pkgs: ['luci-app-dnsproxy', 'dnsproxy'], sizeMB: 35, buildSec: 450,
    desc: 'AdGuard 出品的轻量 DNS 代理（DoT/DoH/DoQ）',
  },

  // ---------- 存储 / 下载 ----------
  {
    id: 'diskman', label: 'DiskMan 磁盘管理', cat: 'storage',
    dirs: ['diskman'], upstream: 'https://github.com/lisaac/luci-app-diskman.git', compile: 'diskman',
    pkgs: ['luci-app-diskman'], sizeMB: 12, buildSec: 60,
    desc: '分区管理、格式化、挂载（依赖 block-mount / lsblk）',
    deps: ['block-mount'],
  },
  {
    id: 'dockerman', label: 'Dockerman + Docker', cat: 'storage',
    dirs: ['dockerman'], upstream: 'https://github.com/lisaac/luci-app-dockerman.git', compile: 'dockerman',
    pkgs: ['luci-app-dockerman', 'docker', 'dockerd', 'docker-compose'], sizeMB: 150, buildSec: 1258,
    desc: 'Docker 容器管理界面',
    warn: 'docker 全家含 Go toolchain 编译约 1258s，是全量单包里最重的之一；需要 x86/64 等大内存目标',
  },
  {
    id: 'alist', label: 'Alist 网盘挂载', cat: 'storage',
    dirs: ['luci-app-alist', 'alist'], upstream: SMALLPKG_SRC, compile: 'luci-app-alist', smallpkg: true,
    pkgs: ['luci-app-alist', 'alist'], sizeMB: 90, buildSec: 500,
    desc: '多网盘统一挂载列表',
  },
  {
    id: 'aria2', label: 'Aria2 下载', cat: 'storage',
    dirs: ['luci-app-aria2', 'aria2'], upstream: SMALLPKG_SRC, compile: 'luci-app-aria2', smallpkg: true,
    pkgs: ['luci-app-aria2', 'aria2'], sizeMB: 45, buildSec: 600,
    desc: 'Aria2 多线程下载 + AriaNG 前端',
  },
  {
    id: 'filebrowser', label: 'FileBrowser 文件管理', cat: 'storage',
    dirs: ['luci-app-filebrowser', 'filebrowser'], upstream: SMALLPKG_SRC, compile: 'luci-app-filebrowser', smallpkg: true,
    pkgs: ['luci-app-filebrowser', 'filebrowser'], sizeMB: 60, buildSec: 400,
    desc: 'Web 文件管理器',
  },
  {
    id: 'transmission', label: 'Transmission BT', cat: 'storage',
    dirs: ['luci-app-transmission', 'transmission'], upstream: SMALLPKG_SRC, compile: 'luci-app-transmission', smallpkg: true,
    pkgs: ['luci-app-transmission', 'transmission-web-control', 'transmission-web'], sizeMB: 55, buildSec: 700,
    desc: 'BT/PT 下载（含网页控制界面）',
  },

  // ---------- 网络工具 ----------
  {
    id: 'lucky', label: 'Lucky 大吉', cat: 'network',
    dirs: ['lucky'], upstream: 'https://github.com/gdy666/lucky.git', compile: 'lucky',
    pkgs: ['luci-app-lucky', 'lucky'], sizeMB: 60, buildSec: 350,
    desc: '端口转发 / 内网穿透 / STUN / Wake-on-LAN / 动态域名 多合一',
  },
  {
    id: 'gost', label: 'GOST 隧道', cat: 'network',
    dirs: ['luci-app-gost', 'gost'], upstream: SMALLPKG_SRC, compile: 'luci-app-gost', smallpkg: true,
    pkgs: ['luci-app-gost', 'gost'], sizeMB: 50, buildSec: 500,
    desc: 'GOST 加密隧道与端口转发',
  },
  {
    id: 'udp2raw', label: 'udp2raw', cat: 'network',
    dirs: ['luci-app-udp2raw', 'udp2raw'], upstream: SMALLPKG_SRC, compile: 'luci-app-udp2raw', smallpkg: true,
    pkgs: ['luci-app-udp2raw', 'udp2raw'], sizeMB: 20, buildSec: 300,
    desc: '把 UDP 伪装成 TCP/ICMP（配合 wireguard 常见）',
  },
  {
    id: 'socat', label: 'socat 端口转发', cat: 'network',
    dirs: ['luci-app-socat'], upstream: SMALLPKG_SRC, compile: 'luci-app-socat', smallpkg: true,
    pkgs: ['luci-app-socat'], sizeMB: 10, buildSec: 120,
    desc: 'socat 前端（socat 本体来自官方源）',
  },
  {
    id: 'natmap', label: 'NATMap 公网端口映射', cat: 'network',
    dirs: ['luci-app-natmap', 'openwrt-natmap'], upstream: SMALLPKG_SRC, compile: 'luci-app-natmap', smallpkg: true,
    pkgs: ['luci-app-natmap', 'natmap'], sizeMB: 10, buildSec: 200,
    desc: '全锥型 NAT 打洞，把内网服务映射到公网',
  },
  {
    id: 'npc', label: 'NPC 内网穿透', cat: 'network',
    dirs: ['luci-app-npc', 'npc'], upstream: SMALLPKG_SRC, compile: 'luci-app-npc', smallpkg: true,
    pkgs: ['luci-app-npc', 'npc'], sizeMB: 25, buildSec: 250,
    desc: 'NPS 客户端，用于穿透到公网服务器',
  },
  {
    id: 'ddnsgo', label: 'DDNS-GO', cat: 'network',
    dirs: ['luci-app-ddns-go', 'ddns-go'], upstream: SMALLPKG_SRC, compile: 'luci-app-ddns-go', smallpkg: true,
    pkgs: ['luci-app-ddns-go', 'ddns-go'], sizeMB: 35, buildSec: 300,
    desc: '动态域名解析（阿里云 / CF / DNSPod 等）',
  },
  {
    id: 'wolplus', label: 'WOL Plus 网络唤醒', cat: 'network',
    dirs: ['luci-app-wolplus'], upstream: SMALLPKG_SRC, compile: 'luci-app-wolplus', smallpkg: true,
    pkgs: ['luci-app-wolplus'], sizeMB: 5, buildSec: 60,
    desc: '网络唤醒增强版，可扫描与批量唤醒',
  },

  // ---------- 系统管理 ----------
  {
    id: 'partexp', label: 'Partexp 分区扩展', cat: 'system',
    dirs: ['luci-app-partexp'], upstream: SMALLPKG_SRC, compile: 'luci-app-partexp', smallpkg: true,
    pkgs: ['luci-app-partexp'], sizeMB: 5, buildSec: 60,
    desc: '一键把未用空间扩展到根分区',
    note: '用于把刷机后的 squashfs/ext4 剩余空间并入 /overlay',
  },
  {
    id: 'autoreboot', label: '定时重启', cat: 'system',
    dirs: ['luci-app-autoreboot'], upstream: SMALLPKG_SRC, compile: 'luci-app-autoreboot', smallpkg: true,
    pkgs: ['luci-app-autoreboot'], sizeMB: 3, buildSec: 40,
    desc: '按计划周定时重启路由器',
  },
  {
    id: 'poweroff', label: '定时关机', cat: 'system',
    dirs: ['luci-app-poweroff'], upstream: SMALLPKG_SRC, compile: 'luci-app-poweroff', smallpkg: true,
    pkgs: ['luci-app-poweroff'], sizeMB: 3, buildSec: 40,
    desc: '按计划周定时关机',
  },
  {
    id: 'advanced', label: '高级设置', cat: 'system',
    dirs: ['luci-app-advanced'], upstream: SMALLPKG_SRC, compile: 'luci-app-advanced', smallpkg: true,
    pkgs: ['luci-app-advanced'], sizeMB: 5, buildSec: 50,
    desc: '汇总常用但分散的高级配置项',
  },
  {
    id: 'netdata', label: 'NetData 实时监控', cat: 'system',
    dirs: ['luci-app-netdata', 'netdata'], upstream: SMALLPKG_SRC, compile: 'luci-app-netdata', smallpkg: true,
    pkgs: ['luci-app-netdata', 'netdata'], sizeMB: 110, buildSec: 900,
    desc: '资源占用较高的实时监控面板',
    warn: '内存 <512MB、或 32 位机型不要选',
  },
  {
    id: 'unblocknetease', label: '解锁网易云音乐', cat: 'system',
    dirs: ['unblockneteasemusic'], upstream: 'https://github.com/UnblockNeteaseMusic/luci-app-unblockneteasemusic.git', compile: 'unblockneteasemusic',
    pkgs: ['luci-app-unblockneteasemusic'], sizeMB: 15, buildSec: 200,
    desc: '网易云灰色歌曲解锁（需 node 环境体积约 900MB 中间产物）',
    warn: '依赖 node >= 16，中间产物体积大；磁盘紧张时建议改用 Image Builder 路径',
  },

  // ---------- 主题 ----------
  {
    id: 'argon', label: 'Argon 主题', cat: 'theme',
    dirs: ['argon'], upstream: 'https://github.com/jerrykuku/luci-theme-argon.git', compile: 'argon',
    pkgs: ['luci-theme-argon', 'luci-app-argon-config'], sizeMB: 8, buildSec: 60,
    desc: 'Argon 主题 + 主题配置器',
  },
  {
    id: 'theme-design', label: 'Design 主题', cat: 'theme',
    dirs: ['luci-theme-design'], upstream: SMALLPKG_SRC, compile: 'luci-theme-design', smallpkg: true,
    pkgs: ['luci-theme-design'], sizeMB: 5, buildSec: 40,
    desc: 'Design 流派主题',
  },
  {
    id: 'theme-edge', label: 'Edge 主题', cat: 'theme',
    dirs: ['luci-theme-edge'], upstream: SMALLPKG_SRC, compile: 'luci-theme-edge', smallpkg: true,
    pkgs: ['luci-theme-edge'], sizeMB: 5, buildSec: 40,
    desc: 'Edge 流派主题',
  },
];

// ============================================================================
// B. 官方源精选插件（不需要第三方 feed；dynamic 校验其在该版本是否存在）
// ============================================================================
const OFFICIAL_EXTRA = [
  { id: 'ttyd', pkgs: ['ttyd'], sizeMB: 4, cat: 'system', label: 'TTYD 网页终端', desc: '浏览器里的命令行终端', default: true },
  { id: 'taskscript', pkgs: ['luci-app-taskplan'], sizeMB: 2, cat: 'system', label: '计划任务', desc: '定时任务图形化管理（正确包名，不是 luci-app-taskd）', default: true },
  { id: 'commands', pkgs: ['luci-app-commands'], sizeMB: 2, cat: 'system', label: '自定义命令', desc: '在网页上预置并一键执行 shell 命令', default: true },
  { id: 'arpbind', pkgs: ['luci-app-arpbind'], sizeMB: 2, cat: 'network', label: 'ARP 绑定', desc: 'IP/MAC 静态绑定', default: true },
  { id: 'ramfree', pkgs: ['luci-app-ramfree'], sizeMB: 1, cat: 'system', label: '释放内存', desc: '一键回收 page cache', default: true },
  { id: 'vlmcsd', pkgs: ['luci-app-vlmcsd', 'vlmcsd'], sizeMB: 3, cat: 'network', label: 'vlmcsd KMS 服务', desc: '局域网 KMS 激活服务', default: false },
  { id: 'wireguard', pkgs: ['wireguard-tools', 'luci-app-wireguard', 'luci-proto-wireguard', 'kmod-wireguard'], sizeMB: 6, cat: 'vpn', label: 'WireGuard VPN', desc: '轻量高性能 VPN', default: false },
  { id: 'ipsec', pkgs: ['strongswan', 'luci-app-ipsec-vpns'], sizeMB: 30, cat: 'vpn', label: 'IPsec / strongSwan', desc: '传统企业级 VPN', default: false },
  { id: 'ddns-scripts', pkgs: ['ddns-scripts', 'luci-app-ddns'], sizeMB: 6, cat: 'network', label: '动态 DNS（原生）', desc: '官方 DDNS 脚本集', default: false },
  { id: 'upnp', pkgs: ['luci-app-upnp', 'miniupnpd'], sizeMB: 4, cat: 'network', label: 'UPnP', desc: '自动端口映射', default: false },
  { id: 'sqm', pkgs: ['luci-app-sqm', 'sqm-scripts'], sizeMB: 3, cat: 'network', label: 'SQM 智能限速', desc: 'CAKE/fq_codel 抗缓冲膨胀', default: false },
  { id: 'wol', pkgs: ['luci-app-wol', 'etherwake'], sizeMB: 2, cat: 'network', label: 'WOL 网络唤醒（原生）', desc: '官方 etherwake 唤醒', default: false },
  { id: 'statistics', pkgs: ['luci-app-statistics', 'collectd'], sizeMB: 30, cat: 'system', label: 'Statistics 统计图表', desc: 'rrdtool 采集与绘图', default: false },
  { id: 'kms-luci-i18n', pkgs: ['luci-i18n-base-zh-cn'], sizeMB: 1, cat: 'i18n', label: 'LuCI 简体中文包', desc: 'Web 界面汉化（按版本可能拆成多个 luci-i18n-* 包）', default: true },
  { id: 'irqbalance', pkgs: ['irqbalance'], sizeMB: 3, cat: 'system', label: 'irqbalance', desc: '多核中断均衡，多网口软路由建议开', default: true },
  { id: 'usb-basic', pkgs: ['kmod-usb-core', 'kmod-usb-storage', 'kmod-usb-storage-uas', 'usbutils', 'block-mount', 'kmod-fs-ext4', 'kmod-fs-vfat', 'kmod-fs-exfat', 'kmod-fs-ntfs3'], sizeMB: 8, cat: 'storage', label: 'USB 存储基础', desc: 'U 盘/移动硬盘识别与常见文件系统', default: false },
  { id: 'nfs-cifs', pkgs: ['kmod-fs-nfs', 'cifsd-server', 'luci-app-cifsd'], sizeMB: 12, cat: 'storage', label: 'SMB / NFS 共享', desc: '局域网文件共享服务端', default: false },
];

const CATEGORIES = [
  { id: 'proxy', label: '代理 / 出海' },
  { id: 'dns', label: 'DNS / 广告过滤' },
  { id: 'vpn', label: 'VPN' },
  { id: 'network', label: '网络工具' },
  { id: 'storage', label: '存储 / 下载' },
  { id: 'system', label: '系统管理' },
  { id: 'theme', label: '主题' },
  { id: 'i18n', label: '国际化' },
];

// ---------------------------------------------------------------------------

/**
 * 解析：给定发行版 / 版本 / arch，返回可勾选的插件清单（含可用性判定）
 *
 * @param {object} o {distro, version, arch, includeThirdParty, includeDiscovered}
 */
async function resolve(o) {
  const { distro, version, arch, includeThirdParty = true, includeDiscovered = true } = o;
  const idx = await getPackageIndex(distro, version, arch).catch(() => null);
  const names = idx ? idx.names : null;
  const manager = idx ? idx.manager : 'opkg';

  const out = [];

  // A. 第三方源码插件
  for (const p of THIRD_PARTY) {
    const item = { ...p, source: 'third', fanType: 'source' };
    // 第三方插件走源码编译，包是否存在于软件源不影响「能否编译」，
    // 但如果某些依赖只能在官方源取得，这里给出提示
    if (names) {
      const missDeps = (p.deps || []).filter((d) => !names.has(d));
      item.repoState = missDeps.length ? 'dep-missing' : 'ok';
      item.missingDeps = missDeps;
      item.repoHasCore = p.pkgs.filter((x) => names.has(x));
    } else {
      item.repoState = 'unknown';
      item.missingDeps = [];
      item.repoHasCore = [];
    }
    if (includeThirdParty) out.push(item);
  }

  // B. 官方源精选
  for (const p of OFFICIAL_EXTRA) {
    const item = { ...p, source: 'official', compile: '-', upstream: null, smallpkg: false };
    if (names) {
      const have = p.pkgs.filter((x) => names.has(x));
      const miss = p.pkgs.filter((x) => !names.has(x));
      if (have.length === p.pkgs.length) item.state = 'ok';
      else if (have.length > 0) item.state = 'partial';
      else item.state = 'missing';
      item.have = have;
      item.missing = miss;
    } else {
      item.state = 'unknown';
      item.have = p.pkgs;
      item.missing = [];
    }
    out.push(item);
  }

  // C. 版本里发现的其它 luci-app-*（未被上面两段覆盖的）
  if (names) {
    const covered = new Set();
    for (const p of out) for (const n of p.pkgs) covered.add(n);
    const discovered = [];
    for (const name of Array.from(names).sort()) {
      if (!/^(luci-app-|luci-theme-|luci-i18n-)/.test(name)) continue;
      if (covered.has(name)) continue;
      if (/-(zh-cn|zh-tw|de|fr|ru|ja|ko|pt-br|es|it|pl|nl|tr|cs|hu|vi|ms|el|he|ro|sk|sv|uk|fa|fi|nb|da|bg|hr|sr|sl|et|lv|lt|zh_Hans)$/i.test(name)) continue;
      discovered.push(name);
    }
    for (const name of discovered) {
      out.push({
        id: `repo:${name}`,
        pkgs: [name],
        label: name.replace(/^luci-(app|theme|i18n)-/, '').replace(/-/g, ' '),
        cat: name.startsWith('luci-theme-') ? 'theme' : (name.startsWith('luci-i18n-') ? 'i18n' : 'system'),
        source: 'repo',
        state: 'ok',
        sizeMB: 4,
        default: false,
        desc: `该版本软件源自带：${name}（勾选即可预装，不需要额外 feed）`,
        upstream: null,
        compile: '-',
        smallpkg: false,
      });
    }
  }

  return {
    manager,
    indexOk: !!names,
    indexCount: idx ? idx.count : 0,
    feedsIndexed: idx ? idx.feeds : [],
    cached: idx ? idx.cached : false,
    plugins: out,
  };
}

/** 从 spec.selected 里取出所有要写进 .config 的包名 */
function expandPackages(selected) {
  const set = new Set();
  for (const p of selected) {
    for (const n of p.pkgs || []) set.add(n);
    for (const n of p.deps || []) set.add(n);
  }
  return Array.from(set);
}

module.exports = { THIRD_PARTY, OFFICIAL_EXTRA, CATEGORIES, resolve, expandPackages, SMALLPKG_SRC };
