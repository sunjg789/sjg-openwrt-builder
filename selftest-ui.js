'use strict';
/** selftest-ui.js — 前端冒烟测试
 * 用 jsdom 加载真实的 index.html + app.js，直连本地服务，验证：
 *  1. app.js 无语法/运行时错误（之前就是因为一行丢失，整份前端是死的）
 *  2. 首屏 step 1 立即可见（不等网络）
 *  3. 版本 → 设备 → 插件整条加载链跑通，下拉框被真实数据填充
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = __dirname;
// 服务地址可覆盖：PORT=8740 node server.js && BASE=http://127.0.0.1:8740 node selftest-ui.js
const BASE = process.env.BASE || 'http://127.0.0.1:8730';
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}`);
  if (!ok) fail++;
};
/** 环境不具备时的跳过：不算失败，但要显式打出来，避免 silently 消失 */
const skip = (msg) => console.log(`  \x1b[33m○\x1b[0m ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: undefined,
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // 让前端的 fetch 真的打到本机服务上
      window.fetch = (u, o) => {
        const url = String(u).startsWith('http') ? String(u) : BASE + String(u);
        return fetch(url, o);
      };
      window.scrollTo = () => {};
    },
  });

  const { window } = dom;
  const doc = window.document;

  console.log('\n=== A. 脚本注入前 ===');
  const p1 = doc.querySelector('.panel[data-panel="1"]');
  check(p1.classList.contains('on'), 'step 1 面板默认带 on 类（JS 未执行也能看到）');
  check(doc.querySelectorAll('#distroGrid .distro.skel').length === 2, '骨架卡片已在 HTML 里静态预置');

  // 注入 app.js（模拟 <script src>）。
  // 注意：app.js 顶层 const 是词法绑定，不会挂到 window 上，
  // 所以追加一行把它暴露出来供断言读取（仅测试用）。
  const code = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
    + '\n;window.__expose = () => ({ state, curCat, refreshPreview, goto, buildSpec, ghRender });';
  const s = doc.createElement('script');
  s.textContent = code;
  doc.body.appendChild(s);

  console.log('\n=== B. 首屏即时性 ===');
  check(p1.classList.contains('on'), '注入脚本后立即（未完成请求）step 1 可见');
  const activeStep = doc.querySelector('.step.on');
  check(activeStep && activeStep.dataset.step === '1', '左侧步骤条高亮在第 1 步');

  // 等加载链（版本→设备→插件）跑完
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const cur = typeof window.__expose === 'function' ? window.__expose() : null;
    if (cur && cur.state.plugins.length) break;
  }
  const sx = typeof window.__expose === 'function' ? window.__expose() : {};
  const st = sx.state || {};

  console.log('\n=== C. 加载链结果 ===');
  const distroBtns = doc.querySelectorAll('#distroGrid .distro:not(.skel)');
  check(distroBtns.length === 2, `发行版卡片渲染 ${distroBtns.length} 张（真实数据，骨架已被替换）`);
  check(doc.querySelectorAll('#distroGrid .skel').length === 0, '骨架卡片已全部清除');

  const countOpts = (sel) => doc.querySelectorAll(`${sel} option`).length;
  check(countOpts('#versionSel') > 3, `版本下拉框 ${countOpts('#versionSel')} 项`);
  check(countOpts('#targetSel') > 1, `架构下拉框 ${countOpts('#targetSel')} 项（state.target=${st.target}）`);
  check(countOpts('#subSel') >= 1, `子架构下拉框 ${countOpts('#subSel')} 项（state.subtarget=${st.subtarget}）`);
  // x86/64 这类通用目标本来就只有 generic 一个 profile，所以按接口实际返回比对
  const expProfiles = (st.profilesData && st.profilesData.profiles || []).length;
  check(countOpts('#profileSel') === expProfiles && expProfiles > 0,
    `设备 profile ${countOpts('#profileSel')} 项，与接口一致（${st.target}/${st.subtarget}，选中 ${st.profile}）`);
  check((doc.querySelector('#verCount').textContent || '').includes('共'), `版本计数文案：${doc.querySelector('#verCount').textContent}`);
  check((st.plugins || []).length > 0, `插件清单加载 ${(st.plugins || []).length} 项`);
  check((doc.querySelector('#pkgHint').textContent || '').includes('包管理器'), `插件区提示：${doc.querySelector('#pkgHint').textContent.slice(0, 46)}…`);
  check(doc.querySelectorAll('#catFilters .chip').length > 1, '插件分类筛选按钮已渲染');

  const noLoadingLeft = ['#versionSel', '#targetSel', '#subSel', '#profileSel']
    .filter((sel) => (doc.querySelector(sel).textContent || '').includes('加载中'));
  check(noLoadingLeft.length === 0, `无下拉框停留在「加载中」${noLoadingLeft.length ? '→ ' + noLoadingLeft.join(',') : ''}`);

  console.log('\n=== D. 运行时错误 ===');
  const real = errors.filter((e) => !/Not implemented|scrollTo|CSS/i.test(e));
  check(real.length === 0, real.length ? '存在运行时错误：\n      ' + real.join('\n      ') : '无运行时错误');

  console.log('\n=== E. 交互：切换发行版 ===');
  const cards = Array.from(doc.querySelectorAll('#distroGrid .distro'));
  const owCard = cards.find((b) => b.textContent.includes('OpenWrt'));
  check(!!owCard, '找到 OpenWrt 官方卡片');
  owCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  // 用「加载中出现 → 消失」判定重载真的跑完，避免读到切换前的旧数据
  const SELS = ['#versionSel', '#targetSel', '#subSel', '#profileSel'];
  const anyLoading = () => SELS.filter((s) => (doc.querySelector(s).textContent || '').includes('加载中'));
  let sawLoading = anyLoading().length > 0;
  for (let i = 0; i < 20 && !sawLoading; i++) { await sleep(50); sawLoading = anyLoading().length > 0; }
  check(sawLoading, '点击后立即进入「加载中」状态');
  for (let i = 0; i < 120; i++) { await sleep(500); if (!anyLoading().length) break; }
  check(!anyLoading().length, `切换后重载完成，无下拉框卡在「加载中」${anyLoading().length ? '→ ' + anyLoading().join(',') : ''}`);
  const st2 = window.__expose().state;
  check(st2.distro === 'openwrt', `state.distro 已切换为 ${st2.distro}`);
  check(countOpts('#versionSel') > 3, `版本列表随之刷新为 ${countOpts('#versionSel')} 项（${st2.version}）`);
  check(st2.plugins.length > 0, `插件清单随版本重取 ${st2.plugins.length} 项`);
  check(!!st2.profile, `设备 profile 重新选中：${st2.profile}（${st2.target}/${st2.subtarget}）`);
  const noLoading2 = ['#versionSel', '#targetSel', '#subSel', '#profileSel']
    .filter((sel) => (doc.querySelector(sel).textContent || '').includes('加载中'));
  check(noLoading2.length === 0, '切换后无下拉框卡在「加载中」');

  console.log('\n=== F. 步骤导航与预览生成 ===');
  const step6 = doc.querySelector('.step[data-step="6"]');
  step6.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check(doc.querySelector('.panel[data-panel="6"]').classList.contains('on'), '点击第 6 步 → 生成面板显示');
  check(doc.querySelectorAll('.panel.on').length === 1, '同一时刻只显示一个面板');

  // 显式跑一次预览，避免读到加载过程中自动预览写下的旧值
  doc.querySelector('#estimate').innerHTML = '';
  await window.__expose().refreshPreview();
  const est = doc.querySelector('#estimate').textContent;
  check(!/尚未选择/.test(est) && est.trim().length > 0, `资源估算：${est.slice(0, 46).replace(/\s+/g, ' ')}…`);
  check(!doc.querySelector('#btnZip').disabled, '打包按钮已可用');
  check(doc.querySelectorAll('#fileTabs .chip').length > 0, `产物文件页签 ${doc.querySelectorAll('#fileTabs .chip').length} 个`);
  check((doc.querySelector('#fileBody').textContent || '').length > 50, `首个产物正文 ${(doc.querySelector('#fileBody').textContent || '').length} 字符`);

  console.log('\n=== G. 官方预编译固件下载 ===');
  // sha256sums 要现场抓取，等它落地
  const imgRows = () => Array.from(doc.querySelectorAll('#officialImages .img-row'));
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const t = doc.querySelector('#officialImages').textContent || '';
    if (imgRows().length || /失败|没有|未匹配|无法确认/.test(t)) break;
  }
  const wrap = doc.querySelector('#officialImagesWrap');
  check(!wrap.hidden, '第 3 步的「官方预编译固件」区块已显示');
  const rows = imgRows();
  check(rows.length > 0, `固件清单 ${rows.length} 条`);
  const first = rows[0] && rows[0].querySelector('a.img-name');
  check(!!first && /^https:\/\/downloads\./.test(first.href), `下载地址指向官方：${first ? first.getAttribute('href').split('/')[2] : '无'}`);
  check(rows.every((r) => !!r.querySelector('[data-sha]')), '每条都带可复制的 SHA256');
  check(rows.every((r) => (r.querySelector('[data-sha]').dataset.sha || '').length === 64), 'SHA256 均为 64 位十六进制');
  const toolRows = Array.from(doc.querySelectorAll('#officialTools .img-row'));
  check(toolRows.length > 0, `构建工具包 ${toolRows.length} 个（ImageBuilder / SDK）`);

  // 抽一条做真实可达性校验——profiles.json 的名称缺 .gz 会直接 404，这里必须是 200。
  //
  // 这是全脚本**唯一**直连外网的地方，必须自己做失败隔离：之前写成裸 await fetch，
  // 网络一抖抛异常冒泡到最外层 catch → process.exit(2)，后面的 H、I 两组永远跑不到，
  // 表现就是「测试莫名其妙停在 G 组」，重启和重装都救不了（问题根本不在安装上）。
  if (first) {
    const url = first.getAttribute('href');
    try {
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000) });
      check(head.status === 200, `抽查链接真实可用：HTTP ${head.status} · …${first.textContent.slice(-28)}`);
    } catch (e) {
      const host = (() => { try { return new URL(url).host; } catch (x) { return url; } })();
      skip(`外网可达性抽查跳过（本机无法直连 ${host}）：${/timed out|timeout/i.test(e.message) ? '连接超时' : e.message}`);
      skip('该用例依赖外网，与前端逻辑无关；H/I 两组继续运行');
    }
  }

  console.log('\n=== H. 降级：版本元数据库不可用（回归用例）===');
  // 之前这里的真实崩溃：服务端不可达时返回 profiles:{}（对象），前端 `|| []` 挡不住，
  // 走到 for...of 直接 TypeError，整条加载链炸掉。用不存在的版本复现同样的空数据路径。
  const vs = doc.querySelector('#versionSel');
  const fake = doc.createElement('option');
  fake.value = '9.9.9'; fake.textContent = '9.9.9';
  vs.appendChild(fake); vs.value = '9.9.9';
  vs.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 120; i++) { await sleep(500); if (!anyLoading().length) break; }
  const st3 = window.__expose().state;
  const info = doc.querySelector('#deviceInfo').textContent || '';
  check(!/加载中/.test(doc.querySelector('#targetSel').textContent), '架构下拉框未停在「加载中」');
  check(/不可用|无可用|不可用架构/.test(info), `设备区给出可读的降级说明：${info.slice(0, 40).replace(/\s+/g, ' ')}…`);
  check(st3.target === '' && st3.profile === '', '下游选择已清空，不会带着脏 target 继续生成');
  const crash = errors.filter((e) => /TypeError|is not iterable|not a function/i.test(e));
  check(crash.length === 0, crash.length ? '出现崩溃：\n      ' + crash.join('\n      ') : '全程无 TypeError / is not iterable 崩溃');

  console.log('\n=== I. 在线构建（GitHub Actions）面板 ===');
  for (const id of ['#ghRepo', '#ghToken', '#ghSave', '#ghStart', '#ghStatus', '#ghAccount']) {
    check(!!doc.querySelector(id), `在线构建控件 ${id} 存在`);
  }
  // 未选设备就点「开始构建」必须被拦住，而不是发一个必然失败的请求
  doc.querySelector('#ghStart').dispatchEvent(new window.Event('click', { bubbles: true }));
  const tEl = doc.querySelector('#toast');
  check(!tEl.hidden && /先把版本和设备选完/.test(tEl.textContent),
    `未选设备时的守卫提示：${tEl.textContent}`);

  const ghRender = window.__expose().ghRender;
  // 失败态：日志里混了 HTML 尖括号，必须转义后再塞进面板，否则会被当成标签吞掉
  ghRender({
    id: 't-1', repo: 'a/b', state: 'completed', conclusion: 'failure', logFile: '0_ib.txt', logLines: 999,
    summary: { distro: 'immortalwrt', target: 'x86', subtarget: '64' },
    runUrl: 'https://github.com/a/b/actions/runs/1',
    errorLines: ['bash: line 1: mkisofs: <command> not found', 'make: *** [Makefile:357: image] Error 2'],
    logTail: 'tail <body>', jobs: [], artifacts: [], files: [],
  });
  const failBox = doc.querySelector('#ghStatus .gh-fail');
  check(!!failBox, '失败时渲染出原因摘要区块');
  check(!doc.querySelector('#ghStatus').innerHTML.includes('<command>'),
    '日志里的尖括号已转义，没有被当成标签');
  check(/mkisofs/.test(failBox.textContent) && /Error 2/.test(failBox.textContent), '摘要包含真正的报错行');
  check(!!doc.querySelector('#ghStatus details'), '提供「展开日志尾部」折叠区');

  // 成功态：产物应变成可下载链接
  ghRender({
    id: 't-1', repo: 'a/b', state: 'completed', conclusion: 'success', summary: { target: 'x86', subtarget: '64' },
    jobs: [], artifacts: [], files: [{ name: 'images.zip', file: 'images_zip.zip', size: 3 * 1048576 }],
  });
  const link = doc.querySelector('#ghStatus a[href*="/api/build/file"]');
  check(!!link, `产物渲染为本地下载链接：${link ? link.getAttribute('href') : '无'}`);
  check(!doc.querySelector('#ghStatus .gh-fail'), '成功态不再显示失败摘要');
  check(!/没有产出 Artifact/.test(doc.querySelector('#ghStatus').textContent), '成功态不误报「没有产物」');

  console.log('\n=== 结果 ===');
  console.log(fail ? `\x1b[31m${fail} 项未通过\x1b[0m` : '\x1b[32m全部通过\x1b[0m');
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(2); });
