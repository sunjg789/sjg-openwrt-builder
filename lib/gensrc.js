'use strict';
/**
 * gensrc.js — 源码全编译引擎的产物生成器（与 ImageBuilder 引擎并列）
 *
 * 适用前提：
 *   官方/第三方都没有该版本的预编译包（比如要改内核选项、要编 openclash 这种只有源码的插件）。
 *   代价：首编 1~3 小时、磁盘约 50GB。能用 ImageBuilder 就不要走这条路。
 *
 * 优先级处理的关键点（全部来自实测结论）：
 *   - make download 必须在 make -j 之前；并行下载会撞坏校验
 *   - 第三方 feed 走 src-link/直接 clone，且**不要 scripts/feeds install -a**（会拉入冲突依赖）
 *   - 依赖传递链里的 `select X if X<Y` 只提升 m→y，不会凭空启用 X，所以依赖要显式写出
 *   - 切换 branch/tag 后必须 make distclean
 */
const { DISTROS, releaseRoot, gitRefInfo, deviceSymbol, targetSymbols, seriesOf } = require('./distros');
const { getFeedsBuildinfo } = require('./upstream');
const { THIRD_PARTY, OFFICIAL_EXTRA } = require('./plugins');
const { buildUciScript } = require('./genib');

function uniq(a) { return Array.from(new Set(a.filter(Boolean))); }

/** 选出本次要编译的第三方插件（按 dirs/upstream 去重聚合） */
function pickThirdParty(selectedPkgNames) {
  const want = new Set(selectedPkgNames);
  return THIRD_PARTY.filter((p) => (p.pkgs || []).some((n) => want.has(n)));
}

function buildFeedsConf(spec, officialFeeds) {
  const lines = [
    '# 官方 feeds —— URL 与 commit 均取自该版本上游的 feeds.buildinfo，保证 ABI 一致',
  ];
  for (const f of officialFeeds) {
    if (f.commit) lines.push(`src-git-full ${f.name} ${f.url}^${f.commit}`);
    else lines.push(`src-git-full ${f.name} ${f.url}`);
  }
  lines.push('');
  lines.push('# 第三方 feeds（按勾选的插件动态追加，见 clone-plugins.sh）');
  return lines.join('\n') + '\n';
}

function buildClonePlugins(spec, third) {
  const smallDirs = uniq(third.filter((p) => p.smallpkg).flatMap((p) => p.dirs));
  const lines = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# 克隆本次勾选的第三方插件源码到 package/ 下');
  lines.push('# 依据 sunjg789/sjg-openwrt-packages 的 plugins.conf（含真实上游仓库与编译目标）');
  lines.push('set -uo pipefail');
  lines.push(`cd "\${1:-.}" || exit 1`);
  lines.push('mkdir -p package');
  lines.push('');
  for (const p of third) {
    if (p.smallpkg) continue; // small-package 统一走稀疏拉取
    lines.push(`# ${p.label} —— ${(p.desc || '').replace(/\|/g, '/')}`);
    lines.push(`if [ ! -d package/${p.dirs[0]} ]; then`);
    lines.push(`  git clone --quiet --depth 1 --single-branch ${p.upstream} package/${p.dirs[0]} \\`);
    lines.push(`    || git clone --quiet --depth 1 ${p.upstream} package/${p.dirs[0]} \\`);
    lines.push(`    || echo "  !! clone 失败: ${p.dirs[0]}"; `);
    lines.push(`else echo "  · 已存在 ${p.dirs[0]}，跳过"; fi`);
    lines.push('');
  }
  for (const p of third) {
    for (const dep of p.extraRepos || []) {
      for (const d of dep.dirs) {
        lines.push(`# 依赖仓库: ${(p.label)} 需要 ${d}`);
        lines.push(`if [ ! -d package/${d} ]; then git clone --quiet --depth 1 --single-branch ${dep.upstream} package/${d} || echo "  !! clone 失败: ${d}"; fi`);
      }
    }
  }
  if (smallDirs.length) {
    lines.push('# ---- kenzok8/small-package 稀疏拉取（只取需要的目录，不全量 clone）----');
    lines.push('SMALL_DIRS=(' + smallDirs.map((d) => `'${d}'`).join(' ') + ')');
    lines.push('if [ ! -d /tmp/smallpkg ]; then');
    lines.push('  git clone --quiet --depth 1 --filter=blob:none --sparse https://github.com/kenzok8/small-package.git /tmp/smallpkg \\');
    lines.push('    || git clone --quiet --depth 1 https://github.com/kenzok8/small-package.git /tmp/smallpkg || echo "  !! small-package clone 失败"');
    lines.push('fi');
    lines.push('if [ -d /tmp/smallpkg ]; then');
    lines.push('  (cd /tmp/smallpkg && git sparse-checkout set "${SMALL_DIRS[@]}") 2>/dev/null || true');
    lines.push('  for d in "${SMALL_DIRS[@]}"; do');
    lines.push('    if [ -d "/tmp/smallpkg/$d" ] && [ ! -d "package/$d" ]; then cp -r "/tmp/smallpkg/$d" package/; echo "  ✓ smallpkg: $d"; fi');
    lines.push('  done');
    lines.push('fi');
    lines.push('');
  }
  lines.push('echo "第三方源码就绪: $(ls package | tr \'\\n\' \' \')"');
  return lines.join('\n') + '\n';
}

