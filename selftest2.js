'use strict';
/* selftest2.js — 端到端自检：走真实 HTTP API，验证「全设备 / 双发行版 / 插件随版本变换 / 双引擎生成」 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8730);
const HOST = '127.0.0.1';
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: HOST, port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (p.startsWith('/api/zip')) return resolve({ status: res.statusCode, buf: Buffer.concat(chunks) });
        const txt = Buffer.concat(chunks).toString('utf8');
        let j; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ok = (c, m) => console.log(`${c ? '\x1b[32m  ✓\x1b[0m' : '\x1b[31m  ✗\x1b[0m'} ${m}`);
let failures = 0;
const check = (c, m) => { if (!c) failures++; ok(c, m); return c; };

(async () => {
  console.log('\n=== 1. 发行版 ===');
  const distros = (await req('GET', '/api/distros')).body.distros || [];
  check(distros.length === 2, `发行版数量 = ${distros.length}（${distros.map((d) => d.id).join(', ')}）`);

  for (const distro of distros) {
    console.log(`\n=== 2. ${distro.name} 版本列表 ===`);
    const v = (await req('GET', `/api/versions?distro=${distro.id}`)).body;
    const versions = v.versions || [];
    check(versions.length > 10, `可用版本 ${versions.length} 个，最新 = ${versions[0] && versions[0].version}`);
    const series = Object.keys(v.grouped || {});
    console.log(`      系列: ${series.join(' / ')}`);

    // 取一个正式版本与一个快照，各测一次设备树
    const pick = versions.find((x) => x.kind === 'release') || versions[0];
    if (!pick) continue;

    console.log(`\n=== 3. ${distro.name} ${pick.version} 设备树 ===`);
    const t = (await req('GET', `/api/targets?distro=${distro.id}&version=${encodeURIComponent(pick.version)}`)).body;
    const targets = t.targets || [];
    check(targets.length > 5, `CPU 架构 ${targets.length} 个`);

    const tgt = targets.includes('x86') ? 'x86' : targets[0];
    const st = (await req('GET', `/api/subtargets?distro=${distro.id}&version=${encodeURIComponent(pick.version)}&target=${tgt}`)).body;
    const subs = st.subtargets || [];
    check(subs.length > 0, `${tgt} 的子目标 ${subs.length} 个: ${subs.slice(0, 6).join(', ')}`);

    const sub = subs.includes('64') ? '64' : (subs.includes('generic') ? 'generic' : subs[0]);
    const pr = (await req('GET', `/api/profiles?distro=${distro.id}&version=${encodeURIComponent(pick.version)}&target=${tgt}&sub=${sub}`)).body;
    const profiles = pr.profiles || [];
    check(profiles.length > 0, `${tgt}/${sub} 设备 profile ${profiles.length} 个，包架构 = ${pr.arch_packages}`);
    if (profiles[0]) console.log(`      例: ${profiles[0].id} → ${profiles[0].name}`);

    console.log(`\n=== 4. ${distro.name} ${pick.version} 软件索引（插件随版本变换）===`);
    const pk = (await req('GET', `/api/packages?distro=${distro.id}&version=${encodeURIComponent(pick.version)}&arch=${encodeURIComponent(pr.arch_packages || '')}`)).body;
    check(pk.indexCount > 100, `该版本软件源 ${pk.indexCount} 个包，管理器 = ${pk.manager}`);
    const plugins = pk.plugins || [];
    const third = plugins.filter((p) => p.source === 'third').length;
    const official = plugins.filter((p) => p.source === 'official').length;
    const discovered = plugins.filter((p) => p.source === 'repo').length;
    console.log(`      候选插件 ${plugins.length}：第三方源码 ${third} / 官方精选 ${official} / 版本自带 ${discovered}`);
    check(third > 20 && official > 5, '第三方与官方插件均已载入');

    console.log(`\n=== 5. ImageBuilder 可用性 ===`);
    const ib = (await req('GET', `/api/ib?distro=${distro.id}&version=${encodeURIComponent(pick.version)}&target=${tgt}&sub=${sub}`)).body;
    check(ib.ok === true, `IB 包: ${ib.filename || '无'}  [${(ib.tried || []).join(' ')}]`);

    // ---- 构造 spec ----
    const spec = {
      engine: 'ib',
      distro: distro.id,
      version: pick.version,
      refPolicy: 'tag',
      target: tgt,
      subtarget: sub,
      profile: profiles.find((p) => p.id === 'generic') ? 'generic' : (profiles[0] && profiles[0].id) || '',
      archPackages: pr.arch_packages,
      packages: ['luci-i18n-base-zh-cn', 'ttyd', 'luci-app-taskplan', 'wireguard-tools', 'luci-app-commands', 'irqbalance'],
      packagesSizeMB: 40,
      excludes: [],
      customRepos: [],
      ipv6: true,
      wanInput: 'reject',
      userScript: '',
      image: { rootfsSizeMB: 1024, kernelSizeMB: 32 },
      system: { hostname: 'SJG', loginName: 'sunjg789', password: 'sunjian393626', loginPassword: 'sunjian393626', timezone: 'CST-8', zonename: 'Asia/Shanghai' },
      network: {
        mode: 'router', lanIp: '192.168.3.111', lanNetmask: '255.255.255.0',
        wanProto: 'pppoe', pppoeUser: 'tx7593762', pppoePass: '08057032',
        wanPorts: ['eth0'], lanPorts: ['eth1', 'eth2', 'eth3'],
      },
    };

    console.log(`\n=== 6. 校验 ===`);
    const val = (await req('POST', '/api/validate', spec)).body;
    check(val.ok === true, `errors=${(val.errors || []).length} warnings=${(val.warnings || []).length}`);
    for (const e of val.errors || []) console.log('      ! ' + e);
    for (const w of val.warnings || []) console.log('      · ' + w);

    for (const engine of ['ib', 'src']) {
      console.log(`\n=== 7. 生成（${distro.id} / ${engine}）===`);
      spec.engine = engine;
      const pv = (await req('POST', '/api/preview', spec)).body;
      if (pv.error) { ok(false, '预览失败: ' + pv.error); continue; }
      const files = pv.files || [];
      check(files.length >= 6, `产出 ${files.length} 个文件: ${files.map((f) => f.path).join(' | ')}`);
      console.log(`      估算: ${pv.estimate.human} / 磁盘 ${pv.estimate.diskGB} GB`);

      const dir = path.join(OUT, `${distro.id}-${engine}-${pick.version}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) {
        const fp = path.join(dir, f.path.replace(/\//g, '__'));
        fs.writeFileSync(fp, f.content, 'utf8');
      }
      // 语法检查交给外部 shell(sh -n)，这里只落盘
      const shFiles = files.filter((f) => f.path.endsWith('.sh'));
      ok(true, `已落盘 ${files.length} 文件（含 ${shFiles.length} 个脚本）到 out/${path.basename(dir)}`);
    }

    // ZIP
    const z = await req('POST', '/api/zip', spec);
    const zp = path.join(OUT, `test-${distro.id}.zip`);
    fs.writeFileSync(zp, z.buf);
    check(z.buf.length > 2000, `ZIP 产出 ${z.buf.length} 字节 → ${path.basename(zp)}`);
  }

  console.log(`\n=== 结果 ===`);
  if (failures) console.log(`\x1b[31m${failures} 项未通过\x1b[0m`);
  else console.log('\x1b[32m全部通过\x1b[0m');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('自检异常:', e); process.exit(2); });
