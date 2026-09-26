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
| GET | `/api/images?distro=&version=&target=&sub=&profile=` | 官方预编译固件清单（基于上游 sha256sums，附 SHA256 + 用途标签） |
| GET | `/api/ib?...&target=&sub=` | ImageBuilder 真实下载地址探测 |
| GET | `/api/imm-plugins?series=` | 内置的版本专属插件清单 |
| POST | `/api/repo/test` | 校验第三方软件源是否可用 |
| POST | `/api/validate` | 包名可用性 / PPPoE 必填 / 分区容量 等校验 |
| POST | `/api/preview` | 生成全部产物预览 |
| POST | `/api/zip` | 打包下载 |
| GET/POST | `/api/preset/*` | 预设存取 |
| GET/POST | `/api/build/config` | 在线构建凭据：`owner/repo` + Token（**读接口不回显 Token**） |
| POST | `/api/build/start` | 生成构建包 → 推到专属分支 → 触发 Actions 运行，返回任务 id |
| GET | `/api/build/status?id=` | 查询进度（job/step 级）；运行结束后自动拉回 Artifacts 与失败日志 |
| GET | `/api/build/list` | 历史在线构建 |
| GET | `/api/build/file?id=&name=` | 下载已拉回本地的产物 zip |

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
- **ImageBuilder 对未知包是硬失败**（`package not found`，不是警告）：生成时若某包不在该版本官方索引里、
  且你没配第三方源，它会从 `PACKAGES=` 里剔除，并在 `PACKAGES.txt` 里留痕（`× 包名`）——不静默丢包。
  配了第三方源则一律保留（那些包可能正由第三方源提供）
- 源码全编译按实测 **≈50GB** 估算磁盘，与生成的脚本里「可用磁盘 <50GB 直接退出」的硬校验一致
  （免费 runner 只有 ~14GB，所以源码档的 Actions 工作流跑 `self-hosted`）
- root 密码用 md5crypt，且哈希**必须用单引号**赋值（`$1$` 进双引号会被 shell 当成位置参数，导致密码损坏）

上述最后一条已交叉验证：生成的哈希与 `openssl passwd -1 -salt <salt>` 逐字符一致。

## 参考来源

- 你的私有参考实现 `sunjg789/my-immortalwrt`（云端 ImageBuilder 工作流）——本项目的 ImageBuilder 引擎即按它的机制实现
- 你的公开插件清单 `sunjg789/sjg-openwrt-packages`（`plugins.conf`，46 条第三方插件带真实上游地址）
- 上游实时元数据：`downloads.openwrt.org`、`downloads.immortalwrt.org`

## 在线构建闭环（站内一键 → GitHub Actions → 产物回本地）

第 6 步的「在线构建」把上面第三条路做成了闭环，不用手动 fork / 手动推工作流：

```
填一次 owner/repo + Token → 点「开始在线构建」
  ① 生成构建包（含 .github/workflows/*.yml）
  ② Git Data API 推到孤儿分支 build/<distro>-<ver>-<target>-<sub>-<stamp>
  ③ 触发运行（dispatch 优先，push 兜底）
  ④ 每 5 秒轮询 job / step 进度，前端按步骤着色
  ⑤ 运行结束 → 自动把 Artifacts 拉回 out/builds/<id>/，页面上直接「下载到本地」
  ⑥ 若失败 → 拉回云端日志，面板里摊开报错摘要 + 可折叠的日志尾部
```

落地时有几个坑，都已固化在代码里（`lib/gh.js` / `lib/build.js`）：

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `workflow_dispatch` 返回 404 | **只认默认分支上注册的工作流**，推到临时分支的 yml 一律不认 | 先探测 `isRegisteredOnDefault()`，未注册就走 `push` 触发器（此时**不能**加 `[skip ci]`） |
| 加了 `[skip ci]` 后一个 run 都没有 | 注册状态未必准确，dispatch 说成功但没跑 | 轮询不到 run 时自动去掉 `[skip ci]` 再推一次兜底 |
| 明明跑完了却查不到 run | 用 `created>=` 过滤时，本机 `Date.now()` 与 GitHub `created_at` 有偏差 | **完全不用时间过滤**，取该独享分支最新的 run |
| 两个 run 同时跑，分钟数翻倍 | push 触发器与 dispatch 各起一个 | 走 dispatch 时才带 `[skip ci]` |
| Artifact 下载 302 拿到 HTML | REST 接口返回跳转地址 | 手动跟 `Location`，并校验 zip 魔数 `PK` |
| 失败只见 `Process completed with exit code 2` | 真正的报错埋在几百行 make 输出里 | 拉 `/actions/runs/<id>/logs`（**零依赖手写 ZIP 解析**），提炼报错行后在前端显示 |
| 大产物下载到一半 `terminated` | Node 的 `fetch` **不读 `HTTP_PROXY`**，且整包流式下载中途断掉就前功尽弃 | 改成 **Range 分片 + 断点续传 + 逐片重试**，先 `Range: bytes=0-0` 探总长，再按 4MB 一片写入 |
| 续传到一半全部报 **HTTP 403** | 下载直链是 **Azure 的短期 SAS 令牌**，十几分钟就失效；旧链接重试多少次都没用 | 每次重试都重新向 REST 取一张新票（`artifactZipUrl()`）再续下 |
| 点了状态半天不返回 | 回传大产物把请求线程占住了 | 回传改为**后台任务**，状态接口立刻返回，进度写进 `meta.json`，前端每 5 秒刷新「已回传 24.0 / 168.0 MB」 |
| 本地下载按钮对上百 MB 的文件不友好 | 原来整包读进内存后再吐，且忽略 Range | 改成流式 + `Accept-Ranges`，支持 206 / 416，浏览器断线可续 |

