# ImmortalWrt 25.12.2 · x86/64 · generic

由 **ImageBuilder 引擎**生成 —— 不编译源码，只做打包，正常 3~10 分钟出固件。

## 构建参数

| 项 | 值 |
|---|---|
| 发行版 | ImmortalWrt (immortalwrt) |
| 版本 | 25.12.2 |
| 目标 | x86 / 64 |
| 设备 PROFILE | generic |
| 包架构 | x86_64 |
| 根分区大小 | 256 MB |
| 管理地址 | 192.168.3.112 |
| WAN 协议 | dhcp |
| IPv6 | 开启 |
| 包数量 | 31 |

## 跑起来

```bash
chmod +x build.sh
bash build.sh
```

产物落在 `bin/` 下。

## 三种路径怎么选

| 路径 | 耗时 | 磁盘 | 能做什么 |
|---|---|---|---|
| **本脚本（ImageBuilder）** | 3~10 分钟 | < 2GB | 增删随镜像自带的包、改默认配置、附加第三方软件源 |
| 源码全编译 | 1~3 小时 | ≈ 50GB | 改内核配置、改驱动、编译官方源里没有的软件 |
| Docker 容器化 IB | 5~15 分钟 | < 2GB | 不想在本机装依赖时的等价路径 |

**结论：只想「选设备 + 挑插件 + 预配置」时，ImageBuilder 是唯一合理选择。**
只有需要改内核选项 / 编译第三方源码时才有必要动全编译。

## 关键约束（必须遵守）

1. **路径不能有空格**，文件系统要区分大小写；WSL2 请放在 ext4 分区，不要放 `/mnt/c` 后再软链。
2. **禁止 root / sudo** 构建。
3. **不要并发跑两份 make**（会互删 .o）——本脚本已用 `flock` 加单实例锁。
4. 环境里不能设 `SED`、`GREP_OPTIONS`；`which` 不能被 alias 掉。

## 排障速查

### 1. `unterminated call to function 'shell'`
GNU make 4.2.1 的已知缺陷：它把 `$(shell ...)` 里的 `#` 当成注释。必须 make >= 4.3：

```bash
make --version | head -1          # 需 >= 4.3
wget https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz
tar -xf make-4.4.1.tar.gz && cd make-4.4.1
./configure --prefix=/usr/local && make -j$(nproc) && sudo make install
hash -r && make --version         # 确认已切到 4.4.1
```

### 2. Ubuntu 26.04+：`prerequisite check failed`
默认 coreutils 是 Rust 版 uutils，`install --version` 打印 `(uutils coreutils)`，
而 OpenWrt 的 `include/prereq-build.mk` 用 grep 找 `GNU`；它兜底的 `ginstall` 在 Ubuntu 里叫 `gnuinstall`。

```bash
sudo apt-get install -y gnu-coreutils
# 找到实际二进制名并链过去
ls /usr/bin | grep -i install
sudo ln -sf <实际路径> /usr/local/bin/gnuinstall
```
**不要用 `FORCE=1` 跳过预检**——那只是把问题推到后面，报错会更难读。

### 3. `PROFILE=... does not exist`
先打印真实列表，注意 profile 名是小写、下划线连写的机器名：

```bash
make info | grep -E '^[a-z0-9_]+:'
```

### 4. 装不上某个包（`package not found`）
ImageBuilder **只能装peluch该版本软件源里真实存在的包**。第三方包必须先有对应的软件源。
把第三方源填到 `repositories.conf` 后再重新 `make image`。

### 5. `make: TMPDIR value ...: No such file`
这行是**警告不是错误**。判断成败要看倒查 20 行：

```bash
tail -20 <日志>
```

## 首次登录

- 后台：http://192.168.3.112
- 用户名 `root`，或 `sunjg789`
- 密码已预置
- WAN 区入站已是「拒绝」
