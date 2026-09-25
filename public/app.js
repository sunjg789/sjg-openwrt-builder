'use strict';
/* app.js — 定制站前端逻辑
 * 流程：发行版 → 版本 → 设备（target/subtarget/profile）→ 插件（随版本动态）→ 系统定制 → 生成
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
};
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

const state = {
  distro: 'immortalwrt',
  version: '',
  refPolicy: 'tag',
  target: '',
  subtarget: '',
  profile: '',
  archPackages: '',
  profilesData: null,
  plugins: [],
  selected: new Set(),
  repos: [],
  showDiscovered: false,
  ib: null,
  files: [],
  immLists: null,
};

const RECOMMENDED = [
  'luci-i18n-base-zh-cn', 'argon', 'taskscript', 'commands', 'arpbind', 'ramfree', 'partexp',
  'ttyd', 'openclash', 'passwall', 'dockerman', 'diskman', 'adguardhome', 'lucky',
  'unblocknetease', 'vlmcsd', 'wireguard', 'irqbalance',
];

// ---------------------------------------------------------------- 工具

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3200);
}
function opt(v, l, sel) {
  const o = document.createElement('option');
  o.value = v; o.textContent = l;
  if (sel) o.selected = true;
  return o;
}
function fill(sel, items, keep) {
  const s = $(sel);
  s.innerHTML = '';
  for (const i of items) {
    const o = typeof i === 'string' ? opt(i, i) : opt(i.value, i.label, i.value === keep);
    s.appendChild(o);
  }
}
function goto(step) {
  $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === String(step)));
  $$('.step').forEach((a) => a.classList.toggle('on', a.dataset.step === String(step)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- Step 1

async function loadDistros() {
  const d = await api('/api/distros');
  const grid = $('#distroGrid');
  grid.innerHTML = '';
  for (const x of d.distros) {
    const el = document.createElement('button');
    el.className = 'distro' + (x.id === state.distro ? ' on' : '');
    el.innerHTML = `<b>${x.name}</b><span>${x.label}</span>
      <ul>${x.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
      <em>默认版本 ${x.defaultVersion}</em>`;
    el.onclick = () => { state.distro = x.id; loadDistros(); loadVersions(); };
    grid.appendChild(el);
  }
}

// ---------------------------------------------------------------- Step 2

async function loadVersions() {
  markLoading('#versionSel');
  markLoading('#seriesSel', '加载中…');
  const d = await api(`/api/versions?distro=${state.distro}`);
  $('#verCount').textContent = `共 ${d.versions.length} 个`;
  const seriesSel = $('#seriesSel');
  seriesSel.innerHTML = '';
  seriesSel.appendChild(opt('', '全部系列'));
  for (const s of Object.keys(d.grouped)) {
    const n = d.grouped[s].length;
    seriesSel.appendChild(opt(s, `${s}（${n}）`));
  }
  const renderList = (filter) => {
    const vs = filter ? d.grouped[filter] || [] : d.versions;
    const cur = state.version;
    const items = vs.map((v) => ({
      value: v.version,
      label: `${v.version} ${v.kind === 'snapshot' ? '· 快照' : v.kind === 'rc' ? '· RC' : ''}`,
    }));
    if (!items.find((i) => i.value === cur)) items.unshift({ value: cur, label: cur });
    fill('#versionSel', items, cur || d.defaultVersion);
    state.version = $('#versionSel').value;
  };
  seriesSel.onchange = () => renderList(seriesSel.value);
  renderList('');
  if (!d.versions.find((v) => v.version === state.version)) state.version = d.defaultVersion;
  $('#versionSel').value = state.version;
  updateVersionInfo(d);
  if (d.stale) toast('版本列表拉取失败，显示的是上次缓存', true);
  await loadTargets();
}

function updateVersionInfo(d) {
  const v = d.versions.find((x) => x.version === state.version);
  $('#versionInfo').innerHTML = v
    ? `<span class="tag">${v.series} 系列</span><span class="tag ${v.kind}">${
      v.kind === 'snapshot' ? '滚动快照' : v.kind === 'rc' ? '候选发布' : '正式发布'}</span>`
    : '';
}

// ---------------------------------------------------------------- Step 3

// 上游不可达 / 该版本没有元数据时的统一降级：清空下游选择并把原因显示出来，
// 而不是让下拉框空着让用户以为卡死。
function deviceUnavailable(note) {
  state.target = ''; state.subtarget = ''; state.profile = '';
  state.archPackages = '';
  state.profilesData = { profiles: [], arch_packages: null, default_packages: [], linux_kernel: null };
  $('#tCount').textContent = '不可用';
  markLoading('#targetSel', '该版本无可用架构');
  markLoading('#subSel', '—');
  renderProfileList();
  $('#pCount').textContent = '0 / 0';
  $('#deviceInfo').innerHTML = `<div class="kv"><span>状态</span><b class="bad">上游数据不可用</b></div>`
    + (note ? `<div class="kv" style="grid-column:1/-1"><span>原因</span><b>${note}</b></div>` : '')
    + `<div class="kv"><span>建议</span><b>换一个版本（已缓存的版本仍可离线使用）</b></div>`;
  $('#pkgHint').textContent = '未选择设备，暂不读取软件索引';
}

async function loadTargets() {
  if (!state.version) return;
  markLoading('#targetSel');
  markLoading('#subSel');
  markLoading('#profileSel');
  const d = await api(`/api/targets?distro=${state.distro}&version=${encodeURIComponent(state.version)}`);
  const targets = Array.isArray(d.targets) ? d.targets : [];
  if (!targets.length) {
    deviceUnavailable(d.note || (d.http === 0 ? '上游下载服务器不可达（断网或超时）' : '该版本未提供 targets 索引'));
    toast('该版本的设备数据不可用，请换一个版本', true);
    return;
  }
  $('#tCount').textContent = `共 ${targets.length} 个`;
  const items = targets.map((t) => ({ value: t, label: t }));
  if (!items.find((i) => i.value === state.target)) {
    state.target = targets.includes('x86') ? 'x86' : targets[0];
  }
  fill('#targetSel', items, state.target);
  $('#targetSel').onchange = () => { state.target = $('#targetSel').value; loadSubtargets(); };
  await loadSubtargets();
}

async function loadSubtargets() {
  markLoading('#subSel');
  markLoading('#profileSel');
  const d = await api(`/api/subtargets?distro=${state.distro}&version=${encodeURIComponent(state.version)}&target=${encodeURIComponent(state.target)}`);
  const subs = Array.isArray(d.subtargets) ? d.subtargets : [];
  if (!subs.length) {
    deviceUnavailable(d.note || `该 target 没有可用子架构（${state.target}）`);
    return;
  }
  const items = subs.map((s) => ({ value: s, label: s }));
  if (!items.find((i) => i.value === state.subtarget)) {
    state.subtarget = subs.includes('64') ? '64' : (subs.includes('generic') ? 'generic' : subs[0]);
  }
  fill('#subSel', items, state.subtarget);
  $('#subSel').onchange = () => { state.subtarget = $('#subSel').value; loadProfiles(); };
  await loadProfiles();
}

async function loadProfiles() {
  markLoading('#profileSel');
  const d = await api(`/api/profiles?distro=${state.distro}&version=${encodeURIComponent(state.version)}`
    + `&target=${encodeURIComponent(state.target)}&sub=${encodeURIComponent(state.subtarget)}`);
  state.profilesData = d;
  state.archPackages = d.arch_packages || '';
  renderProfileList();
  const ps = profilesArray();
  if (!ps.length) {
    // 接口没给回来画像（版本太老或上游不可达），把原因摆出来而不是留个空框
    $('#pCount').textContent = '0 / 0';
    $('#deviceInfo').innerHTML = `<div class="kv"><span>目标</span><b>${state.target}/${state.subtarget}</b></div>`
      + `<div class="kv" style="grid-column:1/-1"><span>说明</span><b>${d.note || '该子目标没有 profile 数据'}</b></div>`;
    return;
  }
  if (state.profile && ps.find((p) => p.id === state.profile)) {
    $('#profileSel').value = state.profile;
  } else {
    const g = ps.find((p) => p.id === 'generic');
    state.profile = g ? 'generic' : (ps[0] && ps[0].id) || '';
    $('#profileSel').value = state.profile;
  }
  $('#profileSel').onchange = () => { state.profile = $('#profileSel').value; onDevicePicked(); };
  onDevicePicked();
  await checkIB();
  await loadPackages();
}

// 服务端在「上游不可达」等异常路径上历史上返回过 profiles:{} ，
// 这里的 `|| []` 挡不住 truthy 的空对象，所以统一走 Array.isArray 收敛。
function profilesArray() {
  const ps = state.profilesData && state.profilesData.profiles;
  return Array.isArray(ps) ? ps : [];
}

function renderProfileList() {
  const kw = ($('#profileSearch').value || '').toLowerCase().trim();
  const all = profilesArray();
  const list = kw ? all.filter((p) => (p.id + ' ' + p.name).toLowerCase().includes(kw)) : all;
  $('#pCount').textContent = `${list.length} / ${all.length}`;
  const s = $('#profileSel');
  s.innerHTML = '';
  if (!list.length) {
    s.appendChild(opt('', all.length ? '无匹配机型' : '该版本暂无可用 profile'));
    return;
  }
  for (const p of list) s.appendChild(opt(p.id, `${p.id}   ·   ${p.name}`));
}

async function onDevicePicked() {
  const d = state.profilesData || {};
  const p = profilesArray().find((x) => x.id === state.profile);
  $('#deviceInfo').innerHTML = `
    <div class="kv"><span>目标</span><b>${state.target}/${state.subtarget}</b></div>
    <div class="kv"><span>PROFILE</span><b>${state.profile}</b></div>
    <div class="kv"><span>包架构</span><b>${d.arch_packages || '未知'}</b></div>
    <div class="kv"><span>内核</span><b>${(d.linux_kernel && d.linux_kernel.version) || '未知'}</b></div>
    <div class="kv"><span>默认包数</span><b>${(d.default_packages || []).length}</b></div>
    ${p && p.supported_devices && p.supported_devices.length ? `<div class="kv"><span>兼容机型</span><b>${p.supported_devices.join(', ')}</b></div>` : ''}
    ${p && p.device_packages && p.device_packages.length ? `<div class="kv"><span>设备专属包</span><b>${p.device_packages.join(' ')}</b></div>` : ''}
    ${p && p.images && p.images.length ? `<div class="kv"><span>可用镜像</span><b>${p.images.map((i) => i.type).join(', ')}</b></div>` : ''}`;
  $('#profileSel').value = state.profile;
  renderSummary();
  loadOfficialImages();
}

// ---------------------------------------------------------------- 官方预编译固件

// 本机无法编译（OpenWrt 官方只支持 GNU/Linux，见 README「已知边界」），
// 但上游每个子目标都备好了现成镜像——这里把它们列出来直接下载，
// 并以上游 sha256sums 为唯一权威来源（profiles.json 的 images[] 缺 .gz 后缀会 404）。
async function loadOfficialImages() {
  const wrap = $('#officialImagesWrap');
  const box = $('#officialImages');
  const tools = $('#officialTools');
  if (!state.profile || !state.target || !state.subtarget) { wrap.hidden = true; return; }
  wrap.hidden = false;
  box.innerHTML = '<div class="mini"><span class="spin"></span> 读取官方固件清单…</div>';
  tools.innerHTML = '';
  try {
    const d = await api(`/api/images?distro=${state.distro}&version=${encodeURIComponent(state.version)}`
      + `&target=${encodeURIComponent(state.target)}&sub=${encodeURIComponent(state.subtarget)}`
      + `&profile=${encodeURIComponent(state.profile)}`);
    if (!d.ok || !d.images.length) {
      box.innerHTML = `<div class="mini">${d.note || '该设备上游没有提供固件文件'}</div>`;
      return;
    }
    box.innerHTML = d.images.map((i) => `
      <div class="img-row">
        <a class="img-name" href="${i.url}" target="_blank" rel="noopener">${i.name}</a>
        <span class="img-labels">${i.labels.map((l) => `<span class="tag">${l}</span>`).join('')}</span>
        <span class="img-tools">
          <a class="btn sm" href="${i.url}" target="_blank" rel="noopener">下载</a>
          <button class="btn sm" data-sha="${i.sha256}">复制 SHA256</button>
        </span>
      </div>`).join('');
    tools.innerHTML = d.tools.length ? d.tools.map((t) => `
      <div class="img-row">
        <a class="img-name" href="${t.url}" target="_blank" rel="noopener">${t.name}</a>
        <span class="img-labels">${t.labels.map((l) => `<span class="tag">${l}</span>`).join('')}</span>
        <span class="img-tools">
          <a class="btn sm" href="${t.url}" target="_blank" rel="noopener">下载</a>
        </span>
      </div>`).join('') + `<p class="dl-hint">以上工具包只能在 x86_64 Linux 上运行。想要带上自定义插件的固件，
        就把它的地址和你选好的配置一起丢给一台 Linux / 云主机，或直接沿用站点生成的 GitHub Actions 工作流。</p>` : '';
    $$('#officialImages [data-sha], #officialTools [data-sha]').forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.sha);
          toast('SHA256 已复制');
        } catch (e) { toast('复制失败，请手动选取', true); }
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="mini bad">读取失败：${e.message}</div>`;
  }
}

async function checkIB() {
  $('#ibState').innerHTML = '<span class="spin"></span> 检测中…';
  const d = await api(`/api/ib?distro=${state.distro}&version=${encodeURIComponent(state.version)}`
    + `&target=${encodeURIComponent(state.target)}&sub=${encodeURIComponent(state.subtarget)}`);
  state.ib = d;
  if (d.ok) {
    $('#ibState').innerHTML = `<span class="ok">✓ 可用</span><div class="mini">${d.filename}</div>`;
    $('#engineIbNote').textContent = '3~10 分钟出固件 · 磁盘 <2GB';
    $('#engineIbWrap').classList.remove('disabled');
  } else {
    $('#ibState').innerHTML = `<span class="bad">✗ 该版本无 ImageBuilder</span>
      <div class="mini">${(d.tried || []).slice(0, 3).join(' ')}</div>
      <div class="mini">请切到「源码全编译」或换一个版本/设备</div>`;
    $('#engineIbWrap').classList.add('disabled');
    document.querySelector('input[value="src"]').checked = true;
  }
  renderSummary();
}

// ---------------------------------------------------------------- Step 4

async function loadPackages() {
  if (!state.archPackages) { $('#pkgHint').textContent = '未识别包架构，无法读取软件索引'; return; }
  $('#pkgHint').textContent = '正在读取该版本的软件索引（首次需联网抓取，随后走缓存）…';
  try {
    const d = await api(`/api/packages?distro=${state.distro}&version=${encodeURIComponent(state.version)}&arch=${encodeURIComponent(state.archPackages)}`);
    state.plugins = d.plugins || [];
    $('#pkgHint').innerHTML = `包管理器 <b>${d.manager}</b> · 该版本软件源共 <b>${d.indexCount}</b> 个包`
      + ` · 候选插件 <b>${state.plugins.length}</b> 项${d.cached ? '（来自缓存）' : ''}`;
    renderCatFilters();
    renderPlugins();
    renderSummary();
  } catch (e) {
    $('#pkgHint').textContent = '软件索引读取失败：' + e.message;
  }
}

let curCat = 'all';
function renderCatFilters() {
  const box = $('#catFilters');
  box.innerHTML = '';
  const known = [
    { id: 'all', label: '全部' },
    { id: 'proxy', label: '代理' }, { id: 'dns', label: 'DNS' }, { id: 'vpn', label: 'VPN' },
    { id: 'network', label: '网络' }, { id: 'storage', label: '存储/下载' },
    { id: 'system', label: '系统' }, { id: 'theme', label: '主题' }, { id: 'i18n', label: '汉化' },
  ];
  for (const c of known) {
    const b = document.createElement('button');
    b.className = 'chip' + (curCat === c.id ? ' on' : '');
    b.textContent = c.label;
    b.onclick = () => { curCat = c.id; renderCatFilters(); renderPlugins(); };
    box.appendChild(b);
  }
}

function badgeHtml(p) {
  if (p.source === 'third') return '<span class="bd third">第三方源码</span>';
  if (p.state === 'missing') return '<span class="bd bad">该版本源没有</span>';
  if (p.state === 'partial') return '<span class="bd warn">部分缺失</span>';
  if (p.state === 'ok') return '<span class="bd ok">官方源有</span>';
  if (p.source === 'repo') return '<span class="bd repo">版本自带</span>';
  return '';
}

function renderPlugins() {
  const kw = ($('#pkgSearch').value || '').toLowerCase().trim();
  const list = $('#pkgList');
  list.innerHTML = '';
  const shown = state.plugins.filter((p) => {
    if (curCat !== 'all' && p.cat !== curCat) return false;
    if (p.source === 'repo' && !state.showDiscovered) return false;
    if (!kw) return true;
    const hay = [p.id, p.label, (p.pkgs || []).join(' '), p.desc].join(' ').toLowerCase();
    return hay.includes(kw);
  });
  for (const p of shown) {
    const id = p.id;
    const row = document.createElement('label');
    row.className = 'pkg' + (state.selected.has(id) ? ' on' : '');
    const size = (p.sizeMB || 0);
    row.innerHTML = `
      <input type="checkbox" ${state.selected.has(id) ? 'checked' : ''}>
      <div class="pkg-main">
        <div class="pkg-title">${p.label}${badgeHtml(p)}</div>
        <div class="pkg-desc">${p.desc || ''}</div>
        <code>${(p.pkgs || []).join(' ')}</code>
        ${p.warn ? `<div class="pkg-warn">⚠ ${p.warn}</div>` : ''}
        ${p.state === 'partial' ? `<div class="pkg-warn">该版本缺少：${(p.missing || []).join(' ')}</div>` : ''}
      </div>
      <div class="pkg-size">${size ? size + ' MB' : '—'}</div>`;
    row.querySelector('input').onchange = (e) => {
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      row.classList.toggle('on', e.target.checked);
      updatePkgBar();
      renderSummary();
    };
    list.appendChild(row);
  }
  if (!shown.length) list.innerHTML = '<div class="empty">没有匹配的插件</div>';
  updatePkgBar();
}

function updatePkgBar() {
  let n = 0, size = 0;
  for (const id of state.selected) {
    const p = state.plugins.find((x) => x.id === id);
    if (!p) continue;
    n++; size += (p.sizeMB || 0);
  }
  $('#selCount').textContent = n;
  $('#selSize').textContent = Math.round(size);
  state.packagesSizeMB = Math.round(size);
}

function selectedPackageNames() {
  const out = [];
  for (const id of state.selected) {
    const p = state.plugins.find((x) => x.id === id);
    if (!p) continue;
    out.push(...(p.pkgs || []));
    if (p.deps) out.push(...p.deps);
  }
  return Array.from(new Set(out));
}

// 第三方软件源
function renderRepos() {
  const box = $('#repoList');
  box.innerHTML = '';
  if (!state.repos.length) box.innerHTML = '<span class="mini">尚未添加第三方软件源</span>';
  for (const r of state.repos) {
    const el = document.createElement('span');
    el.className = 'repo-chip';
    el.innerHTML = `<b>${r.name}</b><code>${r.url}</code>`;
    const x = document.createElement('b');
    x.textContent = '✕'; x.className = 'x'; x.onclick = () => {
      state.repos = state.repos.filter((q) => q !== r); renderRepos(); renderSummary();
    };
    el.appendChild(x);
    box.appendChild(el);
  }
}

// ---------------------------------------------------------------- Step 5 / 6

function buildSpec() {
  const wanProto = $('#wanProto').value;
  return {
    engine: (document.querySelector('input[name="engine"]:checked') || {}).value || 'ib',
    distro: state.distro,
    version: state.version,
    refPolicy: state.refPolicy,
    target: state.target,
    subtarget: state.subtarget,
    profile: state.profile,
    archPackages: state.archPackages,
    packages: selectedPackageNames(),
    packagesSizeMB: state.packagesSizeMB || 0,
    excludes: [],
    customRepos: state.repos,
    ipv6: $('#ipv6').value === '1',
    wanInput: $('#wanInput').value,
    userScript: $('#userScript').value,
    image: {
      rootfsSizeMB: Number($('#rootSize').value) || 1024,
      kernelSizeMB: Number($('#kernelSize').value) || 32,
    },
    system: {
      hostname: $('#hostname').value,
      loginName: $('#loginName').value,
      password: $('#rootPass').value,
      loginPassword: $('#loginPass').value,
      timezone: 'CST-8',
      zonename: 'Asia/Shanghai',
    },
    network: {
      mode: $('#netMode').value,
      lanIp: $('#lanIp').value,
      lanNetmask: $('#lanMask').value,
      wanProto,
      pppoeUser: $('#pppoeUser').value,
      pppoePass: $('#pppoePass').value,
      wanIp: $('#wanIp').value,
      wanGateway: $('#wanGw').value,
      wanDns: $('#wanDns').value,
      bypassIp: $('#bypassIp').value,
      bypassGateway: $('#bypassGw').value,
      bypassDns: $('#bypassDns').value,
      wanPorts: ($('#wanPort').value || '').split(/\s+/).filter(Boolean),
      lanPorts: ($('#lanPorts').value || '').split(/\s+/).filter(Boolean),
    },
  };
}

function renderSummary() {
  const s = buildSpec();
  const rows = [
    ['发行版', state.distro === 'openwrt' ? 'OpenWrt 官方' : 'ImmortalWrt'],
    ['版本', state.version],
    ['设备', `${state.target}/${state.subtarget}`],
    ['PROFILE', state.profile],
    ['包架构', state.archPackages || '—'],
    ['插件', `${state.selected.size} 个 / ${selectedPackageNames().length} 个包`],
    ['第三方源', `${state.repos.length} 个`],
    ['根分区', `${s.image.rootfsSizeMB} MB`],
    ['WAN', s.network.wanProto],
    ['IPv6', s.ipv6 ? '开' : '关'],
  ];
  $('#summary').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

async function refreshPreview() {
  const spec = buildSpec();
  renderSummary();
  // 校验
  try {
    const v = await post('/api/validate', spec);
    const err = $('#errBox'), warn = $('#warnBox');
    if (v.errors && v.errors.length) {
      err.innerHTML = '<b>必须处理：</b><ul>' + v.errors.map((x) => `<li>${x}</li>`).join('') + '</ul>';
      err.hidden = false;
    } else err.hidden = true;
    if (v.warnings && v.warnings.length) {
      warn.innerHTML = '<b>建议注意：</b><ul>' + v.warnings.map((x) => `<li>${x}</li>`).join('') + '</ul>';
      warn.hidden = false;
    } else warn.hidden = true;
  } catch (e) { toast('校验失败：' + e.message, true); }

  try {
    const p = await post('/api/preview', spec);
    state.files = p.files;
    $('#estimate').innerHTML = `<b>${p.estimate.human}</b><br>磁盘约 ${p.estimate.diskGB} GB`
      + (p.estimate.heavyHitters && p.estimate.heavyHitters.length
        ? `<br><span class="mini">耗时大户：${p.estimate.heavyHitters.join('、')}</span>` : '')
      + `<br><span class="mini">${p.estimate.note}</span>`;
    renderTabs();
    $('#btnZip').disabled = false;
  } catch (e) {
    toast('预览失败：' + e.message, true);
    $('#btnZip').disabled = true;
  }
}

function renderTabs() {
  const box = $('#fileTabs');
  box.innerHTML = '';
  state.files.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === 0 ? ' on' : '');
    b.textContent = f.path.split('/').pop();
    b.title = f.path;
    b.onclick = () => {
      $$('#fileTabs .chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('#fileBody').textContent = f.content;
    };
    box.appendChild(b);
  });
  if (state.files[0]) $('#fileBody').textContent = state.files[0].content;
}

// ---------------------------------------------------------------- 事件绑定

function bind() {
  $$('.step').forEach((a) => { a.onclick = () => goto(a.dataset.step); });

  $('#versionSel').onchange = () => {
    state.version = $('#versionSel').value;
    loadTargets();
  };
  $('#refPolicy').onchange = () => { state.refPolicy = $('#refPolicy').value; renderSummary(); };

  $('#profileSearch').oninput = renderProfileList;
  $('#pkgSearch').oninput = renderPlugins;
  $('#showRepoDiscovered').onchange = (e) => { state.showDiscovered = e.target.checked; renderPlugins(); };
  $('#pkgClear').onclick = () => { state.selected.clear(); renderPlugins(); renderSummary(); };
  $('#pkgRecommended').onclick = () => {
    for (const id of RECOMMENDED) {
      if (state.plugins.find((p) => p.id === id)) state.selected.add(id);
    }
    renderPlugins(); renderSummary(); toast('已载入推荐组合');
  };

  $('#repoAdd').onclick = () => {
    const url = $('#repoUrl').value.trim();
    if (!url) return toast('请填写软件源地址', true);
    const name = $('#repoName').value.trim() || `repo${state.repos.length + 1}`;
    state.repos.push({ id: 'r' + Date.now(), name, url: url.replace(/\/+$/, '') });
    $('#repoUrl').value = ''; $('#repoName').value = '';
    renderRepos(); renderSummary();
  };
  $('#repoTest').onclick = async () => {
    const url = $('#repoUrl').value.trim().replace(/\/+$/, '');
    if (!url) return toast('请填写软件源地址', true);
    $('#repoTestOut').textContent = '测试中…';
    const d = await post('/api/repo/test', { url });
    $('#repoTestOut').textContent = [
      `结果：${d.ok ? '✓ 可用' : '✗ 不可用'}   类型：${d.manager || '未知'}   包数：${d.count < 0 ? '不可在线清点' : d.count}`,
      ...(d.checked || []), d.error ? d.error : '',
      d.sample ? '示例包名：' + d.sample.slice(0, 15).join(' ') : '',
    ].filter(Boolean).join('\n');
  };

  const onNet = () => {
    const m = $('#netMode').value, w = $('#wanProto').value;
    document.querySelectorAll('.pppoe-only').forEach((e) => e.classList.toggle('hid', w !== 'pppoe'));
    document.querySelectorAll('.static-only').forEach((e) => e.classList.toggle('hid', w !== 'static'));
    document.querySelectorAll('.bypass-only').forEach((e) => e.classList.toggle('hid', m !== 'bypass'));
  };
  ['#netMode', '#wanProto'].forEach((s) => $(s).addEventListener('change', onNet));
  ['#hostname', '#loginName', '#rootPass', '#loginPass', '#lanIp', '#lanMask', '#rootSize', '#kernelSize', '#ipv6', '#wanInput', '#userScript',
    '#pppoeUser', '#pppoePass', '#wanIp', '#wanGw', '#wanDns', '#bypassIp', '#bypassGw', '#bypassDns', '#wanPort', '#lanPorts']
    .forEach((s) => $(s).addEventListener('input', () => clearTimeout(window.__t) || (window.__t = setTimeout(renderSummary, 300))));

  $$('input[name="engine"]').forEach((r) => r.addEventListener('change', () => refreshPreview()));

  $('#btnZip').onclick = async () => {
    try {
      const r = await fetch('/api/zip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildSpec()),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.distro}-${state.version}-${state.target}-${state.subtarget}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('构建包已下载');
    } catch (e) { toast('打包失败：' + e.message, true); }
  };

  $('#presetSave').onclick = async () => {
    const name = $('#presetName').value.trim() || 'default';
    await post('/api/preset/save', { name, spec: { ...buildSpec(), selectedPluginIds: Array.from(state.selected), repos: state.repos } });
    toast('已保存：' + name);
    loadPresets();
  };
  $('#presetLoad').onclick = loadPresets;

  $('#ghSave').onclick = ghSave;
  $('#ghStart').onclick = ghStart;
  onNet();
}

// ---------------------------------------------------------------- 在线构建（GitHub Actions）

const GH_STATE = {
  pushing: ['推送构建包到 GitHub…', 'run'],
  dispatching: ['已推送，正在触发工作流…', 'run'],
  queued: ['已触发，等待 runner 接单…', 'run'],
  in_progress: ['正在编译，这一步通常要几分钟到一小时', 'run'],
  completed: ['已完成', 'done'],
  failed: ['失败', 'fail'],
  unknown: ['触发了但查不到运行记录', 'fail'],
};

async function ghLoadConfig() {
  try {
    const c = await api('/api/build/config');
    if (c.repo) $('#ghRepo').value = c.repo;
    $('#ghAccount').textContent = c.hasToken
      ? `已保存 Token（来源：${c.source === 'env' ? '环境变量' : '本地文件'}）`
      : '未配置，请先填 Token 并保存';
  } catch (e) { /* 首屏失败无所谓，用户点按钮时会再提示 */ }
}