function buildConfigSeed(spec, officialFeeds) {
  const [t, s] = [spec.target, spec.subtarget];
  const d = DISTROS[spec.distro] || {};
  const L = [];
  L.push('# ============================================================');
  L.push(`# ${d.name} ${spec.version} · ${t}/${s} · ${spec.profile}`);
  L.push('# 用法: cp config.seed openwrt/.config && make defconfig');
  L.push('# ============================================================');
  L.push('');
  L.push('# ---- 目标与设备（符号名已与同版本 config.buildinfo 逐字段核对）----');
  L.push(...targetSymbols(t, s));
  L.push(`${deviceSymbol(t, s, spec.profile)}=y`);
  L.push('CONFIG_TARGET_MULTI_PROFILE=n');
  L.push('CONFIG_TARGET_ALL_PROFILES=n');
  L.push('CONFIG_HAS_SUBTARGETS=y');
  L.push('');
  L.push('# ---- 根文件系统 ----');
  L.push('CONFIG_TARGET_ROOTFS_EXT4FS=y');
  L.push('CONFIG_TARGET_ROOTFS_SQUASHFS=y');
  L.push('CONFIG_TARGET_ROOTFS_TARGZ=n');
  const size = spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB : 1024;
  L.push(`CONFIG_TARGET_KERNEL_PARTSIZE=${spec.image && spec.image.kernelSizeMB ? spec.image.kernelSizeMB : 32}`);
  L.push(`CONFIG_TARGET_ROOTFS_PARTSIZE=${size}`);
  L.push('');
  L.push('# ---- 构建工具链产物：SDK / ImageBuilder / Toolchain 一并产出，便于后续秒级迭代 ----');
  L.push('CONFIG_IB=y');
  L.push('CONFIG_SDK=y');
  L.push('CONFIG_MAKE_TOOLCHAIN=y');
  L.push('CONFIG_ALL_KMODS=n');
  L.push('CONFIG_AUTOREMOVE=n');
  L.push('');
  L.push('# ---- ccache：必须连 DEVEL 一起开，否则 defconfig 会把 CCACHE 抹掉 ----');
  L.push('CONFIG_DEVEL=y');
  L.push('CONFIG_CCACHE=y');
  L.push('# 注意：默认缓存目录是源码树根的 .ccache，不是 ~/.ccache');
  L.push('');
  L.push('# ---- 本次勾选的包 ----');
  for (const p of spec.packages || []) L.push(`CONFIG_PACKAGE_${p.replace(/-/g, '_')}=y`);
  L.push('');

  if (officialFeeds && officialFeeds.length) {
    L.push('# ---- 本次锁定使用的官方 feeds（来自该版本 feeds.buildinfo）----');
    for (const f of officialFeeds) L.push(`# ${f.name}: ${f.url}${f.commit ? ' @ ' + f.commit : ''}`);
    L.push('');
  }
  const third = pickThirdParty(spec.packages || []);
  if (third.length) {
    L.push('# ---- 第三方插件（源码由 clone-plugins.sh 拉取，此处只声明要编译）----');
    for (const p of third) {
      L.push(`# ${p.label}: ${p.compile}${p.compile === '-' ? '（只克隆不单独编译，依赖自动解析）' : `  ← ${p.upstream}`}`);
      for (const n of p.pkgs) L.push(`CONFIG_PACKAGE_${n.replace(/-/g, '_')}=y`);
    }
    L.push('');
  }
  // 排除项
  for (const p of spec.excludes || []) L.push(`# CONFIG_PACKAGE_${p.replace(/-/g, '_')} is not set`);
  return L.join('\n') + '\n';
}

