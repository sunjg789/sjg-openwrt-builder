# OpenWrt / ImmortalWrt 固件定制站（本地版）

> 跑在本机的「类 openwrt.ai」在线定制站：**双发行版 · 全部设备 · 任意版本 · 插件随版本自动变换**。
> 零第三方依赖（只用 Node 内置模块），所有元数据**实时抓取自上游官方下载服务器**并落盘缓存。

## 启动

```bash
git clone https://github.com/sunjg789/sjg-openwrt-builder.git
cd sjg-openwrt-builder
node server.js
# 浏览器打开 http://127.0.0.1:8730
```

Windows 双击 `start.bat`。改端口：`PORT=9000 node server.js`。

首次访问需要联网向 `downloads.openwrt.org` / `downloads.immortalwrt.org` 抓取元数据，
抓到后会缓存在 `cache/`，之后离线也能用缓存过的版本。

> 若 `git push` 报 `CRYPT_E_REVOCATION_OFFLINE`，是 Windows Git 的 schannel 在你所在网络下
> 查不到证书吊销列表，换 OpenSSL 后端即可：`git config http.sslBackend openssl`。

## 自检

后端（零依赖，服务需先启动）：

```bash
node selftest2.js   # 双发行版 × 双引擎 端到端
node selftest3.js   # 多设备树 / 版本差异 / 首启脚本哈希完整性
```

前端（需要 jsdom，服务需先启动）：

```bash
npm i jsdom            # 或 NODE_PATH 指向已装 jsdom 的目录
node selftest-ui.js
```

`selftest-ui.js` 用 jsdom 加载真实的 `index.html` + `app.js`，覆盖七组用例：静态首屏、首屏即时性、
版本→设备→插件加载链、运行时错误、**切换发行版联动**、步骤导航与预览生成、**上游不可用时的降级**。
最后一组是回归用例——曾经因为服务端不可达时返回 `profiles:{}`（对象，无法被 `|| []` 兜住）
导致 `for...of` 抛 TypeError，整条加载链崩掉。

> 注：早期版本的 `selftest.js` 依赖已被重构掉的 `./lib/catalog`，已删除；其职责由 `selftest2/3-ui` 接管。

## 三条核心能力（对应「定制站不够全面」的三个问题）

| 原来的问题 | 现在的做法 | 实测结果 |
|---|---|---|
| 不能选其它设备 | 逐层实时拉取 `targets/` → `subtargets/` → `profiles.json` | ImmortalWrt 25.12.2 → **44 个 CPU 架构**；OpenWrt 23.05.5 ath79/generic 单目标就有 **349 个机型** |
| 不能在 ImmortalWrt / OpenWrt 之间自由选版本 | 双发行版独立数据源 + 各自的版本目录解析 | ImmortalWrt **31 个版本**（18.06 ～ 25.12-SNAPSHOT）；OpenWrt **89 个版本**（17.01 ～ 25.12.5） |
| 插件不能随版本变换 | 每个版本的软件索引（`index.json` / `Packages.gz`）现场解析出真实存在的包 | 25.12.5 自带 **1020** 个 luci 应用 vs 23.05.5 自带 **647** 个；仅新版有 498 个、仅旧版有 125 个 |

## 两条构建引擎

| 引擎 | 耗时 | 磁盘 | 适用场景 |
|---|---|---|---|
| **ImageBuilder（默认）** | 3~10 分钟 | < 2GB | 选设备 + 挑插件 + 预配置。**99% 的需求走这条** |
| **源码全编译** | 1~3 小时 | ≈ 50GB | 官方与第三方都没有预编译包 / 要改内核选项 / 要产出自己的 SDK |

ImageBuilder 之所以能支持「任意设备 × 任意版本」，是因为上游为**每个版本的每个子目标**都发布了对应的打包工具（内含该版本的全部包与内核模块），不需要重编译任何东西。

生成器会自动探测真实可用的压缩包，并处理不同时代的后缀差异：

```
25.12.x  → *.tar.zst
24.10.x  → *.tar.zst
23.05.x  → *.tar.xz      ← 多格式回退已在 23.05.5 上实测通过
```

## 六步向导

1. **发行版** — ImmortalWrt / OpenWrt 官方
2. **版本** — 按系列分组；可选「锁定 tag（可复现）」或「跟踪维护分支（含后续补丁）」
3. **设备** — target → subtarget → profile，带机型关键字搜索
4. **插件** — 随所选版本动态变化，三类来源都标注清楚：
   - `第三方源码`：只有源码、必须编译（来自插件清单，每项都带真实上游 git 地址）
   - `官方源有` / `部分缺失` / `该版本源没有`：按当前版本的软件索引实时判定
   - `版本自带`：该版本软件源里未被精选清单覆盖的其它 luci 应用