async function ghSave() {
  const repo = $('#ghRepo').value.trim();
  const token = $('#ghToken').value.trim();
  if (!repo) return toast('请填 owner/repo 形式的仓库地址', true);
  if (!token && !/已保存/.test($('#ghAccount').textContent)) return toast('请填写 Token', true);
  $('#ghAccount').textContent = '校验中…';
  try {
    const r = await post('/api/build/config', { repo, token: token || undefined });
    if (!r.ok) return toast('保存失败：' + r.error, true);
    $('#ghToken').value = '';
    $('#ghAccount').textContent = `已保存 · 身份 ${r.login} · 仓库 ${r.repo}`;
    toast('凭据校验通过');
  } catch (e) { toast('保存失败：' + e.message, true); }
}

async function ghStart() {
  const box = $('#ghStatus');
  if (!state.version || !state.target) return toast('请先把版本和设备选完', true);
  box.classList.add('on');
  box.innerHTML = `<div class="gh-bar"><span class="spin"></span><span>生成构建包并推送到 GitHub…</span></div>`;
  try {
    const meta = await post('/api/build/start', buildSpec());
    if (meta.error) throw new Error(meta.error);
    window.__buildId = meta.id;
    ghPoll();
  } catch (e) {
    box.innerHTML = `<div class="gh-bar"><span class="state fail">启动失败</span>
      <span class="mini">${e.message}</span></div>`;
    toast('在线构建启动失败', true);
  }
}