function buildSrcScript(spec, officialFeeds) {
  const d = DISTROS[spec.distro] || {};
  const ref = gitRefInfo(spec.distro, spec.version, spec.refPolicy || 'tag');
  const third = pickThirdParty(spec.packages || []);
  return `#!/usr/bin/env bash
# ============================================================
# 源码全编译 —— ${d.name} ${spec.version} · ${spec.target}/${spec.subtarget} · ${spec.profile}
# 源码引用: ${ref.refType} ${ref.refName}  —— ${ref.note}
# ============================================================
set -Eeuo pipefail

ROOT="\$(cd "\$(dirname "\$0")" && pwd)"
SRC="\${ROOT}/source"
LOCKFILE="\${ROOT}/.build.lock"
JOBS="\$(nproc 2>/dev/null || echo 4)"
JOBS="\$((JOBS + 1))"   # 并行度经验值 = 核数 + 1

log() { printf '\\033[36m[SRC]\\033[0m %s\\n' "\$*"; }
die() { printf '\\033[31m[错误]\\033[0m %s\\n' "\$*" >&2; exit 1; }

# ---- 单实例锁：两个并发 make 会互删 .o。拿到锁之后才能重定向日志。----
if command -v flock >/dev/null 2>&1; then
  exec 9>"\$LOCKFILE"
  flock -n 9 || die "已有构建进程在跑（锁: \$LOCKFILE）"
else
  log "未安装 flock，跳过单实例保护"
fi

log "环境自检"
[ "\$(id -u)" = "0" ] && die "禁止使用 root/sudo 构建"
case "\${SRC}" in *" "*) die "路径不能含空格";; esac
unset SED GREP_OPTIONS 2>/dev/null || true

MKVER="\$(make --version 2>/dev/null | head -1 | grep -oE '[0-9]+\\.[0-9]+' | head -1 || true)"
if [ -n "\$MKVER" ]; then
  MAJ="\${MKVER%%.*}"; MIN="\${MKVER##*.}"
  if [ "\$MAJ" -lt 4 ] || { [ "\$MAJ" -eq 4 ] && [ "\$MIN" -lt 3 ]; }; then
    die "GNU make \${MKVER} < 4.3：会把 \\\$(shell) 里的 # 当注释，报 unterminated call to function 'shell'。请先升级 make。"
  fi
fi

if command -v install >/dev/null 2>&1 && install --version 2>&1 | grep -qi uutils; then
  command -v gnuinstall >/dev/null 2>&1 || die "Ubuntu 26.04+ 的 uutils coreutils 缺 gnuinstall：sudo apt-get install -y gnu-coreutils 并链到 PATH"
  log "uutils 环境，gnuinstall 已就位"
fi

# ---- 1. 取源码 ----
if [ ! -d "\${SRC}/.git" ]; then
  log "克隆 ${d.gitBase} @ ${ref.refName}（--depth 1 --single-branch，省时省流量）"
  git clone --depth 1 --single-branch -b '${ref.refName}' ${d.gitBase} "\${SRC}" \\
    || die "克隆失败：确认引用存在 —— ${d.gitBase} (${ref.refType}=${ref.refName})"
else
  log "源码已存在，检查引用是否一致"
  CUR="\$(git -C "\${SRC}" rev-parse --abbrev-ref HEAD 2>/dev/null || git -C "\${SRC}" describe --tags 2>/dev/null || echo unknown)"
  if [ "\${CUR}" != "${ref.refName}" ]; then
    log "引用从 \${CUR} 切到 ${ref.refName} —— 切换会让既有 .o 失效，先 distclean"
    (cd "\${SRC}" && make distclean 2>/dev/null || true)
    git -C "\${SRC}" fetch --depth 1 origin '${ref.refName}' || true
    git -C "\${SRC}" checkout -f '${ref.refName}' || die "切换引用失败"
  fi
fi
cd "\${SRC}"

# ---- 2. feeds ----
if [ ! -s feeds.conf.default ]; then
  cp "\${ROOT}/feeds.conf.default" feeds.conf.default
fi
log "feeds update"
./scripts/feeds update -a
log "feeds install（逐指定安装，不用 -a，避免第三方依赖冲突）"
${officialFeeds.map((f) => `./scripts/feeds install ${f.name} || true`).join('\n')}

# ---- 3. 第三方插件源码 ----
${third.length ? `log "拉取第三方插件源码"
bash "\${ROOT}/clone-plugins.sh" "\${SRC}"` : 'log "未勾选第三方源码插件，跳过"'}

# ---- 4. 配置 ----
cp "\${ROOT}/config.seed" .config
log "make defconfig"
make defconfig

# 包索引竞态自检：为空或重复定义过多就 rm -rf tmp 重来，最多 3 轮
for round in 1 2 3; do
  LINES="\$(wc -l < tmp/.packageinfo 2>/dev/null || echo 0)"
  DUP="\$(grep -c '^Duplicate' <(sort tmp/.packageinfo 2>/dev/null | uniq -d) 2>/dev/null || echo 0)"
  log "第 \${round} 轮自检：tmp/.packageinfo 行数=\${LINES} 重复行=\${DUP}"
  if [ "\${LINES}" -gt 1000 ] && [ "\${DUP}" -le 20 ]; then break; fi
  log "索引异常，重建 tmp 后再 defconfig"
  rm -rf tmp
  make defconfig
done
if [ "\$(wc -l < tmp/.packageinfo 2>/dev/null || echo 0)" -lt 1000 ]; then
  die "tmp/.packageinfo 始终为空：多为某个第三方 feed 的 Makefile 违反了 OpenWrt 规范，逐个注释 feeds.conf 排查"
fi

# 内核包重复定义检查（会引发成片的 recursive dependency detected）
if [ -f tmp/info/.packageinfo-kernel_linux ]; then
  KDUP="\$(grep '^Package: ' tmp/info/.packageinfo-kernel_linux | sort | uniq -d | wc -l)"
  log "内核包重复定义数: \${KDUP}（必须为 0）"
  [ "\${KDUP}" -eq 0 ] || die "存在重复的内核包定义，检查是否有两份 kmod-* 源码（常见：同时挂了两个提供同名模块的 feed）"
fi

# ---- 5. 先下载，再并行编译（并行下载会撞坏校验，这是硬规矩）----
log "make download（先串行下载全部源码包）"
make download -j\${JOBS} V=s

log "开始编译 -j\${JOBS}"
ionice -c 2 -n 7 nice -n 10 make -j\${JOBS} V=s 2>&1 | tee "\${ROOT}/build.log"

# ---- 6. 产物 ----
OUT="\${ROOT}/bin"
mkdir -p "\${OUT}"
cp -r "\${SRC}/bin/targets/." "\${OUT}/" 2>/dev/null || true
log "产物："
find "\${OUT}" -maxdepth 3 -type f -printf '  %p  %s bytes\\n' | head -40
[ -d "\${SRC}/bin/targets" ] && log "同时已产出 ImageBuilder / SDK，后续可直接用 make image 秒级迭代"
`;
}

