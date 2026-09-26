'use strict';
/**
 * genib.js — ImageBuilder 引擎的产物生成器
 *
 * 与源码全编译（generate.js）并列的一条更快路径：
 *   下载该版本的 ImageBuilder → 解包 → 写自定义软件源 → FILES= 塞首启脚本 → make image PROFILE=<设备> PACKAGES="..."
 *   全程不编译任何东西，3~10 分钟出固件，磁盘 <2GB。
 *
 * 内含的排障防护全部来自已验证结论：
 *   - GNU make 必须 >= 4.3（4.2.1 会把 $(shell) 里的 # 当注释 → "unterminated call to function 'shell'"）
 *   - Ubuntu 26.04+ 默认 uutils coreutils，install 不是 GNU 版 → prereq 检测失败，装 gnu-coreutils 并链 gnuinstall
 *   - 必须单实例运行（两个 make 互删 .o），用 flock 加锁，且日志重定向必须发生在拿到锁之后
 *   - ImageBuilder 也要 make download 前置，并行下载会撞索引
 */
const { md5crypt, randomSalt } = require('./hash');
const { DISTROS, releaseRoot, gitRefInfo } = require('./distros');
const { ZSTD_HINT, untarCmd } = require('./imagebuilder');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, `'\\''`);
const dq = (s) => String(s === undefined || s === null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');

// ---------------------------------------------------------------- 首启脚本

function buildUciScript(spec) {
  const net = spec.network || {};
  const sys = spec.system || {};
  const rootHash = md5crypt(sys.password || '', randomSalt());
  const userHash = sys.loginName && sys.loginPassword ? md5crypt(sys.loginPassword, randomSalt()) : '';
  const wanPorts = Array.isArray(net.wanPorts) ? net.wanPorts.filter(Boolean) : [];
  const lanPorts = Array.isArray(net.lanPorts) ? net.lanPorts.filter(Boolean) : [];
  const explicit = wanPorts.length > 0 || lanPorts.length > 0;

  return `#!/bin/sh
# ============================================================
# 首启动配置脚本 —— 由 OpenWrt 定制站生成（ImageBuilder 引擎）
# 位置: /etc/uci-defaults/99-zz-custom.sh  （首次启动时执行一次，随后自动删除）
# 目标: ${spec.distro} ${spec.version} / ${spec.target}/${spec.subtarget} / ${spec.profile}
# ============================================================
LOGFILE="/etc/config/firstboot-custom.log"
echo "=== $(date) start ===" >>"$LOGFILE"

# ---------- 1. 主机名 / 时区 ----------
uci -q set system.@system[0].hostname='${esc(sys.hostname || 'OpenWrt')}'
uci -q set system.@system[0].timezone='${esc(sys.timezone || 'CST-8')}'
uci -q set system.@system[0].zonename='${esc(sys.zonename || 'Asia/Shanghai')}'

# ---------- 2. 管理密码 + 登录用户 ----------
# 注意: hash 一律用单引号包起来——含 $1$ 的 md5crypt 一旦进双引号会被 shell 当成位置参数
ROOT_HASH='${rootHash}'
if [ -n "$ROOT_HASH" ]; then
  sed -i "s#^root:[^:]*:#root:\${ROOT_HASH}:#" /etc/shadow
  echo "root password set" >>"$LOGFILE"
fi
${userHash ? `USER_HASH='${userHash}'
LOGIN_NAME='${esc(sys.loginName)}'
if [ -n "$USER_HASH" ] && [ -n "$LOGIN_NAME" ]; then
  # 已存在则改密，不存在则建普通 login shell 用户
  if grep -q "^$LOGIN_NAME:" /etc/passwd; then
    sed -i "s#^$LOGIN_NAME:[^:]*:#$LOGIN_NAME:x:#" /etc/passwd
    sed -i "s#^$LOGIN_NAME:[^:]*:#$LOGIN_NAME:\${USER_HASH}:#" /etc/shadow
  else
    LAST_UID=$(awk -F: '$3>=1000 && $3<60000 { if ($3>m) m=$3 } END { print (m?m:999) }' /etc/passwd)
    NEW_UID=$((LAST_UID + 1))
    echo "$LOGIN_NAME:x:$NEW_UID:$NEW_UID::/home/$LOGIN_NAME:/bin/ash" >>/etc/passwd
    echo "$LOGIN_NAME:x:$NEW_UID:" >>/etc/group
    echo "$LOGIN_NAME:$USER_HASH:$(( $(date +%s) / 86400 )):0:99999:7:::" >>/etc/shadow
    mkdir -p "/home/$LOGIN_NAME" && chown "$NEW_UID:$NEW_UID" "/home/$LOGIN_NAME"
  fi
  echo "user $LOGIN_NAME ready" >>"$LOGFILE"
fi` : '# 未设置额外登录用户'}

# ---------- 3. Wan 区防火墙默认放行（方便首次调试；稳定后请改成 reject）----------
uci -q set firewall.@zone[1].input='${spec.wanInput === 'reject' ? 'REJECT' : 'ACCEPT'}'

# ---------- 4. 网口识别与分配 ----------
ifnames=""
for iface in /sys/class/net/*; do
  n=$(basename "$iface")
  [ "$n" = "lo" ] && continue
  if [ -e "$iface/device" ] || [ -d "$iface/wireless" ]; then
    if echo "$n" | grep -Eq '^eth|^en|^lan[0-9]|^wan'; then ifnames="$ifnames $n"; fi
  fi
done
ifnames=$(echo "$ifnames" | awk '{$1=$1};1')
COUNT=$(echo "$ifnames" | wc -w)
echo "detected: $ifnames (count=$COUNT)" >>"$LOGFILE"

${explicit ? `# 用户显式指定了网口，优先使用
WAN_IF='${esc(wanPorts[0] || '')}'
LAN_IFS='${esc(lanPorts.join(' '))}'
# 显式指定的口必须在真实列表里，否则退回自动识别
if [ -n "$WAN_IF" ] && ! echo " $ifnames " | grep -q " $WAN_IF "; then
  echo "WARN: WAN $WAN_IF not present, fallback auto" >>"$LOGFILE"
  WAN_IF=""
fi
if [ -z "$WAN_IF" ]; then
  WAN_IF=$(echo "$ifnames" | awk '{print $1}')
  LAN_IFS=$(echo "$ifnames" | cut -d' ' -f2-)
fi` : `# 自动分配：第一个网口做 WAN，其余进 LAN
WAN_IF=$(echo "$ifnames" | awk '{print $1}')
LAN_IFS=$(echo "$ifnames" | cut -d' ' -f2-)`}

if [ "$COUNT" -le 1 ]; then
  # 单网口：一律 DHCP（旁路由/虚拟机常见，避免刷完连不上）
  uci -q set network.lan.proto='dhcp'
  uci -q delete network.lan.ipaddr
  uci -q delete network.lan.netmask
  uci -q delete network.lan.gateway
  uci -q delete network.lan.dns
else
  uci -q set network.wan=interface
  uci -q set network.wan.device="$WAN_IF"
  uci -q set network.wan6=interface
  uci -q set network.wan6.device="$WAN_IF"

${(net.wanProto || 'dhcp') === 'pppoe' ? `  uci -q set network.wan.proto='pppoe'
  uci -q set network.wan.username='${esc(net.pppoeUser)}'
  uci -q set network.wan.password='${esc(net.pppoePass)}'
  uci -q set network.wan.peerdns='1'
  uci -q set network.wan.auto='1'
  uci -q set network.wan.mtu='1492'` :
  (net.wanProto === 'static' ? `  uci -q set network.wan.proto='static'
  uci -q set network.wan.ipaddr='${esc(net.wanIp)}'
  uci -q set network.wan.netmask='${esc(net.wanNetmask || '255.255.255.0')}'
  uci -q set network.wan.gateway='${esc(net.wanGateway)}'
  [ -n '${esc(net.wanDns)}' ] && uci -q set network.wan.dns='${esc(net.wanDns)}'` :
    `  uci -q set network.wan.proto='dhcp'`)}
${net.wanProto === 'pppoe' ? `  uci -q set network.wan6.proto='none'` : `  uci -q set network.wan6.proto='dhcpv6'`}

  # br-lan: 找到 bridge device section 并重写成员端口
  BRSEC=$(uci show network | awk -F'[.=]' '/\\.@?device\\[[0-9]+\\]\\.name=.br-lan.$/ {print $2; exit}')
  if [ -n "$BRSEC" ]; then
    uci -q delete "network.$BRSEC.ports"
    for p in $LAN_IFS; do uci -q add_list "network.$BRSEC.ports=$p"; done
  else
    uci -q del_list network.lan.device='br-lan'
    for p in $LAN_IFS; do uci -q add_list "network.br_lan.ports=$p"; done
  fi

  uci -q set network.lan.proto='static'
  uci -q set network.lan.ipaddr='${esc(net.lanIp || '192.168.1.1')}'
  uci -q set network.lan.netmask='${esc(net.lanNetmask || '255.255.255.0')}'
fi
uci -q commit network

# ---------- 4.5 旁路由（旁路网关）模式 ----------
${(net.mode === 'bypass') ? `# 单臂网关：LAN 口静态 IP + 指向上级网关 + 关掉本机 DHCP + LAN 区做地址伪装
uci -q set network.lan.proto='static'
uci -q set network.lan.ipaddr='${esc(net.bypassIp || net.lanIp || '192.168.1.2')}'
uci -q set network.lan.netmask='${esc(net.lanNetmask || '255.255.255.0')}'
${net.bypassGateway ? `uci -q set network.lan.gateway='${esc(net.bypassGateway)}'` : `# 未填上级网关 → 不写 gateway（会导致无法上网）`}
${net.bypassDns ? `uci -q set network.lan.dns='${esc(net.bypassDns)}'` : `# DNS 留空 → 继承上级网关`}
uci -q set dhcp.lan.ignore='1'
uci -q delete network.wan
uci -q delete network.wan6
uci -q set firewall.@zone[0].masq='1'
uci -q set firewall.@zone[0].mtu_fix='1'
uci -q commit network
uci -q commit dhcp
echo "bypass gateway mode applied" >>"$LOGFILE"` : '# 主路由模式，跳过'}

# ---------- 5. IPv6 ----------
${spec.ipv6 === false ? `# 关闭 IPv6
uci -q set dhcp.lan.dhcpv6='disabled'
uci -q set dhcp.lan.ra='disabled'
uci -q set dhcp.lan.ndp='disabled'
uci -q set network.lan.delegate='0'
uci -q delete network.wan6
uci -q delete network.lan.ip6assign
uci -q delete network.globals.ula_prefix` : `# 开启 IPv6：LAN 侧 server 模式 + WAN 侧 dhcpv6 客户端 solicit 全部前缀级别
uci -q set dhcp.lan.dhcpv6='server'
uci -q set dhcp.lan.ra='server'
uci -q set dhcp.lan.ndp='hybrid'
uci -q set dhcp.lan.ra_management='1'
uci -q set network.lan.delegate='1'
uci -q set network.lan.ip6assign='64'
# 保留ULA 前缀：WAN 侧拿不到 PD 时，LAN 仍能靠 fd00::/64 正常编址
uci -q set network.wan6.reqaddress='try'
uci -q set network.wan6.reqprefix='auto'
[ "$(uci -q get network.wan6.proto)" != "none" ] && uci -q set network.wan6.proto='dhcpv6'
uci -q set dhcp.odhcpd.maindhcp='0'
uci -q set dhcp.@dnsmasq[0].dnsforwardmax='1500'`}
uci -q commit dhcp

# ---------- 6. 让所有网口都能访问 SSH / TTYD ----------
uci -q set dropbear.@dropbear[0].Interface=''
uci -q commit dropbear
if uci -q get ttyd.@ttyd[0] >/dev/null; then
  uci -q delete ttyd.@ttyd[0].interface
  uci -q commit ttyd
fi

# ---------- 7. 安卓原生 TV 校时域名兜底 ----------
uci -q delete dhcp.time_android >/dev/null 2>&1
uci -q set dhcp.time_android=domain
uci -q set dhcp.time_android.name='time.android.com'
uci -q set dhcp.time_android.ip='203.107.6.88'
uci -q commit dhcp

# ---------- 8. Docker 防火墙放行（装了 dockerd 才执行）----------
if command -v dockerd >/dev/null 2>&1; then
  uci -q delete firewall.docker
  for idx in $(uci show firewall | grep '=forwarding' | sed 's/.*\\[\\([0-9]*\\)\\].*/\\1/' | sort -rn); do
    s=$(uci -q get firewall.@forwarding[$idx].src); d=$(uci -q get firewall.@forwarding[$idx].dest)
    if [ "$s" = "docker" ] || [ "$d" = "docker" ]; then uci -q delete firewall.@forwarding[$idx]; fi
  done
  cat >>/etc/config/firewall <<'FWEOF'

config zone 'docker'
  option input 'ACCEPT'
  option output 'ACCEPT'
  option forward 'ACCEPT'
  option name 'docker'
  list subnet '172.16.0.0/12'

config forwarding
  option src 'docker'
  option dest 'lan'

config forwarding
  option src 'docker'
  option dest 'wan'

config forwarding
  option src 'lan'
  option dest 'docker'
FWEOF
  uci -q commit firewall
  echo "docker zone added" >>"$LOGFILE"
fi

# ---------- 9. 自定义附加脚本 ----------
${spec.userScript ? `
cat >>/etc/config/user-extra.sh <<'UXT'
${spec.userScript}
UXT
sh /etc/config/user-extra.sh >>"$LOGFILE" 2>&1
` : '# 无'}

uci -q commit network
uci -q commit system
uci -q commit firewall
echo "=== $(date) done ===" >>"$LOGFILE"
exit 0
`;
}

// ---------------------------------------------------------------- 构建脚本

function buildIbScript(spec, ibInfo) {
  const d = DISTROS[spec.distro] || {};
  // 官方源里确定没有的包会从 PACKAGES 里剔除（IB 遇到未知包是硬失败，不是警告），
  // 剔除清单由 spec.dropped 带进来，产物里会显式写出来，避免"静默少装了包"。
  const drop = new Set(spec.dropped || []);
  const pkgs = (spec.packages || []).filter((p) => !drop.has(p)).join(' ');
  const excl = (spec.excludes || []).map((p) => '-' + p).join(' ');
  const allPkgs = [pkgs, excl].filter(Boolean).join(' ');
  const untar = untarCmd(ibInfo.ext || 'tar.zst');
  const size = spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB : 1024;

  return `#!/usr/bin/env bash
# ============================================================
# ImageBuilder 一键构建 —— ${d.name || spec.distro} ${spec.version}
# 设备: ${spec.target}/${spec.subtarget}  PROFILE=${spec.profile}
# 生成时间: ${new Date().toISOString()}
#
# 用法:  bash build.sh          （Linux / WSL2 / macOS；必须在普通用户下跑，不要 sudo）
#        ./build.sh --docker    （不想配本机依赖时的容器路径）
# ============================================================
set -Eeuo pipefail

DISTRO="${spec.distro}"
VERSION="${spec.version}"
TARGET="${spec.target}"
SUBTARGET="${spec.subtarget}"
PROFILE="${spec.profile}"
ROOTFS_SIZE="${size}"
IB_URL="${ibInfo.url || '（未探测到，请手工确认）'}"
IB_FILE="$(basename "\${IB_URL}")"
ROOT="$(cd "\$(dirname "\$0")" && pwd)"
WORK="\${ROOT}/_ib"
FILES="\${ROOT}/files"
LOCKFILE="\${ROOT}/.build.lock"

log() { printf '\\033[36m[IB]\\033[0m %s\\n' "\$*"; }
die() { printf '\\033[31m[错误]\\033[0m %s\\n' "\$*" >&2; exit 1; }

# ---- 0. 单实例锁（两个并发 make 会互删 .o；日志重定向必须发生在拿到锁之后）----
if command -v flock >/dev/null 2>&1; then
  exec 9>"\$LOCKFILE"
  if ! flock -n 9; then die "已有构建在跑（锁: \$LOCKFILE）；确认没有再删锁重试"; fi
else
  log "未安装 flock，跳过单实例保护（建议 apt install util-linux）"
fi

# ---- 1. 环境预检 ----
log "检查构建环境"
[ "\$(id -u)" = "0" ] && die "请不要用 root/sudo 构建，会造成后续普通用户无法写入"
case "\$ROOT" in *" "*) die "路径含空格，OpenWrt 构建系统不支持: \$ROOT";; esac
unset SED GREP_OPTIONS 2>/dev/null || true

# make 必须 >= 4.3：4.2.1 会把 \$(shell ...) 里的 # 当注释，报 unterminated call to function 'shell'
MK="\$(command -v make || true)"
MKVER="\${MK:+}\$(make --version 2>/dev/null | head -1 | grep -oE '[0-9]+\\.[0-9]+' | head -1)"
if [ -n "\$MKVER" ]; then
  MAJOR="\${MKVER%%.*}"; MINOR="\${MKVER##*.}"
  if [ "\$MAJOR" -lt 4 ] || { [ "\$MAJOR" -eq 4 ] && [ "\$MINOR" -lt 3 ]; }; then
    die "GNU make \${MKVER} 过低，需要 >= 4.3。源码编译安装见 README-IB.md §排障 1"
  fi
fi

# Ubuntu 26.04+ 的 uutils coreutils：install 不是 GNU 版，prereq 会失败
if command -v install >/dev/null 2>&1; then
  if install --version 2>&1 | grep -qi 'uutils'; then
    if ! command -v gnuinstall >/dev/null 2>&1; then
      die "检测到 uutils coreutils 但无 gnuinstall。执行: sudo apt-get install -y gnu-coreutils
           然后建立软链: sudo ln -sf \$(command -v ginstall-coreutils 2>/dev/null || echo /usr/bin/ginstall) /usr/local/bin/gnuinstall"
    fi
    log "uutils coreutils 环境，已找到 gnuinstall"
  fi
fi

# ---- 2. 下载 ImageBuilder ----
mkdir -p "\$WORK"
cd "\$WORK"
if [ ! -s "\$IB_FILE" ]; then
  log "下载 \${IB_URL}"
  curl -fL --retry 3 --connect-timeout 20 -o "\$IB_FILE.part" "\$IB_URL" || die "ImageBuilder 下载失败"
  mv "\$IB_FILE.part" "\$IB_FILE"
else
  log "复用已下载的 \$IB_FILE"
fi

# ---- 3. 解包 ----
log "解包 \$IB_FILE"
command -v zstd >/dev/null 2>&1 || case "\$IB_FILE" in *.zst) die "缺 zstd: 请先安装 (${spec.pkgMgrHint || 'apt'}) sudo apt-get install -y zstd";; esac
# 上游 tar 结一层以体积命名的入口算式目录，这里自动识别
${untar} "\$IB_FILE" -C .
IBDIR="\$(find . -maxdepth 1 -type d -name '*-imagebuilder-*' | head -n1)"
[ -n "\$IBDIR" ] || IBDIR="."
IBDIR="\$(cd "\$IBDIR" && pwd)"
log "ImageBuilder 目录: \$IBDIR"
[ -f "\$IBDIR/repositories.conf" ] || die "未找到 repositories.conf，压缩包可能损坏"
cd "\$IBDIR"

# ---- 4. 附加第三方软件源 ----
${(spec.customRepos && spec.customRepos.length) ? `log "写入自定义软件源"
cat >> repositories.conf <<'REPOEOF'
${spec.customRepos.map((r) => `\n# ${r.name}\nsrc/gz ${r.id || 'custom'} ${r.url}`).join('\n')}
REPOEOF
${spec.customRepos.filter((r) => r.key).map((r) => `# 签名公钥: 把 ${r.name} 的 key 放到 keys/ 后会在这里自动安装`).join('\n')}
` : 'log "未配置第三方软件源，仅使用上游官方源"'}
${(spec.apkRepos && spec.apkRepos.length) ? `# apk 系 (25.12+) 的源写在 repositories 里
cat >> repositories <<'APKREPOEOF'
${spec.apkRepos.join('\n')}
APKREPOEOF
` : ''}

# 列出可用 profile，确认名称拼写正确
log "可用 PROFILE 列表（取前 60 行）:"
make info 2>/dev/null | grep -E '^[^ :]+:' | head -60 || true

# ---- 5. 包清单 ----
PACKAGES="${allPkgs}"
log "包数: \$(echo \$PACKAGES | wc -w)"

# ---- 6. 生成产物 ----
log "开始打包（PROFILE=\$PROFILE ROOTFS_PARTSIZE=\$ROOTFS_SIZE）"
make image \\
  PROFILE="\$PROFILE" \\
  PACKAGES="\$PACKAGES" \\
  FILES="\$FILES" \\
  ROOTFS_PARTSIZE="\$ROOTFS_SIZE" \\
  V=s

# ---- 7. 收集产物 ----
OUT="\${ROOT}/bin"
mkdir -p "\$OUT"
cp -r "\$IBDIR/bin/targets/." "\$OUT/" 2>/dev/null || true
log "构建完成，产物在 \${OUT}:"
find "\$OUT" -type f \\( -name '*.img*' -o -name '*.bin' -o -name '*.gz' -o -name '*.iso' -o -name '*.qcow2' \\) -printf '  %p  %s bytes\\n' | head -40
`;
}

// ---------------------------------------------------------------- GH Actions

function buildIbWorkflow(spec, ibInfo) {
  const d = DISTROS[spec.distro] || {};
  const drop = new Set(spec.dropped || []);
  const pkgs = (spec.packages || []).filter((p) => !drop.has(p)).join(' ');
  const excl = (spec.excludes || []).map((p) => '-' + p).join(' ');
  const allPkgs = [pkgs, excl].filter(Boolean).join(' ');
  const size = spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB : 1024;
  const untar = untarCmd(ibInfo.ext || 'tar.zst');
  return `name: IB-${spec.distro}-${spec.version}-${spec.target}-${spec.subtarget}

on:
  workflow_dispatch:
  push:
    paths: ['files/**', '.github/workflows/**']

# 最小权限：这份工作流只做「下载 IB → 打包 → 上传产物」，从不回写仓库。
# 索要写权限等于白送一枚可推代码的 GITHUB_TOKEN（官方安全建议默认只读）。
permissions:
  contents: read

jobs:
  ib:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - name: 安装 ImageBuilder 依赖
        run: |
          sudo apt-get update
          sudo apt-get install -y zstd xz-utils build-essential libncurses-dev zlib1g-dev \\
            gawk git gettext libssl-dev python3 python3-distutils rsync unzip file wget time \\
            qemu-utils genisoimage
          # qemu-utils 提供 qemu-img：x86 等目标在 make image 时会顺带产出 qcow2/vdi/vmdk/vhdx，
          # 缺了它 make 会在最后一步以 Error 1 告终（整轮失败，产物连带拿不到）。
          command -v qemu-img >/dev/null 2>&1 && qemu-img --version | head -1
          # OpenWrt 的 Makefile 里 ISO 那一步写死了 mkisofs，而 Ubuntu 只提供 genisoimage
          #（jammy 里根本没有 mkisofs 这个包），不补链接会在 *.iso 上以 Error 127 收尾。
          command -v mkisofs >/dev/null 2>&1 || sudo ln -sf "$(command -v genisoimage)" /usr/local/bin/mkisofs
          mkisofs --version | head -1
          # GNU install 预检：Ubuntu 26.04+ 默认换成 uutils coreutils，install 不带 GNU 字样，
          # OpenWrt 的 prereq 会直接 "Please install GNU 'install'" 退出（它兜底的 ginstall 在 Ubuntu 叫 gnuinstall）。
          # 现在钉的是 22.04 用不上，但 runner 镜像一升级就会踩，所以提前兜住。
          if install --version 2>&1 | grep -qi uutils; then
            sudo apt-get install -y gnu-coreutils
            sudo ln -sf /usr/bin/gnuinstall /usr/local/bin/install
            echo "/usr/local/bin 已置顶: $(command -v install)"
          fi
          install --version | head -1
          # GitHub 22.04 runner 自带 make 4.3+，但仍要确认
          make --version | head -1

      - name: 下载并解包 ImageBuilder
        id: ib
        run: |
          set -e
          wget -q --tries=3 -O ib.tar '${ibInfo.url || ''}'
          mkdir -p _ib && ${untar} ib.tar -C _ib
          IBDIR="$(find _ib -maxdepth 1 -type d -name '*-imagebuilder-*' | head -n1)"
          [ -n "$IBDIR" ] || IBDIR="_ib"
          echo "ibdir=$IBDIR" >> $GITHUB_OUTPUT

      - name: 附加第三方软件源
${(spec.customRepos && spec.customRepos.length) ? `        run: |
          cat >> \${{ steps.ib.outputs.ibdir }}/repositories.conf <<'EOF'
${spec.customRepos.map((r) => `\n# ${r.name}\nsrc/gz ${r.id || 'custom'} ${r.url}`).join('\n')}
EOF
` : `        run: echo "未配置第三方源，跳过"`}

      - name: 跳过虚拟磁盘格式（qcow2 / vdi / vmdk / vhdx）
        # x86 的 ImageBuilder 默认会额外产出这几种虚拟盘镜像，每份都是一块完整磁盘：
        # 产物从几十 MB 直接飙到近 400MB（实测 386MB），下载要按小时计；
        # 而且它们恰好是两次构建失败的源头（缺 qemu-img / 缺 mkisofs）。
        # 刷机要的是 combined(-efi) 之类的整机镜像，这里先把这些格式关掉。
        run: |
          set -e
          cd \${{ steps.ib.outputs.ibdir }}
          touch .config
          for k in QCOW2 VDI VMDK VHDX; do
            if grep -qE "^#? *CONFIG_\${k}_IMAGES" .config; then
              sed -i "s/^#\\? *CONFIG_\${k}_IMAGES=.*/CONFIG_\${k}_IMAGES=n/" .config
            else
              echo "CONFIG_\${k}_IMAGES=n" >> .config
            fi
          done
          grep -E "CONFIG_(QCOW2|VDI|VMDK|VHDX)_IMAGES" .config || true

      - name: 打包固件
        run: |
          set -e
          cd \${{ steps.ib.outputs.ibdir }}
          make image \\
            PROFILE='${spec.profile}' \\
            PACKAGES='${allPkgs}' \\
            FILES='\${{ github.workspace }}/files' \\
            ROOTFS_PARTSIZE='${size}' \\
            V=s

      - name: 收集产物
        run: |
          mkdir -p out
          # 只收整机镜像，排除虚拟盘格式与未压缩的裸 .img（后者同样是按 GB 计）
          find \${{ steps.ib.outputs.ibdir }}/bin/targets -type f \\
            \\( -name '*.img.gz' -o -name '*.bin' -o -name '*.iso' -o -name '*.tar.gz' \\) \\
            ! -name '*.qcow2' ! -name '*.vdi' ! -name '*.vmdk' ! -name '*.vhdx' \\
            -exec cp -v {} out/ \\; || true
          du -sh out/
          ls -lh out/

      - uses: actions/upload-artifact@v4
        with:
          name: firmware-\${{ github.run_id }}
          path: out/*
          if-no-files-found: error
`;
}

// ---------------------------------------------------------------- README

function buildIbReadme(spec, ibInfo) {
  const d = DISTROS[spec.distro] || {};
  const size = spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB : 1024;
  return `# ${d.name || spec.distro} ${spec.version} · ${spec.target}/${spec.subtarget} · ${spec.profile}

由 **ImageBuilder 引擎**生成 —— 不编译源码，只做打包，正常 3~10 分钟出固件。

## 构建参数

| 项 | 值 |
|---|---|
| 发行版 | ${d.name || spec.distro} (${spec.distro}) |
| 版本 | ${spec.version} |
| 目标 | ${spec.target} / ${spec.subtarget} |
| 设备 PROFILE | ${spec.profile} |
| 包架构 | ${spec.archPackages || '（未识别）'} |
| 根分区大小 | ${size} MB |
| 管理地址 | ${spec.network && spec.network.lanIp ? spec.network.lanIp : '192.168.1.1'} |
| WAN 协议 | ${(spec.network && spec.network.wanProto) || 'dhcp'} |
| IPv6 | ${spec.ipv6 === false ? '关闭' : '开启'} |
| 包数量 | ${(spec.packages || []).length} |

## 跑起来

\`\`\`bash
chmod +x build.sh
bash build.sh
\`\`\`

产物落在 \`bin/\` 下。

## 三种路径怎么选

| 路径 | 耗时 | 磁盘 | 能做什么 |
|---|---|---|---|
| **本脚本（ImageBuilder）** | 3~10 分钟 | < 2GB | 增删随镜像自带的包、改默认配置、附加第三方软件源 |
| 源码全编译 | 1~3 小时 | ≈ 50GB | 改内核配置、改驱动、编译官方源里没有的软件 |
| Docker 容器化 IB | 5~15 分钟 | < 2GB | 不想在本机装依赖时的等价路径 |

**结论：只想「选设备 + 挑插件 + 预配置」时，ImageBuilder 是唯一合理选择。**
只有需要改内核选项 / 编译第三方源码时才有必要动全编译。

## 关键约束（必须遵守）

1. **路径不能有空格**，文件系统要区分大小写；WSL2 请放在 ext4 分区，不要放 \`/mnt/c\` 后再软链。
2. **禁止 root / sudo** 构建。
3. **不要并发跑两份 make**（会互删 .o）——本脚本已用 \`flock\` 加单实例锁。
4. 环境里不能设 \`SED\`、\`GREP_OPTIONS\`；\`which\` 不能被 alias 掉。

## 排障速查

### 1. \`unterminated call to function 'shell'\`
GNU make 4.2.1 的已知缺陷：它把 \`\$(shell ...)\` 里的 \`#\` 当成注释。必须 make >= 4.3：

\`\`\`bash
make --version | head -1          # 需 >= 4.3
wget https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz
tar -xf make-4.4.1.tar.gz && cd make-4.4.1
./configure --prefix=/usr/local && make -j\$(nproc) && sudo make install
hash -r && make --version         # 确认已切到 4.4.1
\`\`\`

### 2. Ubuntu 26.04+：\`prerequisite check failed\`
默认 coreutils 是 Rust 版 uutils，\`install --version\` 打印 \`(uutils coreutils)\`，
而 OpenWrt 的 \`include/prereq-build.mk\` 用 grep 找 \`GNU\`；它兜底的 \`ginstall\` 在 Ubuntu 里叫 \`gnuinstall\`。

\`\`\`bash
sudo apt-get install -y gnu-coreutils
# 找到实际二进制名并链过去
ls /usr/bin | grep -i install
sudo ln -sf <实际路径> /usr/local/bin/gnuinstall
\`\`\`
**不要用 \`FORCE=1\` 跳过预检**——那只是把问题推到后面，报错会更难读。

### 3. \`PROFILE=... does not exist\`
先打印真实列表，注意 profile 名是小写、下划线连写的机器名：

\`\`\`bash
make info | grep -E '^[a-z0-9_]+:'
\`\`\`

### 4. 装不上某个包（\`package not found\`）
ImageBuilder **只能装peluch该版本软件源里真实存在的包**。第三方包必须先有对应的软件源。
把第三方源填到 \`repositories.conf\` 后再重新 \`make image\`。

### 5. \`make: TMPDIR value ...: No such file\`
这行是**警告不是错误**。判断成败要看倒查 20 行：

\`\`\`bash
tail -20 <日志>
\`\`\`

## 首次登录

- 后台：http://${(spec.network && spec.network.lanIp) || '192.168.1.1'}
- 用户名 \`root\`${spec.system && spec.system.loginName ? `，或 \`${spec.system.loginName}\`` : ''}
- ${spec.system && !spec.system.password ? '**未设密码**，首次 SSH/telnet 登录时会要求设置' : '密码已预置'}
${spec.wanInput !== 'reject' ? '- ⚠️ WAN 区「入站」当前是**放行**，调试完成后请到 网络→防火墙 改成「拒绝」' : '- WAN 区入站已是「拒绝」'}
`;
}

// ---------------------------------------------------------------- 出口

function generateIB(spec, ibInfo) {
  const files = [];
  files.push({ path: 'build.sh', content: buildIbScript(spec, ibInfo), exec: true });
  files.push({ path: 'files/etc/uci-defaults/99-zz-custom.sh', content: buildUciScript(spec), exec: true });
  files.push({
    path: 'PACKAGES.txt',
    content: [
      `# ${spec.distro} ${spec.version} ${spec.target}/${spec.subtarget} ${spec.profile}`,
      `# 加 -- > 为正选；带 - 前缀为排除（ImageBuilder 的 -pkg 语法）`,
      '',
      ...(spec.packages || []).map((p) => `+ ${p}`),
      ...(spec.excludes || []).map((p) => `- ${p}`),
      '',
      // 被剔除的包必须留痕：IB 对未知包是硬失败，静默丢包比显式列出更糟
      ...((spec.dropped || []).length ? [
        '',
        '# 以下包不在本版本官方软件源里，已从 PACKAGES 剔除（ImageBuilder 遇到未知包会直接失败）：',
        ...(spec.dropped || []).map((p) => `#   × ${p}`),
        '# 若确实需要：在站点「第三方软件源」里配上对应仓库后重新生成（配了源就不会被剔除）。',
      ] : []),
      '',
    ].join('\n'),
  });
  files.push({ path: '.github/workflows/ib-build.yml', content: buildIbWorkflow(spec, ibInfo) });
  files.push({ path: 'README-IB.md', content: buildIbReadme(spec, ibInfo) });
  files.push({ path: 'spec.json', content: JSON.stringify(spec, null, 2) });
  return files;
}

function estimateIB(spec) {
  const n = (spec.packages || []).length;
  const base = 60; // IB 下载 + 解包 + 依赖解压
  const perPkg = 2.5;
  const seconds = Math.round(base + n * perPkg);
  return {
    engine: 'ib',
    seconds,
    human: seconds < 120 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`,
    diskGB: 1.5 + (spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB / 1024 : 1),
    note: 'ImageBuilder 不编译源码，只做打包',
  };
}

module.exports = { generateIB, estimateIB, buildUciScript, buildIbScript, buildIbWorkflow, buildIbReadme };