let __polling = false;
async function ghPoll() {
  if (__polling) return;
  __polling = true;
  const box = $('#ghStatus');
  const done = ['completed', 'failed', 'unknown'];
  try {
    for (let i = 0; i < 900; i++) { // 最多盯 75 分钟（大产物回传慢）
      const m = await api('/api/build/status?id=' + encodeURIComponent(window.__buildId));
      ghRender(m);
      // terminal 表示服务端已收尾（日志/产物都拉完），再轮询下去只是空转
      if (m.terminal) break;
      // 云端跑完但产物还在后台回传时不能停，否则前台看不到进度条走完
      const stillPulling = (m.files || []).some((f) => f.pulling);
      if (done.includes(m.state) && !stillPulling) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  } catch (e) {
    box.innerHTML = `<div class="gh-bar"><span class="state fail">状态查询中断</span>
      <span class="mini">${e.message}</span></div>`;
  } finally {
    __polling = false;
  }
}

/** 日志里含 <>，直接 innerHTML 会被当前标签吞掉 */
function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function ghRender(m) {
  const [label, cls] = GH_STATE[m.state] || [m.state, 'run'];
  const failed = m.state === 'failed' || (m.conclusion && m.conclusion !== 'success');
  const headCls = failed ? 'fail' : (m.state === 'completed' ? 'done' : cls);

  let html = `<div class="gh-bar">
    <span class="state ${headCls}">${failed ? (m.state === 'failed' ? '失败' : '结束（结论 ' + m.conclusion + '）') : label}</span>
    ${m.repo ? `<span class="mini">${m.repo} · ${m.summary.target}/${m.summary.subtarget}</span>` : ''}
    <span class="spacer"></span>
    ${m.runUrl ? `<a class="btn sm" href="${m.runUrl}" target="_blank" rel="noopener">在 GitHub 查看日志</a>` : ''}
  </div>`;

  if (m.error) html += `<div class="gh-bar" style="margin-top:8px"><span class="mini">${escHtml(m.error)}</span></div>`;

  // 失败时把云端日志的报错行直接摊开：不用再去 GitHub 翻几百行 make 输出
  if (failed && m.errorLines && m.errorLines.length) {
    html += `<div class="gh-fail">
      <div class="mini">失败原因（云端日志摘要 · ${escHtml(m.logFile || 'log')}）：</div>
      <pre class="gh-log">${escHtml(m.errorLines.join('\n'))}</pre>
      ${m.logTail ? `<details><summary class="mini">展开日志尾部（共 ${m.logLines} 行）</summary>
        <pre class="gh-log">${escHtml(m.logTail)}</pre></details>` : ''}
    </div>`;
  }

  // job / step 进度
  if (m.jobs && m.jobs.length) {
    html += '<div class="gh-steps">';
    for (const j of m.jobs) {
      for (const s of j.steps || []) {
        const sc = s.conclusion === 'success' ? 'done' : s.conclusion === 'failure' ? 'fail' : (s.status === 'in_progress' ? 'run' : '');
        html += `<div class="gh-step ${sc}"><span class="dot"></span>
          <span class="nm">${s.name}</span>
          <span class="mini">${sc === 'done' ? '完成' : sc === 'fail' ? '失败' : sc === 'run' ? '进行中' : '等待'}</span></div>`;
      }
    }
    html += '</div>';
  }

  // 拉回本地的产物
  if (m.files && m.files.length) {
    html += '<div class="gh-steps" style="margin-top:9px">';
    for (const f of m.files) {
      if (f.error) {
        html += `<div class="gh-step fail"><span class="dot"></span><span class="nm">${f.name}</span>
          <span class="mini">拉取失败：${f.error}</span></div>`;
        continue;
      }
      if (f.pulling) {
        // 后台正在回传：显示断点续传的进度，别让人以为卡住了
        const mb = (n) => (Number(n) / 1048576).toFixed(1);
        const pct = f.total ? Math.min(99, Math.floor((f.written / f.total) * 100)) : 0;
        html += `<div class="gh-step run"><span class="dot"></span>
          <span class="nm">${f.name}<span class="mini"> · 正在回传 ${mb(f.written)} / ${f.total ? mb(f.total) + ' MB' : '未知大小'}（${pct}%）</span></span>
          <span class="mini">${f.resumed ? '已续传 ' + mb(f.resumed) + ' MB · ' : ''}回传中，可继续等待或先关页面</span></div>`;
        continue;
      }
      const url = `/api/build/file?id=${encodeURIComponent(m.id)}&name=${encodeURIComponent(f.file)}`;
      html += `<div class="gh-step done"><span class="dot"></span>
        <span class="nm">${f.name}<span class="mini"> · ${(f.size / 1048576).toFixed(1)} MB</span></span>
        <a class="btn sm" href="${url}">下载到本地</a></div>`;
    }
    html += '</div>';
  } else if (m.state === 'completed') {
    html += `<div class="gh-bar" style="margin-top:8px"><span class="mini">${
      m.logTail ? '工作流在中途失败，没有产出 Artifact（原因见上方摘要）。'
        : '这次运行没有产出 Artifact（工作流可能在中途失败，建议点上方按钮看 GitHub 日志）。'
    }</span></div>`;
  }
  $('#ghStatus').innerHTML = html;
  $('#ghStatus').classList.add('on');
}

async function loadPresets() {
  const d = await api('/api/preset/list');
  const box = $('#presetList');
  box.innerHTML = '';
  for (const f of d.presets) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = f.replace('.json', '');
    b.onclick = async () => {
      const s = await api('/api/preset/load?name=' + encodeURIComponent(f.replace('.json', '')));
      applySpec(s);
      toast('已载入 ' + f);
    };
    box.appendChild(b);
  }
}