function buildSrcWorkflow(spec, officialFeeds) {
  const d = DISTROS[spec.distro] || {};
  const ref = gitRefInfo(spec.distro, spec.version, spec.refPolicy || 'tag');
  const third = pickThirdParty(spec.packages || []);
  return `name: SRC-${spec.distro}-${spec.version}-${spec.target}-${spec.subtarget}

# ⚠️ 源码全编译极其消耗资源：build_dir 单独就约 18~37GB，加上 staging_dir/dl/bin 合计约 50GB。
# GitHub 免费 runner 只有约 14GB SSD 且 6 小时封顶 —— 免费档跑不完这一档。
# 想用云端请满足以下任一条件：
#   1) 自建 runner（推荐：本机 WSL2/服务器，4 核 8G + 60GB 空闲磁盘起）
#   2) 付费大机型 runner
#   3) 大幅裁剪插件（尤其是移除 node/docker/netdata 这类 go/node toolchain 大户）
on:
  workflow_dispatch:

# 源码档同样只编译 + 上传产物，不回写仓库：显式声明最小权限，
# 不写的话会继承仓库默认（很多仓库默认给 GITHUB_TOKEN 写权限）。
permissions:
  contents: read

jobs:
  src:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4

      - name: 依赖
        run: |
          sudo apt-get update
          sudo apt-get install -y ack antlr3 asciidoc autoconf automake autopoint binutils bison build-essential \\
            bzip2 ccache clang cmake cpio curl device-tree-compiler ecj fastjar flex gawk gettext git \\
            gperf haveged help2man intltool libelf-dev libglib2.0-dev libgmp3-dev libltdl-dev \\
            libmpc-dev libmpfr-dev libncurses-dev libpython3-dev libreadline-dev libssl-dev \\
            libtool libz-dev lrzsz genisoimage msmtp nano ninja-build p7zip p7zip-full patch pkgconf \\
            python3 python3-pip python3-ply python3-docutils python3-pyelftools qemu-utils \\
            re2c rsync scons squashfs-tools subversion swig texinfo uglifyjs upx-ucl unzip \\
            vim wget xmlto xxd zlib1g-dev zstd
          # OpenWrt 的 Makefile 里 ISO 那一步写死 mkisofs，jammy 只有提供 genisoimage，
          # 且不存在名为 mkisofs 的包（写了会让整段 apt-get 失败）。
          command -v mkisofs >/dev/null 2>&1 || sudo ln -sf "$(command -v genisoimage)" /usr/local/bin/mkisofs

      - name: make 版本
        run: |
          make --version | head -1
          # 必须 >= 4.3，否则报 unterminated call to function 'shell'

      - name: 磁盘自检
        run: |
          df -h /  | tail -1
          AVAIL=$(df -Pk / | awk 'NR==2 {print int($4/1048576)}')
          echo "可用磁盘: \${AVAIL} GB"
          [ "\${AVAIL}" -ge 50 ] || { echo "::error::可用磁盘 \${AVAIL}GB < 50GB，必然中途失败"; exit 1; }

      - uses: actions/checkout@v4
        with:
          repository: ${d.gitBase.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
          ref: ${ref.refName}
          path: source
          fetch-depth: 1

      - name: feeds + 第三方源码
        run: |
          cd source
          cp ../feeds.conf.default feeds.conf.default
          ./scripts/feeds update -a
${officialFeeds.map((f) => `          ./scripts/feeds install ${f.name} || true`).join('\n')}
${third.length ? `          bash ../clone-plugins.sh "$PWD/source"` : '          echo "无第三方源码插件"'}

      - name: ccache 缓存
        uses: actions/cache@v4
        with:
          path: source/.ccache
          key: ccache-${spec.distro}-${spec.version}-${spec.target}-\${{ github.sha }}
          restore-keys: ccache-${spec.distro}-${spec.version}-${spec.target}-

      - name: 配置
        run: |
          cd source
          cp ../config.seed .config
          make defconfig
          # 包索引竞态：tmp/.packageinfo 可能被写成空/带重复定义，损坏会永久保留不自愈。
          # 只 wc -l 查不出重复定义（重复时行数反而更大），两项都得看。
          for round in 1 2 3; do
            LINES=$(wc -l < tmp/.packageinfo 2>/dev/null || echo 0)
            DUP=$(grep '^Package: ' tmp/.packageinfo 2>/dev/null | sort | uniq -d | wc -l)
            echo "第 $round 轮自检：行数=$LINES 重复定义=$DUP"
            [ "$LINES" -gt 1000 ] && [ "$DUP" -le 20 ] && break
            echo "::warning::包索引异常（行数 $LINES / 重复 $DUP），rm -rf tmp 后重建"
            rm -rf tmp
            make defconfig
          done
          [ "$(wc -l < tmp/.packageinfo 2>/dev/null || echo 0)" -gt 1000 ] || { echo "::error::tmp/.packageinfo 始终为空，多为某第三方 feed 的 Makefile 不合规范"; exit 1; }

      - name: 下载
        run: cd source && make download -j$(nproc) V=s

      - name: 编译
        run: cd source && make -j$(( $(nproc) + 1 )) V=s

      - name: 产物
        run: |
          mkdir -p out
          find source/bin/targets -type f \\( -name '*.img*' -o -name '*.bin' -o -name '*.gz' \\) -exec cp {} out/ \\; || true
          ls -lh out/

      - uses: actions/upload-artifact@v4
        with:
          name: firmware-src-\${{ github.run_id }}
          path: out/*
          if-no-files-found: warn
`;
}