产物体积与回传速度是这闭环里唯一不适合"等一下就好"的部分，目前是这样收敛的：

- 云端默认**关闭虚拟磁盘格式**（`CONFIG_QCOW2/VDI/VMDK/VHDX_IMAGES=n`）：单实例 x86/64 产物从 **386MB 降到 168MB**，省掉的一半几乎全是 qcow2/vdi/vmdk/vhdx。
- 回传是**可中断可续传**的：关掉页面、甚至重启服务，下次轮询都会从已落盘的位置继续。
- 面板显示回传百分比；回传中不会给出"下载"按钮，避免下到半截的 zip。

依赖也是我们踩出来的补齐项（`lib/genib.js` 的 apt 那一步）：

- `qemu-utils` → 提供 `qemu-img`。x86 目标会顺带产出 qcow2/vdi/vmdk/vhdx，缺了它 make 在**最后一步**才 `Error 1`，整轮白跑。
- `genisoimage` + `mkisofs` 软链 → 产出 ISO 那一步写死了 `mkisofs`，而 Ubuntu 22.04 **根本没有叫 `mkisofs` 的包**（写了会让整段 `apt-get install` 失败），所以只能装 `genisoimage` 再补链接。

## 为什么站点本身不直接吐固件？

因为**编译这件事在 Windows 上跑不了**：

- OpenWrt 官方明确只支持 **GNU/Linux（原生或虚拟化）**，macOS 与 WSL 都属于「有人成功但非官方支持」；
  官方文档更直接点名——**不要**在 Windows 原生文件系统上构建（大小写不敏感会导致诡异失败）。
- 源码全编译需要 50GB 磁盘与 1~3 小时；ImageBuilder 虽然只要分钟级，但它的分发包
  `…-Linux-x86_64.tar.zst` **只能跑在 x86_64 Linux 上**。
- 所以本站定位是「**生成器**」：把你的选择固化成一整套可在 Linux 上执行的构建脚本，
  而不是在本机调用交叉工具链。

要拿到固件，有三条路：

| 方式 | 得到什么 | 怎么用 |
|---|---|---|
| **第 3 步「官方预编译固件」直下** | 上游现成镜像，**不含你勾选的插件** | 选完设备后点击下载，附 SHA256 可校验 |
| **把构建包丢给 Linux 主机** | 带自定义插件的完整固件 | 下载 ZIP → 在 Linux/云主机上 `bash build.sh` |
| **GitHub Actions 在线编译** | 带自定义插件的完整固件，不用自己备机器 | 第 6 步「在线构建」填一次仓库 + Token，站点自动推分支、触发、轮询并把 Artifacts 拉回本地（详见下一章） |

第一条已在本站实现，数据源是上游 `sha256sums`（**不是** `profiles.json` 的 `images[]`——
后者缺 `.gz` 后缀，实测会 404）。

## 当 `git push` 用不了：`tools/push-via-api.js`

某些受限环境（沙箱 / 受限终端）里，`git push` 会直接被杀掉、`ls-remote` 却正常，Node 里
`spawnSync('git', …)` 还会报 `EBUSY`。这时还能用 REST 通道把本地 HEAD 推上去：

```bash
git rev-parse HEAD > tmp-head-sha.txt
git ls-tree -r HEAD > tmp-ls.txt
git cat-file commit HEAD > tmp-commit.txt
git rev-parse "HEAD^{tree}" > tmp-root-tree.txt
node tools/push-via-api.js
```

脚本自己重建 blob → tree → commit 再更新 ref。因为 **Git 对象的 sha 由内容决定**，只要
tree / parent / author / committer / message 全部对齐，远端生成的 commit 会和本地 HEAD
**是同一个 sha**。

两个踩过的坑，脚本里已经处理了：

- **树条目必须排序**，目录按「名字 + `/`」参与比较；顺序错了根树 sha 就对不上（子树却是对的，很难查）。
- `git archive` 会按 `.gitattributes` **反向出差换行**，拿它导出再上传会得到另一个 blob；
  脚本直接读工作区文件，并在 sha 对不上时自动试 LF / CRLF 两种还原。

## 已知边界

- 站点只做**生成**，不实际执行编译；编译由产出的 `build.sh` / `.github/workflows/*.yml` 在 Linux 侧完成
- 第 3 步下载的官方固件是**未经定制的原版**，插件/网络配置要刷完后手动安装
- 在线构建的 Token 明文存在 `config/gh.json`（该目录已在 `.gitignore`），用完建议在 GitHub Settings 里吊销
- 在线构建会把每个任务推成一个 `build/*` 分支，跑完要手动删，否则仓库里分支会越攒越多
- ImageBuilder **只能打包软件源里真实存在的包**。第三方插件需要先在「第三方软件源」里配上对应仓库根目录
- 资源估算是经验量级，用于可行性判断，不是承诺
- 服务只监听 `127.0.0.1`，无鉴权；要放局域网请自行加反代
