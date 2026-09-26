#!/bin/sh
# ============================================================
# 首启动配置脚本 —— 由 OpenWrt 定制站生成（ImageBuilder 引擎）
# 位置: /etc/uci-defaults/99-zz-custom.sh  （首次启动时执行一次，随后自动删除）
# 目标: immortalwrt 25.12.2 / x86/64 / generic
# ============================================================
LOGFILE="/etc/config/firstboot-custom.log"
echo "=== $(date) start ===" >>"$LOGFILE"

# ---------- 1. 主机名 / 时区 ----------
uci -q set system.@system[0].hostname='SJGWrt'
uci -q set system.@system[0].timezone='CST-8'
uci -q set system.@system[0].zonename='Asia/Shanghai'

# ---------- 2. 管理密码 + 登录用户 ----------
# 注意: hash 一律用单引号包起来——含 $1$ 的 md5crypt 一旦进双引号会被 shell 当成位置参数
ROOT_HASH='$1$xzFoXX9z$yYL4ymR88YvLurZKj4K611'
if [ -n "$ROOT_HASH" ]; then
  sed -i "s#^root:[^:]*:#root:${ROOT_HASH}:#" /etc/shadow
  echo "root password set" >>"$LOGFILE"
fi
USER_HASH='$1$DknqqfFy$RAY3Ap1HD6IB02W.3grAT1'
LOGIN_NAME='sjg'
if [ -n "$USER_HASH" ] && [ -n "$LOGIN_NAME" ]; then
  # 已存在则改密，不存在则建普通 login shell 用户
  if grep -q "^$LOGIN_NAME:" /etc/passwd; then
    sed -i "s#^$LOGIN_NAME:[^:]*:#$LOGIN_NAME:x:#" /etc/passwd
    sed -i "s#^$LOGIN_NAME:[^:]*:#$LOGIN_NAME:${USER_HASH}:#" /etc/shadow
  else
    LAST_UID=$(awk -F: '$3>=1000 && $3<60000 { if ($3>m) m=$3 } END { print (m?m:999) }' /etc/passwd)
    NEW_UID=$((LAST_UID + 1))
    echo "$LOGIN_NAME:x:$NEW_UID:$NEW_UID::/home/$LOGIN_NAME:/bin/ash" >>/etc/passwd
    echo "$LOGIN_NAME:x:$NEW_UID:" >>/etc/group
    echo "$LOGIN_NAME:$USER_HASH:$(( $(date +%s) / 86400 )):0:99999:7:::" >>/etc/shadow
    mkdir -p "/home/$LOGIN_NAME" && chown "$NEW_UID:$NEW_UID" "/home/$LOGIN_NAME"
  fi
  echo "user $LOGIN_NAME ready" >>"$LOGFILE"
fi

# ---------- 3. Wan 区防火墙默认放行（方便首次调试；稳定后请改成 reject）----------
uci -q set firewall.@zone[1].input='REJECT'

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

# 自动分配：第一个网口做 WAN，其余进 LAN
WAN_IF=$(echo "$ifnames" | awk '{print $1}')
LAN_IFS=$(echo "$ifnames" | cut -d' ' -f2-)

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

  uci -q set network.wan.proto='dhcp'
  uci -q set network.wan6.proto='dhcpv6'

  # br-lan: 找到 bridge device section 并重写成员端口
  BRSEC=$(uci show network | awk -F'[.=]' '/\.@?device\[[0-9]+\]\.name=.br-lan.$/ {print $2; exit}')
  if [ -n "$BRSEC" ]; then
    uci -q delete "network.$BRSEC.ports"
    for p in $LAN_IFS; do uci -q add_list "network.$BRSEC.ports=$p"; done
  else
    uci -q del_list network.lan.device='br-lan'
    for p in $LAN_IFS; do uci -q add_list "network.br_lan.ports=$p"; done
  fi

  uci -q set network.lan.proto='static'
  uci -q set network.lan.ipaddr='192.168.6.1'
  uci -q set network.lan.netmask='255.255.255.0'
fi
uci -q commit network

# ---------- 4.5 旁路由（旁路网关）模式 ----------
# 主路由模式，跳过

# ---------- 5. IPv6 ----------
# 开启 IPv6：LAN 侧 server 模式 + WAN 侧 dhcpv6 客户端 solicit 全部前缀级别
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
uci -q set dhcp.@dnsmasq[0].dnsforwardmax='1500'
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
  for idx in $(uci show firewall | grep '=forwarding' | sed 's/.*\[\([0-9]*\)\].*/\1/' | sort -rn); do
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
# 无

uci -q commit network
uci -q commit system
uci -q commit firewall
echo "=== $(date) done ===" >>"$LOGFILE"
exit 0
