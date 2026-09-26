'use strict';
/* selftest3.js — 广度验证：多设备树、版本间插件差异、脚本语法 */
const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8730;
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    const c = [];
    r.on('data', (d) => c.push(d));
    r.on('end', () => { try { res(JSON.parse(Buffer.concat(c))); } catch (e) { res({}); } });
  }).on('error', rej);
});

const post = (p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (r) => {
    const c = [];
    r.on('data', (d) => c.push(d));
    r.on('end', () => { try { res(JSON.parse(Buffer.concat(c))); } catch { res({}); } });
  });
  req.on('error', rej);
  req.end(data);
});

let fail = 0;
const check = (c, m) => { if (!c) fail++; console.log(`${c ? '  ✓' : '  ✗'} ${m}`); return c; };

(async () => {
  console.log('\n=== A. 子目标列表净化（不得出现 releases/targets/版本号/自身目录名）===');
  const cases = [
    ['immortalwrt', '25.12.2', 'x86', ['64', 'generic', 'geode', 'legacy']],
    ['openwrt', '25.12.5', 'x86', ['64', 'generic', 'geode', 'legacy']],
  ];
  for (const [distro, ver, tgt, expect] of cases) {
    const d = await get(`/api/subtargets?distro=${distro}&version=${ver}&target=${tgt}`);
    const subs = d.subtargets || [];
    const bad = subs.filter((s) => ['releases', 'targets', 'packages', 'snapshots', tgt, ver].includes(s));
    check(bad.length === 0, `${distro} ${ver} ${tgt} → ${subs.join(', ')}`);
    if (bad.length) console.log(`      混入的杂质: ${bad.join(', ')}`);
    for (const e of expect) check(subs.includes(e), `  含预期子目标 ${e}`);
  }

  console.log('\n=== B. 多设备 profile 覆盖（真实拉取）===');
  const devices = [
    ['openwrt', '25.12.5', 'mediatek', 'filogic'],
    ['openwrt', '25.12.5', 'bcm27xx', 'bcm2711'],
    ['openwrt', '23.05.5', 'ath79', 'generic'],
    ['immortalwrt', '25.12.2', 'mediatek', 'filogic'],
    ['immortalwrt', '24.10.4', 'rockchip', 'armv8'],
  ];
  for (const [distro, ver, tgt, sub] of devices) {
    const d = await get(`/api/profiles?distro=${distro}&version=${ver}&target=${tgt}&sub=${sub}`);
    const n = (d.profiles || []).length;
    check(n > 0, `${distro} ${ver} ${tgt}/${sub} → ${n} 个设备，arch=${d.arch_packages}`);
    if (n) console.log(`      例: ${d.profiles.slice(0, 3).map((p) => p.id).join(', ')}`);
    const ib = await get(`/api/ib?distro=${distro}&version=${ver}&target=${tgt}&sub=${sub}`);
    check(ib.ok === true, `  ImageBuilder: ${ib.filename || '不可用'} [${(ib.tried || []).join(' ')}]`);
  }

  console.log('\n=== C. 插件清单随版本变换（同一设备不同版本对比）===');
  const v1 = await get('/api/packages?distro=openwrt&version=25.12.5&arch=x86_64');
  const v2 = await get('/api/packages?distro=openwrt&version=23.05.5&arch=x86_64');
  const set = (d) => new Set((d.plugins || []).filter((p) => p.source === 'repo').map((p) => p.pkgs[0]));
  const s1 = set(v1), s2 = set(v2);
  const onlyNew = Array.from(s1).filter((x) => !s2.has(x));
  const onlyOld = Array.from(s2).filter((x) => !s1.has(x));
  check(s1.size !== s2.size || onlyNew.length > 0, `25.12.5 自带 ${s1.size} 个 luci 应用 / 23.05.5 自带 ${s2.size} 个`);
  check(onlyNew.length > 0, `仅 25.12 有 ${onlyNew.length} 个（如 ${onlyNew.slice(0, 5).join(', ')}）`);
  check(onlyOld.length > 0, `仅 23.05 有 ${onlyOld.length} 个（如 ${onlyOld.slice(0, 5).join(', ')}）`);
  console.log(`      包管理器: 25.12.5=${v1.manager} / 23.05.5=${v2.manager}`);
  check(v1.manager === 'apk' && v2.manager === 'opkg', 'apk / opkg 切换被正确识别');

  console.log('\n=== D. 生成的 shell 脚本语法检查 ===');
  // 注意：Windows 下 node 无法 spawn bash（EBUSY），语法检查改由外部 shell 执行 bash -n
  const dirs = fs.readdirSync(path.join(__dirname, 'out'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  let listed = 0;
  for (const d of dirs) {
    const full = path.join(__dirname, 'out', d);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.sh') || f.startsWith('__')) continue;
      console.log(`  · ${d}/${f}`);
      listed++;
    }
  }
  check(listed > 0, `共 ${listed} 个脚本待外部 bash -n 校验`);

  console.log('\n=== E. 密码哈希完整性（$1$ 不得被 shell 当成位置参数）===');
  const top = path.join(__dirname, 'out');
  const uci = fs.readdirSync(top, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(top, d.name, 'files__etc__uci-defaults__99-zz-custom.sh'))
    .filter((p) => fs.existsSync(p));
  check(uci.length > 0, `找到 ${uci.length} 份首启脚本`);
  for (const p of uci) {
    const t = fs.readFileSync(p, 'utf8');
    const noUnquoted = !/ROOT_HASH="\$1\$/.test(t) && /ROOT_HASH='\$1\$/.test(t);
    const usesVar = /\\\$\{ROOT_HASH\}|\$\{ROOT_HASH\}/.test(t);
    check(noUnquoted, `${path.basename(path.dirname(p))}: ROOT_HASH 用单引号赋值`);
    check(usesVar, `${path.basename(path.dirname(p))}: sed 引用 \${ROOT_HASH} 变量`);
  }

  console.log('\n=== F. 版本专属插件清单已内置 ===');
  const im = await get('/api/imm-plugins');
  check((im.keys || []).length === 2, `内置 ${(im.keys || []).join(', ')}`);
  if (im.data) {
    for (const k of im.keys) console.log(`      ${k}: ${im.data[k].length} 条记录`);
    check(im.data['imm-24.10'].length > 100 && im.data['imm-25.12'].length > 100, '两个系列的清单条目数正常');
  }

  console.log('\n=== G. 官方源里没有的包必须从 PACKAGES 剔除（IB 对未知包是硬失败）===');
  const bogus = 'zzz-not-a-real-package';
  const spec = {
    engine: 'ib', distro: 'immortalwrt', version: '25.12.2', target: 'x86', subtarget: '64',
    profile: 'generic', archPackages: 'x86_64',
    packages: ['luci', bogus], excludes: [], customRepos: [],
    image: { rootfsSizeMB: 1024, kernelSizeMB: 32 },
    system: {}, network: {},
  };
  const pv = await post('/api/preview', spec);
  const sh = (pv.files || []).find((f) => f.path === 'build.sh');
  const yml = (pv.files || []).find((f) => f.path === '.github/workflows/ib-build.yml');
  const txt = (pv.files || []).find((f) => f.path === 'PACKAGES.txt');
  check((pv.dropped || []).includes(bogus), `服务端剔除清单含 ${bogus}：${JSON.stringify(pv.dropped)}`);
  check(!!sh && !sh.content.includes(bogus), 'build.sh 的 PACKAGES 里没有这个未知包');
  check(!!yml && !yml.content.includes(bogus), '工作流的 PACKAGES 里没有这个未知包');
  check(!!txt && txt.content.includes(bogus), 'PACKAGES.txt 里留痕说明它被剔除了（不静默丢包）');

  // 配了第三方源时不能摘：那些包可能正由第三方源提供
  const spec2 = JSON.parse(JSON.stringify(spec));
  spec2.customRepos = [{ name: 'x', url: 'https://example.com/repo' }];
  const pv2 = await post('/api/preview', spec2);
  const sh2 = (pv2.files || []).find((f) => f.path === 'build.sh');
  check(!(pv2.dropped || []).includes(bogus) && !!sh2 && sh2.content.includes(bogus),
    '配了第三方源时保留该包（可能由第三方源提供）');

  console.log('\n=== H. 工作流必须声明最小权限（构建产物不回写仓库）===');
  for (const [distro, ver] of [['openwrt', '25.12.5'], ['immortalwrt', '25.12.2']]) {
    for (const engine of ['ib', 'src']) {
      const pv = await post('/api/preview', {
        engine, distro, version: ver, target: 'x86', subtarget: '64', profile: 'generic',
        archPackages: 'x86_64', packages: [], excludes: [], customRepos: [],
        image: { rootfsSizeMB: 1024, kernelSizeMB: 32 }, system: {}, network: {},
      });
      const f = (pv.files || []).find((x) => x.path && x.path.endsWith('.yml'));
      const body = (f && f.content) || '';
      check(/permissions:\s*\n\s*contents:\s*read/.test(body),
        `${distro} ${ver} ${engine}: 声明了 contents: read（不是 write，也不是缺省继承）`);
      check(!/contents:\s*write/.test(body), `${distro} ${ver} ${engine}: 未索要写权限`);
    }
  }

  console.log('\n=== I. 工作流注册判定必须看默认分支的真实文件（不能被「幽灵注册」骗）===');
  try {
    const { Gh } = require('./lib/gh');
    const cfg = JSON.parse(fs.readFileSync('config/gh.json', 'utf8'));
    const gh = new Gh(cfg.token, cfg.repo);
    const onDefault = await gh.isRegisteredOnDefault('ib-build.yml');
    const list = await gh.registeredWorkflows();
    // 曾踩过的坑：/actions/workflows 列表会残留已删除文件的记录（state=active），
    // 信它就会带着 registeredOnDefault=true 去 dispatch，被 GitHub 用 422 打回。
    check(!!onDefault, '默认分支上真有 .github/workflows/ib-build.yml（dispatch 才可用）');
    check(list.some((w) => w.path.endsWith('ib-build.yml')), '工作流列表也查得到（两侧一致，说明不是幽灵注册）');
  } catch (e) {
    console.log('   跳过（需要 GitHub token 与网络）：' + e.message);
  }

  console.log('\n=== 结果 ===');
  console.log(fail ? `\x1b[31m${fail} 项未通过\x1b[0m` : '\x1b[32m全部通过\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(2); });