function applySpec(s) {
  state.distro = s.distro || state.distro;
  state.version = s.version || state.version;
  state.target = s.target || '';
  state.subtarget = s.subtarget || '';
  state.profile = s.profile || '';
  state.refPolicy = s.refPolicy || 'tag';
  $('#refPolicy').value = state.refPolicy;
  if (s.system) {
    $('#hostname').value = s.system.hostname || '';
    $('#loginName').value = s.system.loginName || '';
    $('#rootPass').value = s.system.password || '';
    $('#loginPass').value = s.system.loginPassword || '';
  }
  if (s.network) {
    $('#lanIp').value = s.network.lanIp || '192.168.1.1';
    $('#lanMask').value = s.network.lanNetmask || '255.255.255.0';
    $('#wanProto').value = s.network.wanProto || 'dhcp';
    $('#pppoeUser').value = s.network.pppoeUser || '';
    $('#pppoePass').value = s.network.pppoePass || '';
    $('#bypassIp').value = s.network.bypassIp || '';
    $('#bypassGw').value = s.network.bypassGateway || '';
    $('#bypassDns').value = s.network.bypassDns || '';
    $('#netMode').value = s.network.mode || 'router';
    $('#wanPort').value = (s.network.wanPorts || []).join(' ');
    $('#lanPorts').value = (s.network.lanPorts || []).join(' ');
  }
  if (s.image) { $('#rootSize').value = s.image.rootfsSizeMB; $('#kernelSize').value = s.image.kernelSizeMB; }
  $('#ipv6').value = s.ipv6 === false ? '0' : '1';
  $('#wanInput').value = s.wanInput || 'reject';
  $('#userScript').value = s.userScript || '';
  state.repos = s.repos || s.customRepos || [];
  renderRepos();
  const restoreSel = () => {
    state.selected = new Set(s.selectedPluginIds || []);
    renderPlugins();
  };
  window.__pendingSel = restoreSel;
  loadVersions().then(() => { if (window.__pendingSel) { window.__pendingSel(); window.__pendingSel = null; } });
}

