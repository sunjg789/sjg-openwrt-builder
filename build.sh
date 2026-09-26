#!/usr/bin/env bash
# ============================================================
# ImageBuilder 一键构建 —— ImmortalWrt 25.12.2
# 设备: x86/64  PROFILE=generic
# 生成时间: 2026-09-26T14:11:50.104Z
#
# 用法:  bash build.sh          （Linux / WSL2 / macOS；必须在普通用户下跑，不要 sudo）
#        ./build.sh --docker    （不想配本机依赖时的容器路径）
# ============================================================
set -Eeuo pipefail

DISTRO="immortalwrt"
VERSION="25.12.2"
TARGET="x86"
SUBTARGET="64"
PROFILE="generic"
ROOTFS_SIZE="512"
IB_URL="https://downloads.immortalwrt.org/releases/25.12.2/targets/x86/64/immortalwrt-imagebuilder-25.12.2-x86-64.Linux-x86_64.tar.zst"
IB_FILE="$(basename "${IB_URL}")"
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="${ROOT}/_ib"
FILES="${ROOT}/files"
LOCKFILE="${ROOT}/.build.lock"

log() { printf '\033[36m[IB]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 0. 单实例锁（两个并发 make 会互删 .o；日志重定向必须发生在拿到锁之后）----
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then die "已有构建在跑（锁: $LOCKFILE）；确认没有再删锁重试"; fi
else
  log "未安装 flock，跳过单实例保护（建议 apt install util-linux）"
fi

# ---- 1. 环境预检 ----
log "检查构建环境"
[ "$(id -u)" = "0" ] && die "请不要用 root/sudo 构建，会造成后续普通用户无法写入"
case "$ROOT" in *" "*) die "路径含空格，OpenWrt 构建系统不支持: $ROOT";; esac
unset SED GREP_OPTIONS 2>/dev/null || true

# make 必须 >= 4.3：4.2.1 会把 $(shell ...) 里的 # 当注释，报 unterminated call to function 'shell'
MK="$(command -v make || true)"
MKVER="${MK:+}$(make --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)"
if [ -n "$MKVER" ]; then
  MAJOR="${MKVER%%.*}"; MINOR="${MKVER##*.}"
  if [ "$MAJOR" -lt 4 ] || { [ "$MAJOR" -eq 4 ] && [ "$MINOR" -lt 3 ]; }; then
    die "GNU make ${MKVER} 过低，需要 >= 4.3。源码编译安装见 README-IB.md §排障 1"
  fi
fi

# Ubuntu 26.04+ 的 uutils coreutils：install 不是 GNU 版，prereq 会失败
if command -v install >/dev/null 2>&1; then
  if install --version 2>&1 | grep -qi 'uutils'; then
    if ! command -v gnuinstall >/dev/null 2>&1; then
      die "检测到 uutils coreutils 但无 gnuinstall。执行: sudo apt-get install -y gnu-coreutils
           然后建立软链: sudo ln -sf $(command -v ginstall-coreutils 2>/dev/null || echo /usr/bin/ginstall) /usr/local/bin/gnuinstall"
    fi
    log "uutils coreutils 环境，已找到 gnuinstall"
  fi
fi

# ---- 2. 下载 ImageBuilder ----
mkdir -p "$WORK"
cd "$WORK"
if [ ! -s "$IB_FILE" ]; then
  log "下载 ${IB_URL}"
  curl -fL --retry 3 --connect-timeout 20 -o "$IB_FILE.part" "$IB_URL" || die "ImageBuilder 下载失败"
  mv "$IB_FILE.part" "$IB_FILE"
else
  log "复用已下载的 $IB_FILE"
fi

# ---- 3. 解包 ----
log "解包 $IB_FILE"
command -v zstd >/dev/null 2>&1 || case "$IB_FILE" in *.zst) die "缺 zstd: 请先安装 (apt) sudo apt-get install -y zstd";; esac
# 上游 tar 结一层以体积命名的入口算式目录，这里自动识别
tar --zstd -xf "$IB_FILE" -C .
IBDIR="$(find . -maxdepth 1 -type d -name '*-imagebuilder-*' | head -n1)"
[ -n "$IBDIR" ] || IBDIR="."
IBDIR="$(cd "$IBDIR" && pwd)"
log "ImageBuilder 目录: $IBDIR"
[ -f "$IBDIR/repositories.conf" ] || die "未找到 repositories.conf，压缩包可能损坏"
cd "$IBDIR"

# ---- 4. 附加第三方软件源 ----
log "未配置第三方软件源，仅使用上游官方源"


# 列出可用 profile，确认名称拼写正确
log "可用 PROFILE 列表（取前 60 行）:"
make info 2>/dev/null | grep -E '^[^ :]+:' | head -60 || true

# ---- 5. 包清单 ----
PACKAGES="luci ttyd wireguard-tools"
log "包数: $(echo $PACKAGES | wc -w)"

# ---- 6. 生成产物 ----
log "开始打包（PROFILE=$PROFILE ROOTFS_PARTSIZE=$ROOTFS_SIZE）"
make image \
  PROFILE="$PROFILE" \
  PACKAGES="$PACKAGES" \
  FILES="$FILES" \
  ROOTFS_PARTSIZE="$ROOTFS_SIZE" \
  V=s

# ---- 7. 收集产物 ----
OUT="${ROOT}/bin"
mkdir -p "$OUT"
cp -r "$IBDIR/bin/targets/." "$OUT/" 2>/dev/null || true
log "构建完成，产物在 ${OUT}:"
find "$OUT" -type f \( -name '*.img*' -o -name '*.bin' -o -name '*.gz' -o -name '*.iso' -o -name '*.qcow2' \) -printf '  %p  %s bytes\n' | head -40