5. **系统定制** — 主机名 / 用户 / 密码 / LAN / WAN（DHCP / PPPoE / 静态）/ 旁路由 / 网口指定 / IPv6 / 分区尺寸 / 附加脚本
6. **生成** — 实时预览全部产物，直接下载 ZIP

## 目录

```
openwrt-custom-builder/
├── server.js              零依赖 HTTP 服务 + 全部 API
├── selftest2.js           端到端自检（双发行版 × 双引擎）
├── selftest3.js           广度自检（多设备树 / 版本差异 / 哈希完整性）
├── selftest-ui.js         前端冒烟（jsdom 真实 DOM：首屏 / 加载链 / 交互 / 降级）
├── start.bat              Windows 双击启动
├── data/
│   └── imm-plugins.json   内置的版本专属插件清单（imm 24.10 / 25.12）
├── cache/                 上游元数据缓存（自动生成，可随时删除）
├── out/                   自检产出的样例工程
├── lib/
│   ├── distros.js         双发行版定义 + 版本→git 引用映射 + CONFIG 符号规则
│   ├── upstream.js        实时抓取层 + 磁盘缓存（版本/设备树/软件索引/feeds）
│   ├── imagebuilder.js    ImageBuilder 压缩包探测（Range 请求 + 多后缀回退）
│   ├── plugins.js         插件注册表（第三方源码 + 官方精选 + 版本动态发现）
│   ├── genib.js           ImageBuilder 引擎生成器
│   ├── gensrc.js          源码全编译引擎生成器
│   ├── hash.js            md5crypt（已与 openssl passwd -1 对拍一致）
│   └── zip.js             store 模式 ZIP 打包（无第三方依赖）
├── public/                前端（原生 HTML/CSS/JS）
└── presets/               保存的预设
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/distros` | 发行版列表 |
| GET | `/api/versions?distro=` | 全部可用版本（按系列分组） |
| GET | `/api/targets?distro=&version=` | CPU 架构列表 |
| GET | `/api/subtargets?...&target=` | 子架构列表 |
| GET | `/api/profiles?...&target=&sub=` | 设备 profile 列表（含 package 架构 / 内核版本 / 设备专属包） |
| GET | `/api/packages?...&arch=` | 该版本软件索引 + 可用插件清单 |
| GET | `/api/ib?...&target=&sub=` | ImageBuilder 真实下载地址探测 |
| GET | `/api/imm-plugins?series=` | 内置的版本专属插件清单 |
| POST | `/api/repo/test` | 校验第三方软件源是否可用 |
| POST | `/api/validate` | 包名可用性 / PPPoE 必填 / 分区容量 等校验 |
| POST | `/api/preview` | 生成全部产物预览 |
| POST | `/api/zip` | 打包下载 |
| GET/POST | `/api/preset/*` | 预设存取 |

## 生成器里已固化的排障规则（全部来自实测，不是猜测）

- `make download` 必须在 `make -j N` 之前（并行下载会撞坏校验）
- `tmp/.packageinfo` 竞态：自检「行数 >1000 且重复定义 ≤20」，不合格 `rm -rf tmp` 重来，最多 3 轮
- 内核包重复定义必须为 0，否则会引发成片的 `recursive dependency detected`
- GNU make <4.3 会把 `$(shell ...)` 里的 `#` 当注释 → 预检直接拦
- Ubuntu 26.04+ 的 uutils `install` 让 prereq 失败 → 要求 `gnu-coreutils` + `gnuinstall` 软链；**不用 `FORCE=1` 掩盖**
- `flock` 单实例锁，且**日志重定向必须在拿到锁之后**
- ccache 必须配 `CONFIG_DEVEL=y`；缓存目录在源码树根 `.ccache` 而非 `~/.ccache`
- 第三方 feed 一律指名 install，杜绝 `feeds install -a`
- 换 branch/tag 前必须 `make distclean`
- root 密码用 md5crypt，且哈希**必须用单引号**赋值（`$1$` 进双引号会被 shell 当成位置参数，导致密码损坏）

上述最后一条已交叉验证：生成的哈希与 `openssl passwd -1 -salt <salt>` 逐字符一致。

## 参考来源

- 你的私有参考实现 `sunjg789/my-immortalwrt`（云端 ImageBuilder 工作流）——本项目的 ImageBuilder 引擎即按它的机制实现
- 你的公开插件清单 `sunjg789/sjg-openwrt-packages`（`plugins.conf`，46 条第三方插件带真实上游地址）
- 上游实时元数据：`downloads.openwrt.org`、`downloads.immortalwrt.org`

## 已知边界

- 站点只做**生成**，不实际执行编译；编译由产出的 `build.sh` / `.github/workflows/*.yml` 在 Linux 侧完成
- ImageBuilder **只能打包软件源里真实存在的包**。第三方插件需要先在「第三方软件源」里配上对应仓库根目录
- 资源估算是经验量级，用于可行性判断，不是承诺
- 服务只监听 `127.0.0.1`，无鉴权；要放局域网请自行加反代