// ---------------------------------------------------------------- 启动

// 数据未到位前给下拉框一个占位项，避免用户看到空控件以为坏了
function markLoading(sel, text) {
  const s = $(sel);
  if (!s) return;
  s.innerHTML = '';
  const o = document.createElement('option');
  o.value = '';
  o.textContent = text || '加载中…';
  s.appendChild(o);
}

(async function boot() {
  bind();
  goto(1); // 首屏先落地，不等任何网络请求
  renderRepos();
  loadPresets();
  ghLoadConfig();

  // 设备/插件就绪后自动跑一次预览。轮询要在加载链之前挂上，
  // 否则会被下面长达数十秒的元数据抓取挡住。
  const timer = setInterval(() => {
    if (state.plugins.length && state.profile) {
      clearInterval(timer);
      refreshPreview();
    }
  }, 800);
  window.__autoPreview = timer;

  markLoading('#versionSel');
  markLoading('#seriesSel', '加载中…');
  markLoading('#targetSel');
  markLoading('#subSel');
  markLoading('#profileSel');

  try {
    await loadDistros();
  } catch (e) {
    $('#distroGrid').innerHTML = `<div class="distro"><b>加载失败</b><span>${e.message}</span>
      <em>请检查网络后刷新页面</em></div>`;
    toast('发行版列表加载失败', true);
  }

  // 版本 → 设备 → 插件是一条依赖链，必须串行；但任一段失败不应拖垮整页，
  // 所以放在各自的 try 里，后面的步骤仍能手工进入。
  try {
    await loadVersions();
  } catch (e) {
    toast('版本/设备数据加载失败：' + e.message, true);
  }
})().catch((e) => toast('初始化失败：' + e.message, true));