function buildSrcReadme(spec, officialFeeds) {
  const d = DISTROS[spec.distro] || {};
  const ref = gitRefInfo(spec.distro, spec.version, spec.refPolicy || 'tag');
  const third = pickThirdParty(spec.packages || []);
  const size = spec.image && spec.image.rootfsSizeMB ? spec.image.rootfsSizeMB : 1024;
  return `# ${d.name} ${spec.version} · ${spec.target}/${spec.subtarget} · ${spec.profile}

**源码全编译**产物集。首编约需 1~3 小时、磁盘约 50GB。

> 若你的目的只是「选设备 + 挑插件 + 预配置」，请改用 **ImageBuilder 引擎**：3~10 分钟、<2GB，
> 且同样支持任意设备与任意版本。本路径只在下列情况才有必要：
> - 官方与第三方都没有该软件的预编译包
> - 需要改内核选项 / 打补丁 / 调驱动
> - 需要产出自己的 SDK 供别人二次开发

## 构建参数

| 项 | 值 |
|---|---|
| 发行版 | ${d.name}（\`${spec.distro}\`） |
| 版本 | ${spec.version}（${ref.refType} \`${ref.refName}\`） |
| 源码 | ${d.gitBase} |
| 目标 | ${spec.target} / ${spec.subtarget} |
| 设备 | ${spec.profile} |
| 根分区 | ${size} MB |
| 官方 feeds | ${officialFeeds.map((f) => f.name).join(', ') || '（未取到 feeds.buildinfo，使用源码内置默认）'} |
| 第三方插件 | ${third.length ? third.map((p) => p.label).join('、') : '无'} |

## 用法

\`\`\`bash
chmod +x build.sh clone-plugins.sh
bash build.sh
\`\`\`

产物在 \`bin/\`；同轮会在 \`source/bin/targets/\` 下产生 **ImageBuilder 与 SDK**，
之后想换插件组合不必重编译，直接用 ImageBuilder 重新打包（秒级）。

## 硬约束（违反会失败）

| 约束 | 后果 |
|---|---|
| 路径含空格 | 构建系统直接崩，且报错信息完全看不出是空格引起 |
| 用 root/sudo 构建 | 后续普通用户无法写入 stages，留下半成品 |
| 设了 \`SED\` / \`GREP_OPTIONS\` | patch/stage 阶段出现无法解释的失败 |
| \`make -j\` 前没跑 \`make download\` | 并行下载互相撞坏 sha256，报 CMP/校验失败 |
| 同时开两份 make | 互相删除 .o，报 \`ar: xxx.o: No such file or directory\` |
| GUN make < 4.3 | \`unterminated call to function 'shell'\` |
| Ubuntu 26.04+ 的默认 coreutils | prereq 找不到 GNU install → 预检失败（需要 \`gnu-coreutils\` + \`gnuinstall\` 软链） |

**不要用 \`FORCE=1\` 跳过依赖预检** —— 那只是把错误推到后面，报错会更难读。

## 排障速查

### \`recursive dependency detected\`
最常见原因是**同一个包被两个 feed 提供**。定位：

\`\`\`bash
grep '^Package: ' tmp/info/.packageinfo-kernel_linux | sort | uniq -d | wc -l   # 必须为 0
\`\`\`

### \`tmp/.packageinfo\` 为 0 字节
包索引生成竞态。\`build.sh\` 已内置三轮自检（行数 >1000 且重复 ≤20 才算通过），失败时会自动 \`rm -rf tmp\` 重试。

### 单个包编译失败
**先读日志**，不要急着重跑：

\`\`\`bash
less logs/package/feeds/<feed>/<pkg>/compile.txt
\`\`\`

### 编译后某些 select 的依赖没生效
\`select X if X<Y\` 只把 X 从 m 提升到 y，**不会凭空启用 X**。缺的依赖要显式写进 \`config.seed\`。

### 切换 branch 后各种莫名其妙的错误
必须 \`make distclean\`：

\`\`\`bash
make distclean && make defconfig
\`\`\`
（注意 \`distclean\` 会连带删掉 \`dl/\`、\`feeds\` 与 \`.config\`。）

## 交付自检

- [ ] \`bin/\` 下有对应 \`${spec.profile}\` 的固件
- [ ] 固件体积小于设备闪存容量
- [ ] 首次启动后 hostname / LAN IP / PPPoE 均正确
- [ ] WAN 区「入站」已按需要设为「拒绝」
`;
}

/** 拉取该版本的官方 feeds（带 commit 锁定），失败时退回内置默认 */
async function officialFeedsFor(spec) {
  const fallbackFor = {
    openwrt: [
      { name: 'packages', url: 'https://git.openwrt.org/feed/packages.git' },
      { name: 'luci', url: 'https://git.openwrt.org/project/luci.git' },
      { name: 'routing', url: 'https://git.openwrt.org/feed/routing.git' },
      { name: 'telephony', url: 'https://git.openwrt.org/feed/telephony.git' },
    ],
    immortalwrt: [
      { name: 'packages', url: 'https://git.openwrt.org/feed/packages.git' },
      { name: 'luci', url: 'https://git.openwrt.org/project/luci.git' },
      { name: 'routing', url: 'https://git.openwrt.org/feed/routing.git' },
      { name: 'telephony', url: 'https://git.openwrt.org/feed/telephony.git' },
    ],
  };
  try {
    const info = await getFeedsBuildinfo(spec.distro, spec.version, spec.target, spec.subtarget);
    if (info.ok && info.feeds && info.feeds.length) return info.feeds.filter((f) => f.url);
  } catch (e) { /* 忽略 */ }
  return fallbackFor[spec.distro] || fallbackFor.openwrt;
}

async function generateSRC(spec) {
  const feeds = await officialFeedsFor(spec).catch(() => []);
  return [
    { path: 'config.seed', content: buildConfigSeed(spec, feeds) },
    { path: 'feeds.conf.default', content: buildFeedsConf(spec, feeds) },
    { path: 'clone-plugins.sh', content: buildClonePlugins(spec, pickThirdParty(spec.packages || [])), exec: true },
    { path: 'files/etc/uci-defaults/99-zz-custom.sh', content: buildUciScript(spec), exec: true },
    { path: 'build.sh', content: buildSrcScript(spec, feeds), exec: true },
    { path: '.github/workflows/src-build.yml', content: buildSrcWorkflow(spec, feeds) },
    { path: 'README-SRC.md', content: buildSrcReadme(spec, feeds) },
    { path: 'spec.json', content: JSON.stringify(spec, null, 2) },
  ];
}

function estimateSRC(spec) {
  const third = pickThirdParty(spec.packages || []);
  let buildSec = third.reduce((a, p) => a + (p.buildSec || 0), 0);
  const heavy = third.some((p) => /node|docker|netdata|unblocknetease/.test(p.id));
  const baseSec = 2400; // toolchain + kernel + base packages
  const seconds = baseSec + buildSec + (heavy ? 1800 : 0);
  // 与生成的 build.sh / 工作流里 "可用磁盘 < 50GB 直接退出" 的硬校验保持一致
  //（实测 build_dir 18~37GB + staging/dl/bin ≈ 50GB，取 50 才不会"估算说够、脚本却拦下"）
  const diskGB = 50 + (third.length ? third.length * 0.35 : 0);
  return {
    engine: 'src',
    seconds,
    human: `${Math.round(seconds / 60)} 分钟 ~ ${Math.round(seconds / 3600 * 10) / 10} 小时`,
    diskGB: Math.round(diskGB * 10) / 10,
    heavyHitters: third.filter((p) => p.buildSec >= 500).map((p) => `${p.label}(${p.buildSec}s)`),
    note: '源码全编译 = toolchain + kernel + 官方基础包 + 选中的第三方包；首次最贵，之后有 ccache 与 ImageBuilder 兜底',
  };
}

module.exports = { generateSRC, estimateSRC, buildConfigSeed, buildFeedsConf, buildClonePlugins, buildSrcScript, buildSrcWorkflow, buildSrcReadme, pickThirdParty };
