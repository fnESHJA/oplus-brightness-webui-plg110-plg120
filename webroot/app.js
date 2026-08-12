import { exec, toast } from './ksu.js';

const MODULE = '/data/adb/modules/oplus_brightness_control';
const ctl = `${MODULE}/bin/configctl`;
const content = document.querySelector('#content');
const saveButton = document.querySelector('#saveButton');
const dirtyCount = document.querySelector('#dirtyCount');
const statusPill = document.querySelector('#statusPill');
const deviceLine = document.querySelector('#deviceLine');
const helpDialog = document.querySelector('#helpDialog');
const resultDialog = document.querySelector('#resultDialog');

let config = null;
let status = {};
let page = 'home';
let dirty = new Set();
let installedPackages = [];
let dragPoint = -1;
let curveResizeHandler = null;
let curveFullscreenHandler = null;
let saving = false;
let mappingRows = null;
let mappingRowsByLevel = new Map();
let mappingDbvGroupSizes = new Map();
let mappingPageIndex = 0;
let mappingFilter = '';
let mappingReverse = false;
const mappingPageSize = 100;
const curveView = { xZoom: 1, xPan: 0, yZoom: 1, yPan: 0 };
const mappingView = { zoom: 1, pan: 0 };

const pageKeys = {
  home: ['manual_max_level', 'auto_curve'],
  hbm: ['hbm_lux', 'hbm_cct', 'hbm_lux_table_mode'],
  apps: [
    'global_limit', 'global_exceptions', 'uir_enable', 'uir_brightness_limit', 'uir_temperature_limit', 'uir_max_ratio', 'uir_apps',
    'foss_enable', 'foss2_apps', 'foss2_switch', 'foss2_ratio', 'foss4_apps', 'foss4_switch', 'foss4_ratio',
    ...[2, 3, 4, 6, 8].flatMap(id => methodKeys(id)), 'window_limit', 'window_apps'
  ],
  games: [...methodKeys(4), 'game_brightness_nit', 'game_brightness_ratio', 'game_brightness_rate',
    'game_edr_25_origin', 'game_edr_25_enhance', 'game_edr_27_origin', 'game_edr_27_enhance', 'adfr_apps'],
  thermal: ['voltage_matrix', 'force_temperature_limit', 'uir_temperature_limit', 'dolby_temperature_nits'],
  advanced: ['dark_env_support', 'dark_env_lux', 'dark_env_scale', 'light_sensor_always_on_support', 'BrightnessHalfVsync',
    'DualRampAnimatorOpt', 'dual_light_sensor_fusion_support', 'dark_env_brightness_smooth_optimize_support',
    'comfortable_motion_support', 'comfortable_thresholds', 'backlight_luxs', 'backlight_app_levels', 'backlight_dur_levels',
    'backlight_max_lux', 'adfr_panelnit_enable', 'adfr_sensor_inlux', 'adfr_sensor_outlux', 'adfr_panelnit_level',
    'adfr_aod_panelnit_level', 'dbi_enable', 'dbi_app_list_enable', 'dbi_apps', 'dbi_capture_interval'],
  mapping: ['mapping_edit_mode', 'mapping_shared_dbv_propagation', 'mapping_nit_multiplier', 'mapping_dbv_multiplier', 'mapping_overrides'],
  calibration: ['demura_global_status', 'demura_global_gain', 'demura_aoi', 'eyeprotect_profiles', 'dbvgain_entries'],
  settings: ['unsafe_mode', 'unsafe_acknowledgement']
};

const titles = {
  home: ['主页', '调整手动上限和自动亮度曲线。配置目标不等于面板实测亮度。'],
  hbm: ['HBM 触发条件', 'HBM 决定高环境光高亮通路的触发条件；修改需要危险模式，不会绕过温度、电池和面板限制。'],
  apps: ['应用亮度策略', '管理全局限制、UIR、FOSS、场景名单和窗口限亮。名单中的相同应用可能叠加多种策略。'],
  games: ['游戏亮度与 EDR', 'method 4 是游戏名单；factor 25/27 是所有名单内游戏共用的全局 EDR 曲线。'],
  thermal: ['温度与电池', '这些保护可能覆盖所有提亮设置。放宽原厂保护必须开启危险模式。'],
  advanced: ['其他亮度与联动', '暗环境、光感、动画、统计、ADFR 和 DBI。部分项目影响功耗或刷新率，并不直接提亮。'],
  mapping: ['亮度映射', '查看 brightness_table 与 Apollo 的完整请求范围；倍率和单行覆盖均属于危险操作。'],
  calibration: ['硬件标定', 'DBV/Gamma、Demura 和 EyeProtect。错误值可能造成黑屏、色偏或显示异常。'],
  settings: ['设置与备份', '管理危险模式、配置导入导出、原厂恢复、路径和运行状态。']
};

function methodKeys(id) {
  const keys = [`method${id}_apps`, `method${id}_switch`];
  for (const mode of [0, 1]) for (const name of ['nit', 'ratio', 'rate_in', 'rate_out']) keys.push(`method${id}_${name}${mode}`);
  return keys;
}

const clone = value => JSON.parse(JSON.stringify(value));
const setting = key => config && config[key] && typeof config[key] === 'object' ? config[key] : null;
const value = key => setting(key)?.value;
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const axisText = number => {
  const n = Number(number);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000000) return `${Number((n / 1000000).toFixed(1))}M`;
  if (Math.abs(n) >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
  return String(Number(n.toFixed(Math.abs(n) < 10 ? 2 : 1)));
};

function markDirty(key) {
  dirty.add(key);
  dirtyCount.textContent = dirty.size;
  saveButton.disabled = saving;
}

function setValue(key, next) {
  if (!setting(key)) return;
  config[key].value = next;
  markDirty(key);
}

function canonicalJson(data) {
  const lines = ['{'];
  const emitted = new Set();
  const metadata = ['schema_version', 'device_fingerprint', 'target_etc', 'brightness_file', 'apollo_file', 'sensor_file',
    'app_policy_original_max', 'safe_nit_max', 'panel_mapping_max_nit', 'panel_mapping_max_dbv', 'mapping_relationship', 'mapping_relationship_stats'];
  const gameKeys = new Set(pageKeys.games);
  const appKeys = pageKeys.apps.filter(key => !gameKeys.has(key));
  const sections = [metadata, pageKeys.home, pageKeys.hbm, appKeys, pageKeys.games, pageKeys.thermal,
    pageKeys.advanced, pageKeys.mapping, pageKeys.calibration, pageKeys.settings];
  const emit = keys => {
    let count = 0;
    for (const key of keys) {
      if (key === '_end' || emitted.has(key) || !Object.hasOwn(data, key)) continue;
      lines.push(`  ${JSON.stringify(key)}:${JSON.stringify(data[key])},`);
      emitted.add(key); count++;
    }
    if (count) lines.push('');
  };
  sections.forEach(emit);
  emit(Object.keys(data));
  if (lines.at(-1) === '') lines.pop();
  lines.push('  "_end":true', '}');
  return `${lines.join('\n')}\n`;
}

function pageTitle() {
  const [name, description] = titles[page];
  return `<div class="page-title"><h2>${name}</h2><p>${description}</p></div>`;
}

function helpButton(key, label) {
  return `<button class="help-button" data-help="${esc(key)}" data-label="${esc(label)}" aria-label="查看说明">?</button>`;
}

function settingCard(key, label, type = 'number', options = {}) {
  const item = setting(key);
  if (!item) return '';
  const current = item.value;
  const original = item.original;
  const disabled = options.disabled || saving ? 'disabled' : '';
  let input;
  if (type === 'toggle') {
    const checked = current === true || Number(current) === 1 ? 'checked' : '';
    input = `<label class="switch"><input class="setting-input" data-key="${key}" data-type="toggle" type="checkbox" ${checked} ${disabled}><span></span></label>`;
  } else if (type === 'list') {
    input = `<textarea class="setting-input" data-key="${key}" data-type="list" ${disabled}>${esc((current || []).join('\n'))}</textarea>`;
  } else if (type === 'csv') {
    input = `<input class="setting-input" data-key="${key}" data-type="csv" type="text" value="${esc((current || []).join(','))}" ${disabled}>`;
  } else if (type === 'lines') {
    input = `<textarea class="setting-input" data-key="${key}" data-type="lines" ${disabled}>${esc((current || []).join('\n'))}</textarea>`;
  } else {
    const step = options.step ?? (type === 'number' ? 'any' : '');
    input = `<input class="setting-input" data-key="${key}" data-type="${type}" type="${type}" value="${esc(current)}" ${step ? `step="${step}"` : ''} ${disabled}>`;
  }
  const range = item.safe_range && Array.isArray(item.safe_range) ? `${item.safe_range[0]} ～ ${item.safe_range[1]}` : '由结构和关联项校验';
  const originalText = Array.isArray(original) ? `${original.length} 项` : String(original ?? '—');
  return `<article class="card ${options.full ? 'full' : ''}">
    <div class="card-head"><h3>${esc(label)}</h3>${helpButton(key, label)}</div>
    <div class="control">${input}<div class="range-line"><span>原厂：${esc(originalText)}</span><span>安全：${esc(range)} ${esc(item.unit || '')}</span></div></div>
    <div class="source">${esc(item.source || '')}</div>
  </article>`;
}

function group(title, body, open = false) {
  return `<details class="group" ${open ? 'open' : ''}><summary>${esc(title)}</summary><div class="group-content"><div class="grid">${body}</div></div></details>`;
}

function resetButton() {
  return `<button class="reset-page" data-reset-page="${page}">恢复本页原厂值</button>`;
}

function curveResetButton(keys, label = '恢复该曲线原厂值') {
  return `<button class="secondary curve-reset" data-reset-keys="${esc(keys.join(','))}">${esc(label)}</button>`;
}

function restoreKeys(keys) {
  for (const key of keys) {
    if (!setting(key)) continue;
    config[key].value = clone(config[key].original);
    markDirty(key);
  }
  render();
}

function normalizeAutoCurve(mark = true) {
  const points = (value('auto_curve') || []).map(point => [Number(point[0]), Number(point[1])]).filter(point => point.every(Number.isFinite));
  const before = JSON.stringify(points);
  points.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < points.length; i++) {
    points[i][0] = Math.max(0, points[i][0]);
    points[i][1] = Math.max(0, points[i][1]);
    if (i) {
      if (points[i][0] <= points[i - 1][0]) points[i][0] = Number((points[i - 1][0] + (Number.isInteger(points[i - 1][0]) ? 1 : .001)).toFixed(3));
      if (points[i][1] < points[i - 1][1]) points[i][1] = points[i - 1][1];
    }
  }
  config.auto_curve.value = points;
  if (mark && before !== JSON.stringify(points)) markDirty('auto_curve');
}

function sortCurveBundle(xKey, companionKeys) {
  const x = value(xKey);
  const companions = companionKeys.map(key => value(key));
  if (!Array.isArray(x) || companions.some(items => !Array.isArray(items) || items.length !== x.length)) return;
  const order = x.map((item, index) => ({ item: Number(item), index })).sort((a, b) => a.item - b.item || a.index - b.index);
  const keys = [xKey, ...companionKeys];
  for (const key of keys) {
    const current = value(key);
    const sorted = order.map(entry => current[entry.index]);
    if (JSON.stringify(current) !== JSON.stringify(sorted)) {
      config[key].value = sorted;
      markDirty(key);
    }
  }
}

function normalizeAllCurves() {
  normalizeAutoCurve();
  for (const id of [2, 3, 4, 6, 8]) for (const mode of [0, 1]) {
    sortCurveBundle(`method${id}_nit${mode}`, [`method${id}_ratio${mode}`, `method${id}_rate_in${mode}`, `method${id}_rate_out${mode}`]);
  }
  sortCurveBundle('game_brightness_nit', ['game_brightness_ratio', 'game_brightness_rate']);
  sortCurveBundle('game_edr_25_origin', ['game_edr_25_enhance']);
  sortCurveBundle('game_edr_27_origin', ['game_edr_27_enhance']);
  sortCurveBundle('dark_env_lux', ['dark_env_scale']);
}

function homePage() {
  const curve = value('auto_curve') || [];
  const maxCurve = curve.reduce((m, point) => Math.max(m, Number(point[1]) || 0), 0);
  const mapping = Number(value('panel_mapping_max_nit') || 0);
  const requested = Math.max(maxCurve, Number(value('global_limit') || 0), Number(value('uir_brightness_limit') || 0));
  const ordinaryEstimate = Math.min(mapping || Infinity, Number(value('global_limit')) || Infinity);
  return `${pageTitle()}
    <div class="card full">
      <div class="metric-row">
        <div class="metric"><strong>${esc(value('safe_nit_max'))}</strong><span>普通模式软上限 nit</span></div>
        <div class="metric"><strong>${esc(mapping)}</strong><span>原厂 Apollo 映射 nit</span></div>
        <div class="metric"><strong>${esc(requested)}</strong><span>当前配置请求 nit</span></div>
      </div>
      <p class="hint">普通应用保守估算上限约 ${Number.isFinite(ordinaryEstimate) ? ordinaryEstimate : '未知'} nit；实际还会受到当前温度、电量、Dolby、窗口和场景策略影响，例外应用不采用全局上限。</p>
      ${requested > mapping ? '<p class="warning">当前配置目标高于原厂 Apollo 映射。它可能被显示服务或面板钳位，不代表可达到相同的物理亮度。</p>' : ''}
    </div>
    <div class="grid">
      ${settingCard('manual_max_level', '手动亮度最高逻辑等级', 'number')}
      ${curveEditor()}
    </div>${resetButton()}`;
}

function hbmPage() {
  const unlocked = value('unsafe_mode') === true;
  if (!unlocked) {
    return `${pageTitle()}<div class="danger-panel"><strong>HBM 设置已锁定</strong><p>降低触发门限或切换未知策略可能让高亮通路在不合适的环境中工作，增加温升、耗电和烧屏风险。请先在设置页阅读风险并开启危险模式。</p><button class="primary" data-go-settings>前往设置解锁</button></div>${resetButton()}`;
  }
  return `${pageTitle()}
    <div class="danger-panel">危险模式已开启。这里仅改变 HBM 的环境触发条件或厂商策略分支，不会直接指定最终 nit，也不会解除温控、电池、应用限亮或面板映射。</div>
    <div class="grid">
      ${settingCard('hbm_lux', 'HBM 环境照度门限', 'text')}
      ${settingCard('hbm_cct', 'HBM CCT 条件', 'text')}
      ${settingCard('hbm_lux_table_mode', 'HBM 曲线模式编号', 'number')}
    </div>${resetButton()}`;
}

function curveEditor() {
  return `<article id="autoCurveEditor" class="card full">
    <div class="card-head"><h3>自动亮度曲线</h3>${helpButton('auto_curve', '自动亮度曲线')}</div>
    <p class="hint">横轴按 log10(Lux+1) 显示。触摸控制点可修改坐标；触摸曲线空白处可单指上下左右移动视窗、双指缩放，下面四个视窗参数会实时同步。提高某点 nit 后，后续低点会自动抬高。</p>
    <div id="curveLandscapeStage">
      <div class="curve-landscape-head"><strong>自动亮度曲线 · 横屏编辑</strong><span>空白处单指移动 · 双指缩放</span><button id="closeCurveLandscape" class="secondary">退出横屏</button></div>
      <div class="curve-viewport-controls">
        <label>横向缩放 <output id="curveXZoomText">${curveView.xZoom}×</output><input id="curveXZoom" type="range" min="1" max="20" step="0.1" value="${curveView.xZoom}"></label>
        <label>横向位置 <output id="curveXPanText">${curveView.xPan}%</output><input id="curveXPan" type="range" min="0" max="100" step="0.1" value="${curveView.xPan}"></label>
        <label>纵向缩放 <output id="curveYZoomText">${curveView.yZoom}×</output><input id="curveYZoom" type="range" min="1" max="10" step="0.1" value="${curveView.yZoom}"></label>
        <label>纵向位置 <output id="curveYPanText">${curveView.yPan}%</output><input id="curveYPan" type="range" min="0" max="100" step="0.1" value="${curveView.yPan}"></label>
      </div>
      <div class="curve-wrap curve-canvas-wrap"><canvas id="curveCanvas" width="900" height="300"></canvas></div>
    </div>
    <div class="curve-wrap"><table class="curve-table"><thead><tr><th>Lux</th><th>nit</th><th></th></tr></thead><tbody id="curveRows"></tbody></table></div>
    <div class="actions"><button id="openCurveLandscape" class="primary">横屏编辑</button><button id="addCurvePoint">增加坐标</button><button id="sortCurve">排序并修复曲线</button><button id="resetCurveView">重置视口</button>${curveResetButton(['auto_curve'])}</div>
    <div class="source">${esc(setting('auto_curve')?.source)}</div>
  </article>`;
}

function methodGroup(id, title) {
  let body = settingCard(`method${id}_switch`, `${title}开关`, 'toggle') + settingCard(`method${id}_apps`, `${title}应用名单`, 'list', { full: true });
  for (const mode of [0, 1]) {
    body += settingCard(`method${id}_nit${mode}`, `Mode ${mode} nit`, 'csv')
      + settingCard(`method${id}_ratio${mode}`, `Mode ${mode} ratio`, 'csv')
      + settingCard(`method${id}_rate_in${mode}`, `Mode ${mode} rate in`, 'csv')
      + settingCard(`method${id}_rate_out${mode}`, `Mode ${mode} rate out`, 'csv')
      + `<article class="card full curve-tools"><span>Mode ${mode} 四组坐标按 nit 联动排序</span>${curveResetButton([`method${id}_nit${mode}`, `method${id}_ratio${mode}`, `method${id}_rate_in${mode}`, `method${id}_rate_out${mode}`])}</article>`;
  }
  return group(`method ${id} · ${title}`, body, id === 4);
}

function appsPage() {
  const listTargets = ['global_exceptions', 'uir_apps', 'foss2_apps', 'foss4_apps', 'method2_apps', 'method3_apps', 'method4_apps', 'method6_apps', 'method8_apps', 'window_apps'];
  return `${pageTitle()}
    ${group('应用选择器', packagePicker(listTargets), true)}
    ${group('全局应用限亮', settingCard('global_limit', '全局应用亮度上限', 'number') + settingCard('global_exceptions', '全局例外名单', 'list', { full: true }), true)}
    ${group('UIR 应用增强', settingCard('uir_enable', 'UIR 总开关', 'toggle') + settingCard('uir_brightness_limit', 'UIR 亮度触发门限', 'number') + settingCard('uir_temperature_limit', 'UIR 温度门限', 'number') + settingCard('uir_max_ratio', 'UIR 最大增强比例', 'number') + settingCard('uir_apps', 'UIR 白名单', 'list', { full: true }))}
    ${group('FOSS 应用降亮', settingCard('foss_enable', 'FOSS 总开关', 'toggle') + settingCard('foss2_switch', 'Normal/type 2 开关', 'toggle') + settingCard('foss2_ratio', 'Normal/type 2 降亮比例', 'number') + settingCard('foss2_apps', 'Normal/type 2 名单', 'list', { full: true }) + settingCard('foss4_switch', 'Special/type 4 开关', 'toggle') + settingCard('foss4_ratio', 'Special/type 4 降亮比例', 'number') + settingCard('foss4_apps', 'Special/type 4 名单', 'list', { full: true }))}
    ${methodGroup(2, '视频')}${methodGroup(3, '短视频/直播')}${methodGroup(4, '游戏')}${methodGroup(6, '导航/配送')}${methodGroup(8, '阅读/浏览')}
    ${group('窗口亮度名单', settingCard('window_limit', '窗口亮度上限', 'number') + settingCard('window_apps', '窗口应用名单', 'list', { full: true }))}
    ${resetButton()}`;
}

function packagePicker(targets) {
  const options = targets.filter(setting).map(key => `<option value="${key}">${key}</option>`).join('');
  return `<article class="card full package-picker">
    <div class="card-head"><h3>从已安装应用添加包名</h3>${helpButton('global_exceptions', '应用选择器')}</div>
    <select id="packageTarget">${options}</select>
    <input id="packageSearch" class="table-input" type="search" placeholder="搜索包名">
    <div id="packageResults" class="package-results"><p class="hint">正在读取已安装应用…</p></div>
    <div class="control"><input id="manualPackage" type="text" placeholder="也可手动输入 com.example.app"><button id="addManualPackage" class="secondary">添加手动包名</button></div>
  </article>`;
}

function gamesPage() {
  const hasReduction = (value('method4_ratio0') || []).some(v => Number(v) > 0) || (value('method4_ratio1') || []).some(v => Number(v) > 0);
  const hasEnhancement = [25, 27].some(f => (value(`game_edr_${f}_enhance`) || []).some((v, i) => Number(v) > Number((value(`game_edr_${f}_origin`) || [])[i] || 0)));
  return `${pageTitle()}
    <p class="warning">游戏 EDR 没有每游戏独立上限节点。method 4 名单内游戏共用下面两套 factor 曲线。</p>
    ${hasReduction && hasEnhancement ? '<p class="warning">检测到 method 4 降亮与 EDR 增强同时启用：厂商管线可能先降低基础亮度再增强 EDR 内容。保存是允许的，但两者不会相互抵消成一个简单数值。</p>' : ''}
    ${methodGroup(4, '游戏名单与基础降亮')}
    ${group('全局游戏亮度策略', settingCard('game_brightness_nit', '游戏 nit 坐标', 'csv') + settingCard('game_brightness_ratio', '游戏调整比例', 'csv') + settingCard('game_brightness_rate', '游戏过渡速率', 'csv') + `<article class="card full curve-tools">${curveResetButton(['game_brightness_nit', 'game_brightness_ratio', 'game_brightness_rate'])}</article>`, true)}
    ${group('游戏 EDR · factor 25', settingCard('game_edr_25_origin', '原始亮度曲线', 'csv') + settingCard('game_edr_25_enhance', '增强亮度曲线', 'csv') + `<article class="card full curve-tools">${curveResetButton(['game_edr_25_origin', 'game_edr_25_enhance'])}</article>`, true)}
    ${group('游戏 EDR · factor 27', settingCard('game_edr_27_origin', '原始亮度曲线', 'csv') + settingCard('game_edr_27_enhance', '增强亮度曲线', 'csv') + `<article class="card full curve-tools">${curveResetButton(['game_edr_27_origin', 'game_edr_27_enhance'])}</article>`)}
    ${group('刷新率联动名单', `<p class="warning">ADFR 名单控制最低刷新率/直方图策略，不直接控制亮度。</p>${settingCard('adfr_apps', 'ADFR 游戏名单', 'list', { full: true })}`)}
    ${resetButton()}`;
}

function thermalPage() {
  return `${pageTitle()}
    <p class="danger-panel">提高温度门限或低温/低电量 nit 上限会放宽原厂保护。后端会在普通模式拒绝这类修改。</p>
    <div class="grid">${settingCard('force_temperature_limit', '显示强制温控阈值', 'number')}${settingCard('uir_temperature_limit', 'UIR 温度门限', 'number')}${settingCard('dolby_temperature_nits', 'Dolby 0～21 档 nit', 'csv', { full: true })}${voltageEditor()}</div>
    ${resetButton()}`;
}

function voltageEditor() {
  const rows = value('voltage_matrix') || [];
  let html = '';
  rows.forEach((row, rowIndex) => {
    const [temp, ...cells] = row.split('|');
    html += `<tr><td>${esc(temp)}</td><td>`;
    html += cells.map((cell, cellIndex) => {
      const [battery, pair] = cell.split('=');
      const [normal, composite] = pair.split(',');
      return `<div class="metric" style="margin-bottom:6px"><span>${esc(battery)}%</span><div style="display:grid;grid-template-columns:1fr 1fr;gap:5px"><input class="table-input voltage-input" data-row="${rowIndex}" data-cell="${cellIndex}" data-part="0" value="${esc(normal)}" aria-label="普通场景 nit"><input class="table-input voltage-input" data-row="${rowIndex}" data-cell="${cellIndex}" data-part="1" value="${esc(composite)}" aria-label="复合场景 nit"></div></div>`;
    }).join('');
    html += '</td></tr>';
  });
  return `<article class="card full"><div class="card-head"><h3>低温/低电压亮度矩阵</h3>${helpButton('voltage_matrix', '低温/低电压亮度矩阵')}</div><div class="curve-wrap"><table class="matrix-table"><thead><tr><th>温度范围 °C</th><th>电量范围：普通 / 复合 nit</th></tr></thead><tbody>${html}</tbody></table></div><div class="source">${esc(setting('voltage_matrix')?.source)}</div></article>`;
}

function advancedPage() {
  return `${pageTitle()}
    ${group('暗环境降亮', settingCard('dark_env_support', '暗环境降亮开关', 'toggle') + settingCard('dark_env_lux', '暗环境 Lux 坐标', 'csv') + settingCard('dark_env_scale', '暗环境降亮比例', 'csv') + `<article class="card full curve-tools">${curveResetButton(['dark_env_lux', 'dark_env_scale'])}</article>`, true)}
    ${group('光感与动画', settingCard('light_sensor_always_on_support', '光感常开', 'toggle') + settingCard('dual_light_sensor_fusion_support', '双光感融合', 'toggle') + settingCard('dark_env_brightness_smooth_optimize_support', '暗环境平滑优化', 'toggle') + settingCard('DualRampAnimatorOpt', '双亮度动画优化', 'toggle') + settingCard('BrightnessHalfVsync', 'Half Vsync', 'toggle'))}
    ${group('舒适亮度', settingCard('comfortable_motion_support', '运动状态识别', 'toggle') + settingCard('comfortable_thresholds', '六组运动 Lux 阈值', 'csv', { full: true }))}
    ${group('亮度统计（不直接控制亮度）', settingCard('backlight_luxs', '统计 Lux 桶', 'csv') + settingCard('backlight_app_levels', '应用亮度统计层级', 'csv') + settingCard('backlight_dur_levels', '持续时间亮度分档', 'csv') + settingCard('backlight_max_lux', '统计最大 Lux', 'number'))}
    ${group('ADFR 刷新率联动', settingCard('adfr_panelnit_enable', 'Panel nit 识别', 'toggle') + settingCard('adfr_sensor_inlux', '进入暗环境 Lux', 'number') + settingCard('adfr_sensor_outlux', '退出暗环境 Lux', 'number') + settingCard('adfr_panelnit_level', 'Panel nit 分档', 'text') + settingCard('adfr_aod_panelnit_level', 'AOD Panel nit 分档', 'text'))}
    ${group('DBI 显示联动', settingCard('dbi_enable', 'DBI 总开关', 'toggle') + settingCard('dbi_app_list_enable', 'DBI 名单开关', 'toggle') + settingCard('dbi_capture_interval', 'DBI 采集间隔', 'number') + settingCard('dbi_apps', 'DBI 应用名单', 'list', { full: true }))}
    ${resetButton()}`;
}

function mappingPage() {
  const unlocked = value('unsafe_mode') === true;
  const overrideCount = (value('mapping_overrides') || []).length;
  const relationship = value('mapping_relationship');
  const linkedDetected = relationship === 'linked_equal';
  const editMode = value('mapping_edit_mode') || (linkedDetected ? 'linked' : 'separate');
  const linked = editMode === 'linked';
  const propagate = value('mapping_shared_dbv_propagation') === true;
  const relationshipText = linkedDetected
    ? '安装时已逐行验证：两个文件的逻辑 Level 和 nit 全部一一对应且相等。默认合并 nit 编辑；Apollo DBV 仍是独立的物理驱动值。'
    : '安装时发现两个文件的 Level 对齐，但存在不同的 nit。已默认分开编辑，不能强制联动，以免覆盖设备原有差异。';
  return `${pageTitle()}
    <div class="${unlocked ? 'danger-panel' : 'warning'}">${unlocked
      ? '危险模式已开启：可编辑统一倍率和单行最终 DBV/nit。DBV≤4095 等硬限制仍不可解除。'
      : '当前仅查看原厂范围。编辑映射可能导致黑屏、亮度跳变、色偏或面板损伤；需先在设置页开启危险模式。'}</div>
    <article class="card full">
      <div class="card-head"><h3>安装期关系检测</h3>${helpButton('mapping_edit_mode', 'Brightness 与 Apollo 的对应关系')}</div>
      <p class="${linkedDetected ? 'hint' : 'warning'}">${relationshipText}</p>
      <p class="source">检测结果：${esc(relationship)} · ${esc(value('mapping_relationship_stats'))}</p>
      <div class="mapping-mode-controls">
        <div><strong>当前：${linked ? '联动 nit 编辑' : 'Brightness/Apollo nit 分开编辑'}</strong><p class="hint">${linked ? '每个 Level 只显示一个 nit，保存时同时写入两个文件。' : '两个 nit 可不同；框架请求和 Apollo 驱动映射可能出现认知差异。'}</p></div>
        ${linked
          ? `<button id="mappingModeToggle" class="danger" ${unlocked && linkedDetected ? '' : 'disabled'}>强制分开编辑</button>`
          : `<button id="mappingModeToggle" ${unlocked && linkedDetected ? '' : 'disabled'}>${linkedDetected ? '恢复联动编辑' : '原厂不相等，禁止联动'}</button>`}
      </div>
      ${!linked ? '<p class="danger-panel"><strong>分开编辑警告：</strong>brightness nit 通常面向框架/亮度策略，Apollo nit 属于驱动映射标定。两者在原厂相等却被改成不同时，模式切换可能出现亮度跳变、钳位或显示服务采用其中一方。</p>' : ''}
      <label class="mapping-propagation"><input id="mappingPropagation" type="checkbox" ${propagate ? 'checked' : ''} ${unlocked ? '' : 'disabled'}><span><strong>共用 DBV 分级同步</strong><small>修改 DBV 时同步原厂共用该 DBV 的全部 Level，并级联修复前后 DBV 单调性。</small></span>${helpButton('mapping_shared_dbv_propagation', '共用 DBV 分级同步')}</label>
    </article>
    <div id="mappingMetrics" class="card full"><p class="hint">正在读取原厂 brightness_table 与 Apollo 的 4675 级映射…</p></div>
    <article class="card full">
      <div class="card-head"><h3>完整映射曲线（只读）</h3>${helpButton('mapping_overrides', '亮度映射曲线')}</div>
      <p class="hint">曲线展示完整原厂级别和当前倍率/覆盖后的预览；点数较多，因此不允许在图上拖动。请使用下方表格精确编辑。</p>
      <div class="curve-viewport-controls two">
        <label>横向缩放 <output id="mappingZoomText">${mappingView.zoom}×</output><input id="mappingZoom" type="range" min="1" max="30" step="1" value="${mappingView.zoom}"></label>
        <label>横向位置 <output id="mappingPanText">${mappingView.pan}%</output><input id="mappingPan" type="range" min="0" max="100" step="1" value="${mappingView.pan}"></label>
      </div>
      <div class="curve-wrap"><canvas id="mappingCanvas" class="mapping-canvas" width="1000" height="330"></canvas></div>
      <div class="curve-legend"><span class="nit-a">brightness nit</span><span class="nit-b">Apollo nit</span><span class="dbv">Apollo DBV</span></div>
    </article>
    <article class="card full">
      <div class="card-head"><h3>统一乘数</h3>${helpButton('mapping_nit_multiplier', '统一映射倍率')}</div>
      <p class="hint">输入倍率后可一键乘到当前全部值。倍率基于原厂快照编译；现有单行覆盖也会同步乘算，避免出现局部未变。Apollo DBV 超过 4095 时后端会拒绝。</p>
      <div class="mapping-multiply">
        <label>本次乘数<input id="mappingMultiplyFactor" class="table-input" type="number" min="0.01" max="10" step="0.01" value="1.05" ${unlocked ? '' : 'disabled'}></label>
        <button data-mapping-multiply="nit" ${unlocked ? '' : 'disabled'}>所有 nit ×</button>
        <button data-mapping-multiply="dbv" ${unlocked ? '' : 'disabled'}>所有 DBV ×</button>
        <button data-mapping-multiply="both" ${unlocked ? '' : 'disabled'}>nit 与 DBV ×</button>
      </div>
      <div class="metric-row mapping-factor-row">
        <div class="metric"><strong id="mappingNitFactor">${esc(value('mapping_nit_multiplier'))}×</strong><span>当前 nit 总倍率</span></div>
        <div class="metric"><strong id="mappingDbvFactor">${esc(value('mapping_dbv_multiplier'))}×</strong><span>当前 DBV 总倍率</span></div>
        <div class="metric"><strong id="mappingOverrideCount">${overrideCount}</strong><span>单行覆盖数量</span></div>
      </div>
    </article>
    <article class="card full">
      <div class="card-head"><h3>逐级范围与单行编辑</h3>${helpButton('mapping_overrides', '映射单行覆盖')}</div>
      <p class="hint">nit 和 DBV 都必须随 Level 不下降。修改后若越过相邻分级，编辑器会同步抬高后续低值或压低前面高值；开启共用 DBV 同步时，所有使用同一原厂 DBV 的较早/较晚 Level 也会一起更新。</p>
      <div class="mapping-table-tools"><input id="mappingSearch" class="table-input" type="search" placeholder="输入逻辑 level，例如 4095" value="${esc(mappingFilter)}"><button id="mappingReverse" class="secondary">${mappingReverse ? '恢复正序' : '逆序显示'}</button><span id="mappingPageLabel" class="hint"></span></div>
      <div class="curve-wrap mapping-table-wrap"><table class="curve-table mapping-table"><thead><tr>${linked
        ? '<th>Level</th><th>亮度表索引</th><th>联动 nit</th><th>Apollo DBV</th><th>共用 DBV 等级</th><th>状态</th>'
        : '<th>Level</th><th>亮度表索引</th><th>brightness nit</th><th>Apollo DBV</th><th>Apollo nit</th><th>共用 DBV 等级</th><th>状态</th>'}</tr></thead><tbody id="mappingRows"><tr><td colspan="${linked ? 6 : 7}">正在读取…</td></tr></tbody></table></div>
      <div class="actions"><button id="mappingFirst">第一页</button><button id="mappingPrev">上一页</button><button id="mappingNext">下一页</button><button id="mappingLast">最后一页</button>${unlocked ? '' : '<button data-go-settings class="primary">前往设置解锁</button>'}${curveResetButton(['mapping_edit_mode', 'mapping_shared_dbv_propagation', 'mapping_nit_multiplier', 'mapping_dbv_multiplier', 'mapping_overrides'], '恢复完整映射原厂值')}</div>
      <div class="source">${esc(value('brightness_file'))} · ${esc(value('apollo_file'))}</div>
    </article>
    ${resetButton()}`;
}

function calibrationPage() {
  const unlocked = value('unsafe_mode') === true;
  if (!unlocked) {
    return `${pageTitle()}<div class="danger-panel"><strong>硬件标定已锁定</strong><p>请先在设置页阅读风险、创建备份并确认开启危险模式。结构硬限制无法解除。</p><button class="primary" data-go-settings>前往设置</button></div>`;
  }
  return `${pageTitle()}<div class="danger-panel">危险模式已开启。DBV 仍不得超过 4095，Gamma 必须保持 28 项，EyeProtect 色温与 RGB 数量必须一致。</div>
    <div class="grid">${settingCard('demura_global_status', 'Demura 全局开关', 'toggle')}${settingCard('demura_global_gain', 'Demura 全局增益', 'number')}${settingCard('demura_aoi', 'Demura AOI：nit=DBV', 'lines', { full: true })}${settingCard('eyeprotect_profiles', 'EyeProtect 配置', 'lines', { full: true })}${settingCard('dbvgain_entries', 'DBV/Gamma：fps|id|dbv|R|G|B', 'lines', { full: true })}</div>${resetButton()}`;
}

function settingsPage() {
  const unsafe = value('unsafe_mode') === true;
  return `${pageTitle()}
    <div class="grid">
      <article class="card full"><div class="card-head"><h3>危险模式</h3>${helpButton('unsafe_mode', '危险模式')}</div>
        <div class="danger-panel">可能造成黑屏、烧屏、异常温升、色偏或无法进入系统。建议先安装可信来源的开机禁用/救砖模块，并保留可用的 USB 调试或 Recovery。</div>
        <div class="actions"><button id="toggleUnsafe" class="${unsafe ? 'danger' : 'primary'}">${unsafe ? '关闭危险模式' : '阅读并开启危险模式'}</button></div>
      </article>
      <article class="card full"><div class="card-head"><h3>配置备份</h3>${helpButton('device_fingerprint', '备份与跨系统导入')}</div>
        <div class="actions"><button id="localBackup">在模块内创建备份</button><button id="exportConfig">下载当前 JSON</button><button id="exportSdcard">保存到 Download</button><button id="importConfig">读取本地 JSON</button></div>
      </article>
      <article class="card full"><div class="card-head"><h3>绝对路径与状态</h3></div>
        <pre>${esc(JSON.stringify(status, null, 2))}</pre>
        <p class="source">配置：${MODULE}/config/config.json<br>原厂：${MODULE}/data/original/etc<br>生成：${MODULE}/data/generated/etc<br>日志：${MODULE}/data/logs/apply.log</p>
      </article>
      <article class="card full"><div class="card-head"><h3>恢复</h3></div><div class="actions"><button id="restoreAll" class="danger">全部恢复原厂值</button></div><p class="hint">恢复只修改 JSON；点击右下角“保存并应用”后才会解除不再需要的文件挂载。</p></article>
    </div>${resetButton()}`;
}

function render() {
  if (!config) return;
  const renderers = { home: homePage, hbm: hbmPage, apps: appsPage, games: gamesPage, thermal: thermalPage, advanced: advancedPage, mapping: mappingPage, calibration: calibrationPage, settings: settingsPage };
  content.innerHTML = renderers[page]();
  bindCommon();
  if (page === 'home') bindCurve();
  if (page === 'apps') bindPackagePicker();
  if (page === 'thermal') bindVoltage();
  if (page === 'mapping') bindMapping();
  if (page === 'settings') bindSettings();
}

function bindCommon() {
  content.querySelectorAll('.setting-input').forEach(input => input.addEventListener('change', event => {
    const el = event.currentTarget;
    const key = el.dataset.key;
    const type = el.dataset.type;
    let next;
    if (type === 'toggle') {
      const original = setting(key).original;
      next = typeof original === 'boolean' ? el.checked : (el.checked ? 1 : 0);
    } else if (type === 'number') next = Number(el.value);
    else if (type === 'csv') next = el.value.split(',').map(v => Number(v.trim())).filter(v => Number.isFinite(v));
    else if (type === 'list') next = [...new Set(el.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean))];
    else if (type === 'lines') next = el.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    else next = el.value;
    setValue(key, next);
  }));
  content.querySelectorAll('[data-help]').forEach(button => button.addEventListener('click', () => showHelp(button.dataset.help, button.dataset.label)));
  content.querySelectorAll('[data-reset-page]').forEach(button => button.addEventListener('click', () => resetPage(button.dataset.resetPage)));
  content.querySelectorAll('[data-reset-keys]').forEach(button => button.addEventListener('click', () => restoreKeys(button.dataset.resetKeys.split(',').filter(Boolean))));
  content.querySelectorAll('[data-go-settings]').forEach(button => button.addEventListener('click', () => switchPage('settings')));
}

function showHelp(key, label) {
  const item = setting(key);
  document.querySelector('#helpTitle').textContent = label || key;
  document.querySelector('#helpBody').textContent = item
    ? `${item._comment || ''}\n\n${brightnessImpact(key)}\n\n单位：${item.unit || '无'}\n原厂值：${Array.isArray(item.original) ? JSON.stringify(item.original) : item.original}\n安全范围：${JSON.stringify(item.safe_range)}\n来源：${item.source || '—'}`
    : '该项目在当前设备配置中不可用。';
  helpDialog.showModal();
}

function brightnessImpact(key) {
  const method = key.match(/^method(2|3|4|6|8)_(apps|switch|nit[01]|ratio[01]|rate_in[01]|rate_out[01])$/);
  if (method) {
    const scene = { 2: '视频', 3: '短视频/直播', 4: '游戏', 6: '导航/配送', 8: '阅读/浏览' }[method[1]];
    const field = method[2];
    if (field === 'apps') return `影响的亮度：只决定哪些应用进入 method ${method[1]} 的${scene}场景策略，本身不写入亮度值。\n增加包名：该应用满足场景识别时会使用本组 nit/ratio/rate；移除后不再由本组控制。\n生效条件：method 开关开启、包名匹配且厂商服务识别到对应 mode。\n叠加关系：仍受温度、电池、全局应用上限、窗口限亮和面板映射限制；同一应用处于多个名单时可能叠加。`;
    if (field === 'switch') return `影响的亮度：控制 method ${method[1]} 的${scene}亮度策略是否参与计算。\n开启：名单应用可按本组曲线调整基础亮度；关闭：本组 nit/ratio/rate 通常不参与，但其他策略仍可生效。\n生效条件：应用在本组名单并进入对应场景。\n叠加关系：method 4 与游戏 EDR 是两层不同策略，可能一边降基础亮度、一边增强 EDR 内容。`;
    if (field.startsWith('nit')) return `影响的亮度：这是 method ${method[1]}、${scene}场景的输入亮度坐标，单位 nit，用来选择对应 ratio 和过渡速率；它不是直接写给面板的最终亮度。\n提高坐标：同一策略段会推迟到更高基础亮度才使用；降低坐标：策略更早进入该段。\n生效条件：名单、开关和 mode ${field.at(-1)} 同时匹配。\n叠加关系：四组数组按 nit 成组排序，数量必须一致；最终亮度还会被全局/窗口/温控限制取更保守结果。`;
    if (field.startsWith('ratio')) return `影响的亮度：这是 method ${method[1]}、${scene}场景在各 nit 坐标处的调整比例，主要改变名单应用的场景亮度。\n提高比例：通常表示更强的降亮/修正，屏幕会更暗；设为 0 通常表示该点不额外降亮。\n降低比例：减弱场景降亮，但不会突破面板、温控或全局上限。\n生效条件：与同 mode、同位置的 nit 坐标配对；厂商服务会在坐标之间插值。`;
    return `影响的亮度：不改变目标 nit，只控制 method ${method[1]}、${scene}场景进入或退出该亮度修正时的过渡速度。\n提高：通常更快到达新亮度，视觉变化更直接，也更容易察觉跳变；降低：过渡更慢、更平滑。\n生效条件：名单、开关和 mode ${field.at(-1)} 匹配。\n叠加关系：只影响时间过程，不解除任何亮度上限。`;
  }

  const foss = key.match(/^foss(2|4)_(apps|switch|ratio)$/);
  if (foss) {
    const type = foss[1] === '2' ? 'Normal/type 2' : 'Special/type 4';
    if (foss[2] === 'apps') return `影响的亮度：决定哪些应用使用 FOSS ${type} 降亮比例，本身不改变面板映射。\n增加包名：应用进入前台时可能被额外降亮；移除：不再受该类型 FOSS 策略影响。\n生效条件：FOSS 总开关和本类型开关均开启。\n叠加关系：可与全局、窗口、method 和温控限制叠加，实际通常取更低结果。`;
    if (foss[2] === 'switch') return `影响的亮度：启用或停用 FOSS ${type} 名单的应用降亮。\n开启：名单应用按对应 ratio 降低请求亮度；关闭：名单和比例保留但不参与。\n生效条件：FOSS 总开关也必须开启。\n叠加关系：只控制这一组，不会关闭其他应用限亮。`;
    return `影响的亮度：控制 FOSS ${type} 名单应用的降亮幅度。\n提高：名单应用更暗；降低：降亮减弱；0 通常表示不额外降亮。\n生效条件：总开关、本组开关和包名同时匹配。\n叠加关系：即使设为 0，温度、电池、全局和窗口上限仍然有效。`;
  }

  const impacts = {
    manual_max_level: ['影响手动模式中亮度滑块能够请求到的最高逻辑 Level，不直接改自动亮度。', '提高后，滑块顶端可请求更靠后的映射等级；只有该等级在原厂表中存在才允许。', '降低后，滑块更早到顶，手动最高亮度下降。', '用户关闭自动亮度并把滑块推到高位时。', '最终仍受 Apollo/面板映射、应用策略、温度、电池和 Dolby 限制。'],
    auto_curve: ['影响自动亮度模式下“环境 Lux → 目标 nit”的基础请求，不改变手动滑块范围。', '提高某点 nit 会让该照度及其插值区间更亮；为保持单调，后续低点会一并抬高。', '降低某点会让对应环境更暗；若低于前点，前面的冲突点会被单调规则钳住或随编辑修正。', '自动亮度开启且光感估算到相应 Lux 区间时。', '达到高亮仍需 HBM 条件，且会被应用/窗口/温控/电池上限压低。'],
    hbm_lux: ['影响环境光触发 HBM 的 Lux 门限，主要决定高环境光下能否进入高亮通路。', '提高门限：需要更强环境光才触发 HBM，较难进入峰值亮度。', '降低门限：较暗环境也可能请求 HBM，耗电、温升和烧屏风险上升。', '自动亮度/HBM 算法启用且光感持续满足条件时。', '只满足 Lux 不保证高亮，还可能受 CCT、温度、电池、应用策略和面板能力限制。'],
    hbm_cct: ['影响 HBM 厂商算法使用的色温/环境条件编码，不是 nit，也不直接表示亮度。', '数值含义未公开，不能按“越大越亮”解释；改变可能让 HBM 在不同光源色温下更易或更难触发。', '同样没有可靠的单调方向，应以原厂值为基线逐步测试。', 'HBM 服务同时读取环境照度和色温传感器时。', '错误编码可能导致 HBM 不触发或异常触发；不会绕过温控与面板上限。'],
    hbm_lux_table_mode: ['选择厂商 HBM 使用的曲线/策略编号，不是亮度等级。', '编号变大不代表更亮，只是切换到另一个厂商预设分支。', '编号变小也不代表更暗；不存在对应模式时可能回退或不生效。', '设备显示服务读取 brightness 配置并准备 HBM 时。', '应保留原厂已知编号；它与 HBM Lux/CCT 条件共同作用。'],
    global_limit: ['影响除例外名单外所有应用的全局应用亮度上限，通常是前台应用层面的 nit 钳位。', '提高：普通应用可请求更高亮度，直到其他限制或面板映射接管。', '降低：所有非例外应用都会更早封顶。', '前台包名不在 global_exceptions 时。', '例外应用跳过本项，但仍受窗口、场景、温控、电池和面板限制。'],
    global_exceptions: ['决定哪些应用绕过 global_limit，本身不定义新的亮度上限。', '增加应用：它可超过全局应用上限；删除或清空：更多应用受全局上限控制。', '从名单移除不会主动降到固定 nit，而是重新受 global_limit 钳位。', '包名与前台应用精确匹配时。', '例外不等于无限亮，窗口/场景/温控/电池/Apollo 仍可限制。'],
    uir_enable: ['控制 UIR 名单应用的厂商显示增强通路。', '开启后，符合亮度和温度条件的名单应用可按最大倍率增强；不保证一定变亮。', '关闭后，仅停用 UIR 增强，不影响其他亮度策略。', '包名、UIR 亮度门限与温度条件同时满足时。', 'UIR 仍受硬件映射和保护策略约束。'],
    uir_brightness_limit: ['影响 UIR 进入/工作的亮度门限，不是屏幕最终峰值。', '提高通常会把 UIR 的触发/限制边界移到更高基础亮度。', '降低通常会让 UIR 更早进入对应策略区间。', 'UIR 开启且应用在白名单时。', '厂商未公开比较方向；与 uir_max_ratio、温度门限一起决定结果。'],
    uir_temperature_limit: ['影响 UIR 增强允许工作的温度边界，作用于 UIR 亮度而非所有系统亮度。', '提高会在更高温度仍允许 UIR，可能更亮但显著增加温升风险。', '降低会更早停用/限制 UIR，屏幕更容易降亮。', 'UIR 开启且名单应用触发增强时。', '提高属于放宽保护，必须危险模式；系统其他温控仍可能覆盖。'],
    uir_max_ratio: ['限制 UIR 可施加的最大增强比例。', '提高：允许更强增强，名单内容可能更亮、功耗更高。', '降低：限制增强幅度；0 附近通常接近不增强。', 'UIR 开启、名单和亮度/温度条件满足时。', '不会把物理亮度推过 Apollo/DBV 和系统保护能力。'],
    uir_apps: ['决定哪些应用可触发 UIR 增强。', '增加包名：该应用获得 UIR 资格；移除：该应用不再走 UIR。', '清空会使 UIR 没有名单目标，但总开关仍保留。', '包名匹配且 UIR 开启。', '应用还可能同时位于 FOSS/method/窗口名单，产生增强与降亮叠加。'],
    foss_enable: ['控制全部 FOSS 名单降亮策略。', '开启：type 2/type 4 可按各自名单和比例降亮。', '关闭：两组 FOSS 降亮均不参与，但各子项配置保留。', '前台应用命中任一 FOSS 名单时。', '不影响 global、method、窗口和温控策略。'],
    window_limit: ['影响窗口亮度名单应用的最大 nit，常见于二维码、交通卡等特定窗口场景。', '提高：名单窗口可请求更高亮度。', '降低：名单窗口更早封顶，可能影响强光可读性。', '包名/窗口场景被厂商服务识别时。', '与全局上限同时存在时通常由更低上限决定，仍受温控和面板映射限制。'],
    window_apps: ['决定哪些应用进入窗口亮度上限策略。', '增加包名：该应用可能被 window_limit 钳位；移除：不再由本项限制。', '清空不会取消 XML 功能，只是没有包名触发。', '前台窗口与包名识别匹配时。', '同一应用仍可能命中全局、method、FOSS 等策略。'],
    game_brightness_nit: ['影响全局游戏亮度策略的输入 nit 坐标，名单内游戏共用。', '提高坐标会把对应 ratio/rate 段推到更高基础亮度。', '降低坐标会让该策略段更早参与。', '游戏场景被识别并启用 game_brightness 策略时。', '与 method 4 和游戏 EDR 分层生效，不是每游戏独立上限。'],
    game_brightness_ratio: ['影响全局游戏基础亮度的调整比例。', '提高通常加强游戏基础亮度修正/降亮；降低则减弱。', '设为较低值不会自动提高 EDR 峰值。', '按 game_brightness_nit 坐标插值。', '可能与 method 4 降亮和 EDR 增强同时存在。'],
    game_brightness_rate: ['影响全局游戏亮度策略的过渡速度，不改变目标亮度坐标。', '提高通常使进出策略更快，亮度变化更明显。', '降低使过渡更慢、更平滑。', '游戏策略切换亮度段或进出游戏时。', '不解除任何亮度限制。'],
    voltage_matrix: ['影响低温和低电量组合下的普通/复合场景 nit 上限，是保护性亮度钳位。', '提高某格会在该温度/电量区间放宽亮度，增加低压关机、闪屏和电池负担风险。', '降低某格会更早降亮，保护更强。', '设备温度和剩余电量同时落入该行列范围时。', '保护上限通常优先于自动、手动、应用和游戏提亮；放宽必须危险模式。'],
    force_temperature_limit: ['影响显示系统强制温控介入的温度阈值，作用于全局显示亮度保护。', '提高：更高温才强制降亮，可能维持亮度但加剧温升。', '降低：更早触发强制限亮，屏幕更容易变暗。', '设备温度达到厂商显示温控条件时。', '提高属于危险操作；系统热管理仍可能有更高优先级。'],
    dolby_temperature_nits: ['影响 Dolby 场景在 0～21 个温度档位中的亮度上限。', '提高某档：对应温度状态下 Dolby 内容可更亮；9999 常表示该档不主动限制。', '降低某档：该温度档更早封顶。', 'Dolby/相关显示场景启用并进入对应温度档时。', '可与全局温控、低压矩阵和应用上限同时取更低值；提高必须危险模式。'],
    dark_env_support: ['控制暗环境额外降亮策略，主要影响低 Lux 下的自动/场景亮度。', '开启：在配置 Lux 区间按 scale 进一步降亮。', '关闭：不进行这层暗环境缩放，但自动曲线仍然有效。', '环境 Lux 命中 dark_env_lux 范围时。', '与自动亮度和其他应用策略叠加。'],
    dark_env_lux: ['定义暗环境降亮策略的 Lux 坐标。', '提高坐标：暗环境策略覆盖到更亮的环境；降低：覆盖范围收窄。', '改变只移动触发区间，不直接定义降亮量。', 'dark_env_support 开启时。', '必须与 scale 数组等长并按 Lux 排序。'],
    dark_env_scale: ['定义各暗环境 Lux 坐标对应的亮度缩放/降亮比例。', '提高通常意味着更强缩放、画面更暗。', '降低会减弱暗环境降亮；0 附近通常不额外降亮。', '暗环境开关开启并在对应 Lux 段插值时。', '最终仍受自动曲线最低请求和其他限制影响。'],
    light_sensor_always_on_support: ['影响环境光传感器是否持续工作，间接影响自动亮度响应。', '开启：自动亮度可更持续地跟踪环境变化，但增加少量功耗。', '关闭：可能依赖按需采样，亮度响应可能更慢。', '自动亮度/光感服务运行时。', '不直接提高任何 nit 上限。'],
    dual_light_sensor_fusion_support: ['影响前后/双光感的融合方式，间接改变系统估算的 Lux。', '开启：遮挡单个传感器时可能更稳定，但融合结果会改变自动亮度触发点。', '关闭：更多依赖单一传感器。', '设备具有对应双光感硬件时。', '它改变 Lux 输入，不改变自动曲线本身。'],
    dark_env_brightness_smooth_optimize_support: ['影响暗环境自动亮度变化的平滑处理。', '开启：暗光变化更平滑、跳变更少，但响应可能变慢。', '关闭：可能更快跟随 Lux，也更容易察觉闪动。', '低 Lux 且自动亮度调整时。', '不改变最终亮度上限。'],
    DualRampAnimatorOpt: ['影响亮度动画/ramp 的厂商优化路径。', '开启通常改善不同亮度通路之间的过渡。', '关闭可能使用基础动画策略。', '系统改变背光请求时。', '只改变过渡过程，不保证更亮或更暗。'],
    BrightnessHalfVsync: ['影响亮度更新与 Vsync 的调度节奏。', '开启可能降低更新开销或改变亮度动画细腻度。', '关闭使用另一种同步节奏。', '亮度连续动画时。', '不直接控制目标 nit；错误设置可能导致动画抖动。'],
    comfortable_motion_support: ['控制舒适亮度是否根据步行/交通等运动状态改变 Lux 判断。', '开启：运动识别可选择不同 Lux 门限，自动亮度触发点会随状态变化。', '关闭：不使用这层运动状态分支。', '传感器识别到 normal/erratic/stable 等状态时。', '只改变场景判定，最终仍由亮度曲线与限制决定。'],
    comfortable_thresholds: ['定义 normal/erratic/stable 状态下交通与步行的 Lux 门限。', '提高某门限：需要更亮环境才切入对应舒适亮度状态。', '降低：更早切换。', '舒适亮度运动识别开启时。', '数值不是 nit，不可按“越大屏幕越亮”直接理解。'],
    mapping_nit_multiplier: ['同时缩放 Brightness 与 Apollo 的整张 nit 映射，影响所有手动/自动/应用请求最终如何标注亮度。', '大于 1：每个逻辑等级声明更高 nit；可能只改变映射标定、被钳位或造成亮度异常。', '小于 1：整张映射声明降低，可能让相同 Level 对应更低目标亮度。', '显示服务读取两张映射表时。', 'linked 模式保持两文件一致；不改变 DBV，可能造成 nit 与实际驱动不匹配。'],
    mapping_dbv_multiplier: ['缩放 Apollo 的物理 DBV 驱动码，直接影响面板背光/发光驱动分级。', '大于 1：同一 Level 使用更高 DBV，通常更亮，但更易超出面板标定、温升或黑屏。', '小于 1：同一 Level 使用更低 DBV，通常更暗。', 'Apollo 映射被显示驱动采用时。', 'DBV 永远不得超过 4095；相同原厂 DBV 分组默认一起改变。'],
    mapping_edit_mode: ['决定两个文件的 nit 是作为一个联动值，还是允许独立编辑。', 'linked：每个 Level 只写一个 nit，同时更新 Brightness 与 Apollo，适合安装检测为完全相等的设备。', 'separate：可分别写两个 nit；只有确认厂商两层含义不同时才应使用。', '单行编辑和生成 XML 时。', '强制分开可能让框架请求亮度与 Apollo 驱动映射认知不一致，造成跳变、钳位或模式切换亮度变化。'],
    mapping_shared_dbv_propagation: ['决定修改一个 Apollo DBV 时，是否同步所有原厂共用该 DBV 的逻辑 Level。', '开启：包括更前面的 Level 在内，同一物理分级保持一致，并自动修复跨级单调性。', '关闭：只改选中 Level，可能把原本同级拆开并造成细小跳变。', '逐级修改 DBV 时；nit 编辑不按 DBV 分组强制相等。', '建议始终开启；关闭需要危险模式，后端仍要求整个 DBV 序列不下降。'],
    mapping_overrides: ['覆盖指定 Level 的最终 DBV 和 nit，是最直接、风险最高的映射修改。', '提高 DBV 通常提高物理驱动；提高 nit 改变该等级的亮度标定/请求值。', '降低会降低对应驱动或声明亮度；编辑器会级联修复前后单调关系。', '该 Level 被手动、自动或应用策略请求时。', '单行值优先于统一倍率；linked 模式两个 nit 必须相等，DBV≤4095。'],
    demura_global_status: ['控制面板 Demura 均匀性补偿，不是普通亮度开关。', '开启使用面板补偿表，局部亮度/色彩可能被校正。', '关闭可能暴露面板不均匀，不代表整体更亮。', '显示驱动加载 Demura 标定时。', '错误设置可产生色块、亮度不均或色偏。'],
    demura_global_gain: ['缩放 Demura 补偿增益，影响局部像素补偿强度。', '提高会加强补偿，局部亮度/色彩偏移风险增加。', '降低会减弱补偿。', 'Demura 开启时。', '不应作为提高全屏峰值亮度的手段。'],
    demura_aoi: ['定义 Demura AOI 的 nit→DBV 标定锚点。', '提高 DBV 会改变对应 nit 区间的局部补偿驱动。', '降低则减小对应驱动。', '面板进入相应亮度锚点区间时。', '必须保持结构和 DBV≤4095；错误值可能造成明显显示异常。'],
    eyeprotect_profiles: ['控制护眼/色彩模式的色温与 RGB 曲线，主要影响白点和各通道亮度。', '提高某通道值会增强该颜色分量，不等于提高面板总峰值。', '降低某通道会削弱该颜色，整体观感可能变暗或偏色。', '选择对应色彩/护眼模式时。', '数组长度必须一致；不用于绕过 HBM 或温控。'],
    dbvgain_entries: ['控制不同刷新率和 DBV 节点的 RGB Gamma/增益标定。', '提高 Gamma/增益条目可能抬高局部灰阶或颜色通道。', '降低可能压暗灰阶。', '面板处于对应 FPS 与 DBV 节点时。', '错误标定可能黑屏、闪屏、色偏；DBV≤4095、每通道固定 28 项。'],
    unsafe_mode: ['解除模块的软安全限制，允许硬件映射和放宽温控等危险修改。', '开启不会自动提亮，只是允许后续危险配置通过校验。', '关闭后，超过原厂应用策略最大值+20%或放宽保护的配置会被拒绝。', '保存并应用配置时。', '结构约束、XML 合法性和 DBV≤4095 永远不能关闭。'],
    device_fingerprint: ['用于判断导入配置是否来自同一系统构建，本身不影响亮度。', '不可通过调高/调低改变亮度。', '跨系统时用于跳过硬件标定和温控矩阵。', '导入 JSON 时。', '手动伪造可能把不兼容标定写入设备。']
  };

  if (/^game_edr_(25|27)_(origin|enhance)$/.test(key)) return key.endsWith('_origin')
    ? '影响的亮度：定义所有 method 4 名单游戏共用的 EDR 输入/原始亮度坐标。\n提高坐标：把对应增强段移动到更高原始亮度；降低：更早进入该段。\n生效条件：游戏 EDR 选择对应 factor。\n叠加关系：必须与 enhance 数组等长；不是每游戏独立上限。'
    : '影响的亮度：定义 EDR 对各原始亮度坐标的增强目标。\n提高：HDR/EDR 高光目标更亮、功耗和温升增加；降低：高光增强减弱。\n生效条件：名单游戏启用对应 factor。\n叠加关系：method 4 可能先降基础亮度，温控和面板映射仍可钳位。';
  if (/^backlight_/.test(key)) return '影响的亮度：仅改变亮度统计/上报的分桶边界，不向面板发送新的亮度请求。\n提高或降低：只会改变统计结果落入哪个区间，通常不会让屏幕变亮或变暗。\n生效条件：厂商 backlightStat 采集运行时。\n叠加关系：不解除任何亮度上限。';
  if (/^adfr_/.test(key)) return '影响的亮度：用于 ADFR 最低刷新率判断，亮度/Lux 值是刷新率策略的条件，不是提亮命令。\n提高或降低：会移动刷新率切换门限，可能改变流畅度和耗电。\n生效条件：ADFR 开启且场景/应用匹配。\n叠加关系：屏幕亮度可能因刷新率面板标定间接变化，但不应当作亮度上限使用。';
  if (/^dbi_/.test(key)) return '影响的亮度：控制 DBI 显示内容采集/联动，不直接定义峰值亮度。\n开启、增加名单或缩短间隔：让更多应用/更频繁数据参与 DBI，可能增加开销。\n关闭、移除名单或延长间隔：减少 DBI 参与。\n生效条件：厂商 DBI 服务支持该节点。\n叠加关系：不会绕过面板、应用或温控限制。';
  const info = impacts[key];
  if (!info) return '影响的亮度：该项属于厂商显示策略参数；当前 XML 没有足够公开语义可可靠推断“数值越大越亮”。\n改变效果：应以原厂值为基线小步调整并重启验证。\n生效条件：对应厂商服务读取该节点时。\n叠加关系：任何请求仍受面板映射、应用策略与温度/电池保护共同限制。';
  return `影响的亮度：${info[0]}\n调高/开启：${info[1]}\n调低/关闭：${info[2]}\n生效条件：${info[3]}\n叠加关系：${info[4]}`;
}

function resetPage(name) {
  for (const key of pageKeys[name] || []) {
    if (key === 'unsafe_mode' || key === 'unsafe_acknowledgement') continue;
    if (!setting(key)) continue;
    config[key].value = clone(config[key].original);
    markDirty(key);
  }
  render();
}

function bindCurve() {
  const canvas = document.querySelector('#curveCanvas');
  const tbody = document.querySelector('#curveRows');
  if (!canvas || !tbody) return;
  normalizeAutoCurve(false);
  renderCurveRows();
  fitCurveCanvas();

  const controls = [
    ['curveXZoom', 'xZoom', 'curveXZoomText', value => `${value}×`], ['curveXPan', 'xPan', 'curveXPanText', value => `${value}%`],
    ['curveYZoom', 'yZoom', 'curveYZoomText', value => `${value}×`], ['curveYPan', 'yPan', 'curveYPanText', value => `${value}%`]
  ];
  for (const [id, key, output, format] of controls) document.querySelector(`#${id}`).addEventListener('input', event => {
    curveView[key] = Number(event.target.value); document.querySelector(`#${output}`).textContent = format(curveView[key]); drawCurve();
  });

  const clamp = (number, min, max) => Math.max(min, Math.min(max, number));
  const activePointers = new Map();
  let gesture = { mode: 'idle' };

  function syncCurveControls() {
    for (const [id, key, output, format] of controls) {
      const clean = Number(curveView[key].toFixed(2));
      curveView[key] = clean;
      const input = document.querySelector(`#${id}`); const label = document.querySelector(`#${output}`);
      if (input) input.value = String(clean);
      if (label) label.textContent = format(clean);
    }
  }

  function beginPan(pointerId, point) {
    gesture = { mode: 'pan', pointerId, point, view: { ...curveView } };
    dragPoint = -1;
  }

  function beginPinch() {
    const pointers = [...activePointers.values()].slice(0, 2);
    if (pointers.length < 2) return;
    const [a, b] = pointers; const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const m = { l: 72, r: 18, t: 18, b: 42 }; const ranges = curveRanges();
    const xf = clamp((center.x - m.l) / (canvas.width - m.l - m.r), 0, 1);
    const yf = clamp((center.y - m.t) / (canvas.height - m.t - m.b), 0, 1);
    gesture = {
      mode: 'pinch', distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      xZoom: curveView.xZoom, yZoom: curveView.yZoom,
      anchorX: ranges.xMin + xf * ranges.xSpan,
      anchorY: ranges.yMin + (1 - yf) * ranges.ySpan
    };
    dragPoint = -1;
  }

  function moveCurvePoint(point) {
    if (dragPoint < 0) return;
    const points = value('auto_curve');
    const margins = { l: 72, r: 18, t: 18, b: 42 };
    const ranges = curveRanges();
    const xf = clamp((point.x - margins.l) / (canvas.width - margins.l - margins.r), 0, 1);
    const yf = clamp((point.y - margins.t) / (canvas.height - margins.t - margins.b), 0, 1);
    let lux = Math.max(0, Math.round(10 ** (ranges.xMin + xf * ranges.xSpan) - 1));
    let nit = Math.max(0, Math.round((ranges.yMin + (1 - yf) * ranges.ySpan) * 10) / 10);
    const previous = points[dragPoint - 1], next = points[dragPoint + 1];
    if (previous) { lux = Math.max(lux, Number(previous[0]) + 1); nit = Math.max(nit, Number(previous[1])); }
    if (next) lux = Math.min(lux, Number(next[0]) - 1);
    points[dragPoint] = [lux, nit];
    for (let i = dragPoint + 1; i < points.length; i++) if (Number(points[i][1]) < nit) points[i][1] = nit;
    markDirty('auto_curve'); drawCurve();
    points.forEach((point, index) => { const row = tbody.querySelector(`tr[data-index="${index}"]`); if (row) { row.querySelector('[data-axis="0"]').value = point[0]; row.querySelector('[data-axis="1"]').value = point[1]; } });
  }

  function moveViewport() {
    if (gesture.mode === 'pan') {
      const current = activePointers.get(gesture.pointerId); if (!current) return;
      const m = { l: 72, r: 18, t: 18, b: 42 };
      const dx = current.x - gesture.point.x, dy = current.y - gesture.point.y;
      if (gesture.view.xZoom > 1) {
        curveView.xPan = clamp(gesture.view.xPan - dx / (canvas.width - m.l - m.r) * 100 / (gesture.view.xZoom - 1), 0, 100);
      } else if (Math.abs(dx) > 3) {
        const global = curveGlobalRanges(); curveView.xZoom = 1.25;
        const startFraction = clamp((gesture.point.x - m.l) / (canvas.width - m.l - m.r), 0, 1);
        const currentFraction = clamp((current.x - m.l) / (canvas.width - m.l - m.r), 0, 1);
        const span = global.x / curveView.xZoom, available = global.x - span;
        curveView.xPan = available > 0 ? clamp((startFraction * global.x - currentFraction * span) / available * 100, 0, 100) : 0;
      }
      if (gesture.view.yZoom > 1) {
        curveView.yPan = clamp(gesture.view.yPan + dy / (canvas.height - m.t - m.b) * 100 / (gesture.view.yZoom - 1), 0, 100);
      } else if (Math.abs(dy) > 3) {
        const global = curveGlobalRanges(); curveView.yZoom = 1.25;
        const startFraction = clamp((gesture.point.y - m.t) / (canvas.height - m.t - m.b), 0, 1);
        const currentFraction = clamp((current.y - m.t) / (canvas.height - m.t - m.b), 0, 1);
        const span = global.y / curveView.yZoom, available = global.y - span;
        const anchor = (1 - startFraction) * global.y;
        curveView.yPan = available > 0 ? clamp((anchor - (1 - currentFraction) * span) / available * 100, 0, 100) : 0;
      }
    } else if (gesture.mode === 'pinch' && activePointers.size >= 2) {
      const [a, b] = [...activePointers.values()].slice(0, 2);
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)); const scale = distance / gesture.distance;
      curveView.xZoom = clamp(gesture.xZoom * scale, 1, 20);
      curveView.yZoom = clamp(gesture.yZoom * scale, 1, 10);
      const global = curveGlobalRanges(); const m = { l: 72, r: 18, t: 18, b: 42 };
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const xf = clamp((center.x - m.l) / (canvas.width - m.l - m.r), 0, 1);
      const yf = clamp((center.y - m.t) / (canvas.height - m.t - m.b), 0, 1);
      const xSpan = global.x / curveView.xZoom, ySpan = global.y / curveView.yZoom;
      const xAvailable = global.x - xSpan, yAvailable = global.y - ySpan;
      curveView.xPan = xAvailable > 0 ? clamp((gesture.anchorX - xf * xSpan) / xAvailable * 100, 0, 100) : 0;
      curveView.yPan = yAvailable > 0 ? clamp((gesture.anchorY - (1 - yf) * ySpan) / yAvailable * 100, 0, 100) : 0;
    }
    syncCurveControls(); drawCurve();
  }

  canvas.addEventListener('pointerdown', event => {
    event.preventDefault(); const point = canvasPoint(event); activePointers.set(event.pointerId, point);
    try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    if (activePointers.size === 1) {
      let best = -1, distance = 24;
      curvePixels().forEach((pixel, index) => { if (!pixel.visible) return; const d = Math.hypot(pixel.x - point.x, pixel.y - point.y); if (d < distance) { distance = d; best = index; } });
      if (best >= 0) { dragPoint = best; gesture = { mode: 'point', pointerId: event.pointerId }; }
      else beginPan(event.pointerId, point);
    } else if (activePointers.size === 2 && gesture.mode !== 'point') beginPinch();
  });
  canvas.addEventListener('pointermove', event => {
    if (!activePointers.has(event.pointerId)) return;
    event.preventDefault(); const point = canvasPoint(event); activePointers.set(event.pointerId, point);
    if (gesture.mode === 'point' && gesture.pointerId === event.pointerId) moveCurvePoint(point);
    else moveViewport();
  });
  const finishPointer = event => {
    const editedPoint = gesture.mode === 'point' && gesture.pointerId === event.pointerId;
    activePointers.delete(event.pointerId);
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
    if (editedPoint) { dragPoint = -1; normalizeAutoCurve(); renderCurveRows(); drawCurve(); }
    if (gesture.mode === 'pinch' && activePointers.size === 1) {
      const [pointerId, point] = activePointers.entries().next().value; beginPan(pointerId, point);
    } else if (!activePointers.size || editedPoint) { gesture = { mode: 'idle' }; dragPoint = -1; }
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);

  const landscapeStage = document.querySelector('#curveLandscapeStage');
  let nativeCurveFullscreen = false;
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const leaveLandscapeLayout = async exitNative => {
    if (exitNative && fullscreenElement()) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch (_) {}
    }
    try { screen.orientation?.unlock?.(); } catch (_) {}
    landscapeStage.classList.remove('curve-expanded', 'curve-rotate-fallback');
    document.body.classList.remove('curve-editor-open');
    nativeCurveFullscreen = false; requestAnimationFrame(fitCurveCanvas);
  };
  const fullscreenChange = () => {
    if (nativeCurveFullscreen && !fullscreenElement()) leaveLandscapeLayout(false);
  };
  if (curveFullscreenHandler) {
    document.removeEventListener('fullscreenchange', curveFullscreenHandler);
    document.removeEventListener('webkitfullscreenchange', curveFullscreenHandler);
  }
  curveFullscreenHandler = fullscreenChange;
  document.addEventListener('fullscreenchange', curveFullscreenHandler);
  document.addEventListener('webkitfullscreenchange', curveFullscreenHandler);
  document.querySelector('#openCurveLandscape').addEventListener('click', async () => {
    landscapeStage.classList.add('curve-expanded'); document.body.classList.add('curve-editor-open'); requestAnimationFrame(fitCurveCanvas);
    try {
      const request = landscapeStage.requestFullscreen || landscapeStage.webkitRequestFullscreen;
      if (request) { await request.call(landscapeStage); nativeCurveFullscreen = true; }
    } catch (_) { nativeCurveFullscreen = false; }
    try { await screen.orientation?.lock?.('landscape'); } catch (_) {}
    setTimeout(() => {
      if (landscapeStage.classList.contains('curve-expanded') && window.matchMedia?.('(orientation: portrait)').matches) {
        landscapeStage.classList.add('curve-rotate-fallback');
      }
      fitCurveCanvas();
    }, 250);
  });
  document.querySelector('#closeCurveLandscape').addEventListener('click', () => leaveLandscapeLayout(true));
  if (curveResizeHandler) window.removeEventListener('resize', curveResizeHandler);
  curveResizeHandler = () => requestAnimationFrame(fitCurveCanvas);
  window.addEventListener('resize', curveResizeHandler);

  document.querySelector('#addCurvePoint').addEventListener('click', () => {
    const points = value('auto_curve'); const last = points[points.length - 1] || [0, 0];
    points.push([Number(last[0]) + Math.max(1, Math.round(Number(last[0]) * .1)), Number(last[1])]); markDirty('auto_curve'); normalizeAutoCurve(); renderCurveRows(); drawCurve();
  });
  document.querySelector('#sortCurve').addEventListener('click', () => {
    normalizeAutoCurve(); markDirty('auto_curve'); renderCurveRows(); drawCurve();
  });
  document.querySelector('#resetCurveView').addEventListener('click', () => {
    Object.assign(curveView, { xZoom: 1, xPan: 0, yZoom: 1, yPan: 0 }); render();
  });

  function renderCurveRows() {
    tbody.innerHTML = value('auto_curve').map((point, index) => `<tr data-index="${index}"><td><input class="table-input curve-input" data-index="${index}" data-axis="0" type="number" step="any" value="${esc(point[0])}"></td><td><input class="table-input curve-input" data-index="${index}" data-axis="1" type="number" step="any" value="${esc(point[1])}"></td><td><button class="delete-point" data-index="${index}" aria-label="删除">×</button></td></tr>`).join('');
    tbody.querySelectorAll('.curve-input').forEach(input => input.addEventListener('change', () => {
      config.auto_curve.value[Number(input.dataset.index)][Number(input.dataset.axis)] = Number(input.value); markDirty('auto_curve'); normalizeAutoCurve(); renderCurveRows(); drawCurve();
    }));
    tbody.querySelectorAll('.delete-point').forEach(button => button.addEventListener('click', () => {
      if (config.auto_curve.value.length <= 2) return showResult('不能删除', '自动亮度曲线至少需要两个坐标。');
      config.auto_curve.value.splice(Number(button.dataset.index), 1); markDirty('auto_curve'); normalizeAutoCurve(); renderCurveRows(); drawCurve();
    }));
  }

  function canvasPoint(event) {
    const r = canvas.getBoundingClientRect();
    if (document.querySelector('#curveLandscapeStage')?.classList.contains('curve-rotate-fallback')) {
      return {
        x: clamp((event.clientY - r.top) / r.height, 0, 1) * canvas.width,
        y: clamp(1 - (event.clientX - r.left) / r.width, 0, 1) * canvas.height
      };
    }
    return { x: clamp((event.clientX - r.left) / r.width, 0, 1) * canvas.width, y: clamp((event.clientY - r.top) / r.height, 0, 1) * canvas.height };
  }
  function fitCurveCanvas() {
    const width = Math.max(320, Math.round(canvas.clientWidth || 900));
    const height = Math.max(220, Math.round(canvas.clientHeight || 300));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    drawCurve();
  }
  function curveGlobalRanges() {
    const points = value('auto_curve');
    return {
      x: Math.max(...points.map(point => Math.log10(Number(point[0]) + 1)), 1),
      y: Math.max(Number(value('safe_nit_max')) || 1, ...points.map(point => Number(point[1]) || 0))
    };
  }
  function curveRanges() {
    const global = curveGlobalRanges();
    const xSpan = global.x / curveView.xZoom, ySpan = global.y / curveView.yZoom;
    return { xMin: (global.x - xSpan) * curveView.xPan / 100, xSpan, yMin: (global.y - ySpan) * curveView.yPan / 100, ySpan };
  }
  function curvePixels() {
    const points = value('auto_curve'); const m = { l: 72, r: 18, t: 18, b: 42 };
    const ranges = curveRanges();
    return points.map(p => { const lx = Math.log10(Number(p[0]) + 1); const yv = Number(p[1]); return { x: m.l + (lx - ranges.xMin) / ranges.xSpan * (canvas.width - m.l - m.r), y: m.t + (1 - (yv - ranges.yMin) / ranges.ySpan) * (canvas.height - m.t - m.b), visible: lx >= ranges.xMin && lx <= ranges.xMin + ranges.xSpan && yv >= ranges.yMin && yv <= ranges.yMin + ranges.ySpan }; });
  }
  function drawCurve() {
    const ctx = canvas.getContext('2d'); const px = curvePixels(); const m = { l: 72, r: 18, t: 18, b: 42 };
    const ranges = curveRanges(); const yTicks = 8; const xTicks = 8;
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineWidth = 1; ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (let i = 0; i <= yTicks; i++) {
      const fraction = i / yTicks; const y = m.t + fraction * (canvas.height - m.t - m.b);
      ctx.strokeStyle = i === 0 || i === yTicks ? '#3a4456' : '#293242';
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(canvas.width - m.r, y); ctx.stroke();
      ctx.fillStyle = '#aab6c7'; ctx.fillText(axisText(ranges.yMin + (1 - fraction) * ranges.ySpan), m.l - 8, y);
    }
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (let i = 0; i <= xTicks; i++) {
      const fraction = i / xTicks; const x = m.l + fraction * (canvas.width - m.l - m.r);
      ctx.strokeStyle = i === 0 || i === xTicks ? '#3a4456' : '#252e3d';
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, canvas.height - m.b); ctx.stroke();
      const lux = Math.max(0, 10 ** (ranges.xMin + fraction * ranges.xSpan) - 1);
      ctx.fillStyle = '#9aa8ba'; ctx.fillText(`${axisText(lux)}`, x, canvas.height - m.b + 8);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t, canvas.width - m.l - m.r, canvas.height - m.t - m.b); ctx.clip();
    ctx.strokeStyle = '#79a7ff'; ctx.lineWidth = 3; ctx.beginPath(); px.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    px.forEach((p, i) => { if (!p.visible) return; ctx.beginPath(); ctx.fillStyle = i === dragPoint ? '#f6bd60' : '#c9dcff'; ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
    ctx.fillStyle = '#9aa8ba'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Lux（log10 视图）', (m.l + canvas.width - m.r) / 2, canvas.height - 5);
    ctx.save(); ctx.translate(13, (m.t + canvas.height - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('目标亮度 nit', 0, 0); ctx.restore();
  }
}

async function bindPackagePicker() {
  const search = document.querySelector('#packageSearch'); const results = document.querySelector('#packageResults');
  if (!installedPackages.length) {
    const response = await exec(`${ctl} installed-apps`);
    let category = 'user';
    installedPackages = response.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
      if (line === '# user') { category = 'user'; return []; } if (line === '# system') { category = 'system'; return []; }
      return [{ package: line, category }];
    });
  }
  const show = () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = installedPackages.filter(item => item.package.toLowerCase().includes(q)).slice(0, 200).map(item => `<div class="package-item"><span>${esc(item.package)} · ${item.category === 'user' ? '用户' : '系统'}</span><button data-add-package="${esc(item.package)}">添加</button></div>`).join('') || '<p class="hint">没有匹配包名</p>';
    results.querySelectorAll('[data-add-package]').forEach(button => button.addEventListener('click', () => addPackage(button.dataset.addPackage)));
  };
  search.addEventListener('input', show); show();
  document.querySelector('#addManualPackage').addEventListener('click', () => addPackage(document.querySelector('#manualPackage').value.trim()));
}

function addPackage(pkg) {
  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(pkg)) return showResult('包名无效', '请输入类似 com.example.app 的 Android 包名。');
  const key = document.querySelector('#packageTarget').value; const list = value(key) || [];
  if (!list.includes(pkg)) { list.push(pkg); setValue(key, list); toast(`已添加到 ${key}`); }
}

function bindVoltage() {
  content.querySelectorAll('.voltage-input').forEach(input => input.addEventListener('change', () => {
    const rows = value('voltage_matrix'); const rowIndex = Number(input.dataset.row), cellIndex = Number(input.dataset.cell), part = Number(input.dataset.part);
    const [temp, ...cells] = rows[rowIndex].split('|'); const [battery, pair] = cells[cellIndex].split('='); const values = pair.split(','); values[part] = input.value;
    cells[cellIndex] = `${battery}=${values.join(',')}`; rows[rowIndex] = [temp, ...cells].join('|'); markDirty('voltage_matrix');
  }));
}

function mappingOverrides() {
  const map = new Map();
  for (const entry of value('mapping_overrides') || []) {
    const parts = String(entry).split('|').map(Number);
    if (parts.length === 3) parts.push(parts[2]);
    if (parts.length >= 4 && parts.every(Number.isFinite)) map.set(parts[0], { dbv: parts[1], brightnessNit: parts[2], apolloNit: parts[3] });
  }
  return map;
}

function mappingDbvGroupTargets(overrides) {
  const targets = new Map();
  if (value('mapping_shared_dbv_propagation') !== true) return targets;
  for (const [level, override] of overrides) {
    const row = mappingRowsByLevel.get(level);
    if (row) targets.set(row.apolloDbv, override.dbv);
  }
  return targets;
}

function effectiveMapping(row, overrides = mappingOverrides(), groupTargets = mappingDbvGroupTargets(overrides)) {
  const override = overrides.get(row.level);
  const groupedDbv = groupTargets.get(row.apolloDbv);
  return {
    brightnessNit: override?.brightnessNit ?? row.brightnessNit * Number(value('mapping_nit_multiplier') || 1),
    apolloNit: override?.apolloNit ?? row.apolloNit * Number(value('mapping_nit_multiplier') || 1),
    dbv: override?.dbv ?? groupedDbv ?? Math.round(row.apolloDbv * Number(value('mapping_dbv_multiplier') || 1)),
    overridden: Boolean(override),
    groupOverridden: !override && groupedDbv !== undefined
  };
}

function putMappingOverride(overrides, level, dbv, brightnessNit, apolloNit) {
  const linked = value('mapping_edit_mode') === 'linked';
  const bnit = Math.max(0, Number(brightnessNit));
  const anit = linked ? bnit : Math.max(0, Number(apolloNit));
  overrides.set(level, {
    dbv: Math.max(0, Math.min(4095, Math.round(dbv))),
    brightnessNit: Number(bnit.toFixed(3)),
    apolloNit: Number(anit.toFixed(3))
  });
}

function saveMappingOverrides(overrides) {
  const rows = [...overrides.entries()].sort((a, b) => a[0] - b[0]).map(([level, item]) =>
    `${level}|${item.dbv}|${item.brightnessNit}|${item.apolloNit}`);
  setValue('mapping_overrides', rows);
}

function applyMappingRowEdit(level, changedField, fields) {
  const rowIndex = mappingRows.findIndex(row => row.level === level);
  if (rowIndex < 0) return;
  const linked = value('mapping_edit_mode') === 'linked';
  const overrides = mappingOverrides();
  const groupTargets = mappingDbvGroupTargets(overrides);
  const snapshot = mappingRows.map(row => effectiveMapping(row, overrides, groupTargets));
  const current = snapshot[rowIndex];
  const brightnessNit = linked ? fields.linkedNit : fields.brightnessNit;
  const apolloNit = linked ? fields.linkedNit : fields.apolloNit;
  putMappingOverride(overrides, level, fields.dbv, brightnessNit, apolloNit);

  let affectedLevels = 1;
  let affectedGroups = 0;
  if (changedField === 'dbv' && value('mapping_shared_dbv_propagation') === true) {
    const selectedOriginalDbv = mappingRows[rowIndex].apolloDbv;
    const groupDbvTargets = new Map([[selectedOriginalDbv, Math.round(fields.dbv)]]);
    const selectedIndices = mappingRows.map((row, index) => row.apolloDbv === selectedOriginalDbv ? index : -1).filter(index => index >= 0);
    const first = selectedIndices[0], last = selectedIndices.at(-1);
    for (let i = 0; i < first; i++) if (snapshot[i].dbv > fields.dbv) groupDbvTargets.set(mappingRows[i].apolloDbv, Math.round(fields.dbv));
    for (let i = last + 1; i < mappingRows.length; i++) if (snapshot[i].dbv < fields.dbv) groupDbvTargets.set(mappingRows[i].apolloDbv, Math.round(fields.dbv));

    affectedLevels = 0;
    for (const [originalDbv, targetDbv] of groupDbvTargets) {
      const members = mappingRows.filter(row => row.apolloDbv === originalDbv);
      affectedLevels += members.length; affectedGroups++;
      const existing = members.filter(row => overrides.has(row.level));
      const representatives = existing.length ? existing : members.slice(0, 1);
      for (const member of representatives) {
        const state = snapshot[mappingRows.findIndex(row => row.level === member.level)];
        putMappingOverride(overrides, member.level, targetDbv, state.brightnessNit, state.apolloNit);
      }
    }
  }

  const cascadeNit = (field, target) => {
    let changed = 0;
    for (let i = 0; i < mappingRows.length; i++) {
      if (i === rowIndex) continue;
      const mustChange = i < rowIndex ? snapshot[i][field] > target : snapshot[i][field] < target;
      if (!mustChange) continue;
      const row = mappingRows[i]; const state = snapshot[i]; const existing = overrides.get(row.level);
      const dbv = existing?.dbv ?? state.dbv;
      const bnit = field === 'brightnessNit' ? target : (existing?.brightnessNit ?? state.brightnessNit);
      const anit = linked ? bnit : (field === 'apolloNit' ? target : (existing?.apolloNit ?? state.apolloNit));
      putMappingOverride(overrides, row.level, dbv, bnit, anit); changed++;
    }
    return changed;
  };

  let cascadedNit = 0;
  if (changedField === 'linkedNit') cascadedNit = cascadeNit('brightnessNit', brightnessNit);
  if (changedField === 'brightnessNit') cascadedNit = cascadeNit('brightnessNit', brightnessNit);
  if (changedField === 'apolloNit') cascadedNit = cascadeNit('apolloNit', apolloNit);
  saveMappingOverrides(overrides);
  if (changedField === 'dbv' && affectedLevels > 1) toast(`已同步 ${affectedGroups} 个 DBV 分组、${affectedLevels} 个逻辑等级`);
  if (cascadedNit) toast(`已级联修复 ${cascadedNit} 个相邻 nit 等级`);
}

async function bindMapping() {
  if (!mappingRows) {
    const response = await exec(`${ctl} mapping-data`);
    if (response.errno) {
      if (page === 'mapping') document.querySelector('#mappingRows').innerHTML = `<tr><td colspan="6">${esc(response.stderr || '映射读取失败')}</td></tr>`;
      return;
    }
    mappingRows = response.stdout.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
      const p = line.split('|').map(Number);
      return { level: p[0], brightnessIndex: p[1], brightnessNit: p[2], brightnessGain: p[3], apolloDbv: p[4], apolloNit: p[5] };
    }).filter(row => Object.values(row).every(Number.isFinite));
    mappingRowsByLevel = new Map(mappingRows.map(row => [row.level, row]));
    mappingDbvGroupSizes = new Map();
    for (const row of mappingRows) mappingDbvGroupSizes.set(row.apolloDbv, (mappingDbvGroupSizes.get(row.apolloDbv) || 0) + 1);
  }
  if (page !== 'mapping' || !document.querySelector('#mappingCanvas')) return;

  const zoom = document.querySelector('#mappingZoom');
  const pan = document.querySelector('#mappingPan');
  zoom.addEventListener('input', () => { mappingView.zoom = Number(zoom.value); document.querySelector('#mappingZoomText').textContent = `${mappingView.zoom}×`; drawMappingCanvas(); });
  pan.addEventListener('input', () => { mappingView.pan = Number(pan.value); document.querySelector('#mappingPanText').textContent = `${mappingView.pan}%`; drawMappingCanvas(); });
  document.querySelector('#mappingSearch').addEventListener('input', event => { mappingFilter = event.target.value.trim(); mappingPageIndex = 0; renderMappingTable(); });
  document.querySelector('#mappingReverse').addEventListener('click', () => { mappingReverse = !mappingReverse; mappingPageIndex = 0; render(); });
  document.querySelector('#mappingFirst').addEventListener('click', () => { mappingPageIndex = 0; renderMappingTable(); });
  document.querySelector('#mappingPrev').addEventListener('click', () => { mappingPageIndex = Math.max(0, mappingPageIndex - 1); renderMappingTable(); });
  document.querySelector('#mappingNext').addEventListener('click', () => { mappingPageIndex++; renderMappingTable(); });
  document.querySelector('#mappingLast').addEventListener('click', () => {
    const count = mappingFilter ? mappingRows.filter(row => String(row.level).includes(mappingFilter)).length : mappingRows.length;
    mappingPageIndex = Math.max(0, Math.ceil(count / mappingPageSize) - 1); renderMappingTable();
  });
  document.querySelector('#mappingModeToggle')?.addEventListener('click', () => {
    if (value('unsafe_mode') !== true || value('mapping_relationship') !== 'linked_equal') return;
    if (value('mapping_edit_mode') === 'linked') {
      if (!window.confirm('强制分开后，同一 Level 的 brightness nit 与 Apollo nit 可以不同，可能造成模式切换跳变或钳位。确认继续吗？')) return;
      setValue('mapping_edit_mode', 'separate');
    } else {
      if (!window.confirm('恢复联动会让现有单行覆盖中的 Apollo nit 跟随 brightness nit。确认合并吗？')) return;
      const overrides = mappingOverrides();
      for (const item of overrides.values()) item.apolloNit = item.brightnessNit;
      setValue('mapping_edit_mode', 'linked'); saveMappingOverrides(overrides);
    }
    render();
  });
  document.querySelector('#mappingPropagation')?.addEventListener('change', event => {
    if (!event.target.checked && !window.confirm('关闭后，原本共用同一 DBV 的多个 Level 可被拆散，可能产生亮度跳变。确认关闭吗？')) { event.target.checked = true; return; }
    setValue('mapping_shared_dbv_propagation', event.target.checked); updateMappingDisplay();
  });
  content.querySelectorAll('[data-mapping-multiply]').forEach(button => button.addEventListener('click', () => multiplyMapping(button.dataset.mappingMultiply)));
  updateMappingDisplay();
}

function updateMappingDisplay() {
  if (page !== 'mapping' || !mappingRows?.length) return;
  const overrides = mappingOverrides();
  const groupTargets = mappingDbvGroupTargets(overrides);
  const effective = mappingRows.map(row => effectiveMapping(row, overrides, groupTargets));
  const range = values => `${Math.min(...values).toFixed(3).replace(/\.000$/, '')} ～ ${Math.max(...values).toFixed(3).replace(/\.000$/, '')}`;
  const originalBrightness = mappingRows.map(row => row.brightnessNit);
  const originalApollo = mappingRows.map(row => row.apolloNit);
  const originalDbv = mappingRows.map(row => row.apolloDbv);
  const currentBrightness = effective.map(row => row.brightnessNit);
  const currentApollo = effective.map(row => row.apolloNit);
  const currentDbv = effective.map(row => row.dbv);
  document.querySelector('#mappingMetrics').innerHTML = `<div class="metric-row mapping-metrics">
    <div class="metric"><strong>${mappingRows.length}</strong><span>映射级数 · Level ${mappingRows[0].level}～${mappingRows.at(-1).level}</span></div>
    <div class="metric"><strong>${range(originalBrightness)}</strong><span>原厂 brightness nit</span><small>预览：${range(currentBrightness)}</small></div>
    <div class="metric"><strong>${range(originalApollo)}</strong><span>原厂 Apollo nit</span><small>预览：${range(currentApollo)}</small></div>
    <div class="metric"><strong>${range(originalDbv)}</strong><span>原厂 Apollo DBV</span><small>预览：${range(currentDbv)}</small></div>
  </div>`;
  document.querySelector('#mappingNitFactor').textContent = `${value('mapping_nit_multiplier')}×`;
  document.querySelector('#mappingDbvFactor').textContent = `${value('mapping_dbv_multiplier')}×`;
  document.querySelector('#mappingOverrideCount').textContent = overrides.size;
  renderMappingTable();
  drawMappingCanvas();
}

function renderMappingTable() {
  const tbody = document.querySelector('#mappingRows');
  if (!tbody || !mappingRows) return;
  const unlocked = value('unsafe_mode') === true && !saving;
  const linked = value('mapping_edit_mode') === 'linked';
  const overrides = mappingOverrides();
  const groupTargets = mappingDbvGroupTargets(overrides);
  const sourceRows = mappingFilter ? mappingRows.filter(row => String(row.level).includes(mappingFilter)) : mappingRows;
  const filtered = mappingReverse ? [...sourceRows].reverse() : sourceRows;
  const pages = Math.max(1, Math.ceil(filtered.length / mappingPageSize));
  mappingPageIndex = Math.min(mappingPageIndex, pages - 1);
  const rows = filtered.slice(mappingPageIndex * mappingPageSize, (mappingPageIndex + 1) * mappingPageSize);
  tbody.innerHTML = rows.map(row => {
    const now = effectiveMapping(row, overrides, groupTargets); const disabled = unlocked ? '' : 'disabled';
    const shared = mappingDbvGroupSizes.get(row.apolloDbv) || 1;
    const status = now.overridden ? '<span class="tag overridden">单行覆盖</span>' : (now.groupOverridden ? '<span class="tag overridden">DBV 组联动</span>' : (Number(value('mapping_nit_multiplier')) !== 1 || Number(value('mapping_dbv_multiplier')) !== 1 ? '<span class="tag multiplied">统一倍率</span>' : '<span class="tag">原厂</span>'));
    const nitCells = linked
      ? `<td><input class="table-input mapping-edit" data-field="linkedNit" type="number" min="0" step="0.001" value="${Number(now.brightnessNit.toFixed(3))}" ${disabled}></td><td><input class="table-input mapping-edit" data-field="dbv" type="number" step="1" min="0" max="4095" value="${now.dbv}" ${disabled}></td>`
      : `<td><input class="table-input mapping-edit" data-field="brightnessNit" type="number" min="0" step="0.001" value="${Number(now.brightnessNit.toFixed(3))}" ${disabled}></td><td><input class="table-input mapping-edit" data-field="dbv" type="number" step="1" min="0" max="4095" value="${now.dbv}" ${disabled}></td><td><input class="table-input mapping-edit" data-field="apolloNit" type="number" min="0" step="0.001" value="${Number(now.apolloNit.toFixed(3))}" ${disabled}></td>`;
    return `<tr data-level="${row.level}"><td>${row.level}</td><td>${row.brightnessIndex}</td>${nitCells}<td>${shared > 1 ? `${shared} 个 Level` : '独立'}</td><td>${status}</td></tr>`;
  }).join('') || `<tr><td colspan="${linked ? 6 : 7}">没有匹配的 Level</td></tr>`;
  document.querySelector('#mappingPageLabel').textContent = `第 ${mappingPageIndex + 1}/${pages} 页 · ${filtered.length} 行 · ${mappingReverse ? 'Level 逆序' : 'Level 正序'}`;
  document.querySelector('#mappingFirst').disabled = mappingPageIndex <= 0;
  document.querySelector('#mappingPrev').disabled = mappingPageIndex <= 0;
  document.querySelector('#mappingNext').disabled = mappingPageIndex >= pages - 1;
  document.querySelector('#mappingLast').disabled = mappingPageIndex >= pages - 1;
  tbody.querySelectorAll('.mapping-edit').forEach(input => input.addEventListener('change', () => {
    const tr = input.closest('tr'); const level = Number(tr.dataset.level);
    const fields = Object.fromEntries([...tr.querySelectorAll('.mapping-edit')].map(item => [item.dataset.field, Number(item.value)]));
    const brightnessNit = linked ? fields.linkedNit : fields.brightnessNit;
    const apolloNit = linked ? fields.linkedNit : fields.apolloNit;
    if (!Object.values(fields).every(Number.isFinite) || fields.dbv < 0 || fields.dbv > 4095 || brightnessNit < 0 || apolloNit < 0) {
      showResult('映射值无效', 'DBV 必须为 0～4095，两个 nit 必须是非负数字。'); renderMappingTable(); return;
    }
    applyMappingRowEdit(level, input.dataset.field, fields);
    updateMappingDisplay();
  }));
}

function multiplyMapping(target) {
  const factor = Number(document.querySelector('#mappingMultiplyFactor').value);
  if (!Number.isFinite(factor) || factor < .01 || factor > 10) return showResult('倍率无效', '本次乘数必须在 0.01～10。');
  const affectNit = target === 'nit' || target === 'both';
  const affectDbv = target === 'dbv' || target === 'both';
  const nextNitFactor = Number(value('mapping_nit_multiplier')) * (affectNit ? factor : 1);
  const nextDbvFactor = Number(value('mapping_dbv_multiplier')) * (affectDbv ? factor : 1);
  if (nextNitFactor < .01 || nextNitFactor > 10 || nextDbvFactor < .01 || nextDbvFactor > 10) return showResult('累计倍率越界', '累计统一倍率必须保持在 0.01～10。');
  if (affectDbv) {
    const overrides = mappingOverrides(); const groups = mappingDbvGroupTargets(overrides);
    const maxDbv = Math.max(...mappingRows.map(row => effectiveMapping(row, overrides, groups).dbv));
    if (Math.round(maxDbv * factor) > 4095) return showResult('DBV 超过硬限制', `当前最大 DBV ${maxDbv} × ${factor} 将超过 4095。`);
  }
  if (affectNit) setValue('mapping_nit_multiplier', Number(nextNitFactor.toFixed(6)));
  if (affectDbv) setValue('mapping_dbv_multiplier', Number(nextDbvFactor.toFixed(6)));
  const adjusted = (value('mapping_overrides') || []).map(entry => {
    const p = String(entry).split('|').map(Number); if (p.length === 3) p.push(p[2]);
    if (affectDbv) p[1] = Math.round(p[1] * factor);
    if (affectNit) { p[2] = Number((p[2] * factor).toFixed(3)); p[3] = Number((p[3] * factor).toFixed(3)); }
    return p.slice(0, 4).join('|');
  });
  if (adjusted.length) setValue('mapping_overrides', adjusted);
  updateMappingDisplay();
}

function drawMappingCanvas() {
  const canvas = document.querySelector('#mappingCanvas');
  if (!canvas || !mappingRows?.length) return;
  const ctx = canvas.getContext('2d'); const m = { l: 72, r: 18, t: 20, b: 44 };
  const orderedRows = mappingReverse ? [...mappingRows].reverse() : mappingRows;
  const span = Math.max(2, Math.ceil(orderedRows.length / mappingView.zoom));
  const start = Math.round((orderedRows.length - span) * mappingView.pan / 100);
  const rows = orderedRows.slice(start, start + span); const overrides = mappingOverrides(); const groups = mappingDbvGroupTargets(overrides);
  const current = rows.map(row => effectiveMapping(row, overrides, groups));
  const maxY = Math.max(1, ...current.flatMap(row => [row.brightnessNit, row.apolloNit, row.dbv]));
  const x = index => m.l + index / Math.max(1, rows.length - 1) * (canvas.width - m.l - m.r);
  const y = number => m.t + (1 - number / maxY) * (canvas.height - m.t - m.b);
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineWidth = 1; ctx.font = '11px system-ui';
  const yTicks = 8; const xTicks = 8;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= yTicks; i++) {
    const fraction = i / yTicks; const gy = m.t + fraction * (canvas.height - m.t - m.b);
    ctx.strokeStyle = i === 0 || i === yTicks ? '#3a4456' : '#293242';
    ctx.beginPath(); ctx.moveTo(m.l, gy); ctx.lineTo(canvas.width - m.r, gy); ctx.stroke();
    ctx.fillStyle = '#aab6c7'; ctx.fillText(axisText((1 - fraction) * maxY), m.l - 8, gy);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.min(rows.length - 1, Math.round(i / xTicks * (rows.length - 1))); const gx = x(index);
    ctx.strokeStyle = i === 0 || i === xTicks ? '#3a4456' : '#252e3d';
    ctx.beginPath(); ctx.moveTo(gx, m.t); ctx.lineTo(gx, canvas.height - m.b); ctx.stroke();
    ctx.fillStyle = '#9aa8ba'; ctx.fillText(axisText(rows[index].level), gx, canvas.height - m.b + 8);
  }
  const draw = (field, color) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); current.forEach((row, i) => i ? ctx.lineTo(x(i), y(row[field])) : ctx.moveTo(x(i), y(row[field]))); ctx.stroke(); };
  draw('brightnessNit', '#79a7ff'); draw('apolloNit', '#61d69b'); draw('dbv', '#f6bd60');
  ctx.fillStyle = '#9aa8ba'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('逻辑 Level', (m.l + canvas.width - m.r) / 2, canvas.height - 5);
  ctx.save(); ctx.translate(13, (m.t + canvas.height - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('nit / DBV（共用刻度）', 0, 0); ctx.restore();
}

function bindSettings() {
  document.querySelector('#toggleUnsafe').addEventListener('click', () => {
    if (value('unsafe_mode') === true) {
      config.unsafe_mode.value = false; config.unsafe_acknowledgement.value = ''; markDirty('unsafe_mode'); markDirty('unsafe_acknowledgement'); render(); return;
    }
    if (!window.confirm('危险模式可能导致黑屏、烧屏、异常温升或色偏。\n建议先安装可信来源的救砖/开机禁用模块并创建配置备份。\n\n确定开启危险模式吗？')) return;
    config.unsafe_mode.value = true; config.unsafe_acknowledgement.value = 'I_UNDERSTAND_THE_RISK'; markDirty('unsafe_mode'); markDirty('unsafe_acknowledgement'); render();
  });
  document.querySelector('#localBackup').addEventListener('click', async () => showExecResult('创建模块备份', await exec(`${ctl} backup`)));
  document.querySelector('#exportConfig').addEventListener('click', exportBrowser);
  document.querySelector('#exportSdcard').addEventListener('click', async () => showExecResult('保存到 Download', await exec(`${ctl} export`)));
  document.querySelector('#importConfig').addEventListener('click', () => document.querySelector('#importFile').click());
  document.querySelector('#restoreAll').addEventListener('click', () => {
    if (!window.confirm('确定把所有可编辑项目恢复为安装时读取的原厂值吗？')) return;
    for (const [key, item] of Object.entries(config)) {
      if (key === 'unsafe_mode' || key === 'unsafe_acknowledgement') continue;
      if (item && typeof item === 'object' && Object.hasOwn(item, 'original')) { item.value = clone(item.original); markDirty(key); }
    }
    toast('已恢复亮度配置；危险模式解锁状态保持不变');
    render();
  });
}

function exportBrowser() {
  const blob = new Blob([canonicalJson(config)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `OPlusBrightness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelector('#importFile').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (incoming.schema_version?.value !== config.schema_version?.value) throw new Error('配置格式版本不同');
    const sameDevice = incoming.device_fingerprint?.value === config.device_fingerprint?.value;
    const protectedKeys = new Set([...pageKeys.hbm, ...pageKeys.mapping, ...pageKeys.calibration, ...pageKeys.thermal]);
    const immutableKeys = new Set(['schema_version', 'device_fingerprint', 'target_etc', 'brightness_file', 'apollo_file', 'sensor_file',
      'app_policy_original_max', 'safe_nit_max', 'panel_mapping_max_nit', 'panel_mapping_max_dbv', 'mapping_relationship', 'mapping_relationship_stats',
      'unsafe_mode', 'unsafe_acknowledgement']);
    let imported = 0, skipped = 0;
    for (const [key, item] of Object.entries(incoming)) {
      if (!setting(key) || !item || typeof item !== 'object' || !Object.hasOwn(item, 'value')) continue;
      if (immutableKeys.has(key)) continue;
      if (!sameDevice && protectedKeys.has(key)) { skipped++; continue; }
      config[key].value = clone(item.value); markDirty(key); imported++;
    }
    showResult('配置已读取', sameDevice ? `已读取 ${imported} 项；当前危险模式解锁状态已保留。点击“保存并应用”后写入模块。` : `系统指纹不同：已读取 ${imported} 个通用项目，跳过 ${skipped} 个 HBM/温控/硬件标定项目；当前危险模式解锁状态已保留。`);
    render();
  } catch (error) { showResult('读取失败', String(error)); }
  event.target.value = '';
});

async function saveAndApply() {
  if (saving) return;
  normalizeAllCurves();
  saving = true; saveButton.disabled = true; document.querySelector('#saveText').textContent = '后台应用中…';
  content.classList.add('write-lock'); statusPill.textContent = '正在写入队列 · 可切换页面'; statusPill.className = 'status warn';
  const bytes = new TextEncoder().encode(canonicalJson(config));
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x4000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  const job = `webui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const encoded = btoa(binary); const remote = `${MODULE}/data/state/${job}.b64`; const jsonPath = `${MODULE}/data/state/${job}.json`;
  let response = await exec(`: > '${remote}'`);
  if (!response.errno) {
    for (let i = 0; i < encoded.length; i += 12000) {
      response = await exec(`printf '%s' '${encoded.slice(i, i + 12000)}' >> '${remote}'`);
      if (response.errno) break;
    }
  }
  if (!response.errno) response = await exec(`base64 -d '${remote}' > '${jsonPath}' && ${ctl} queue-apply '${jsonPath}' '${job}'; rc=$?; rm -f '${remote}' '${jsonPath}'; exit $rc`);
  let finalResponse = response;
  const queueLine = String(response.stdout || '').split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('QUEUED '));
  const queueAccepted = queueLine === `QUEUED ${job}`;
  if (queueAccepted) {
    statusPill.textContent = `后台应用中 · ${job}`; statusPill.className = 'status warn';
    const started = Date.now();
    finalResponse = null;
    while (Date.now() - started < 10 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const poll = await exec(`${ctl} job-status '${job}'`);
      const pollText = String(poll.stdout || '').replace(/^\s+/, '');
      const done = pollText.match(/^DONE\s+([0-9]+)(?:\r?\n|$)/);
      if (done) {
        const rc = Number(done[1]);
        finalResponse = { errno: rc, stdout: pollText.replace(/^DONE[^\n]*(?:\n|$)/, ''), stderr: poll.stderr || '' };
        break;
      }
      if (poll.errno && !/^RUNNING(?:\r?\n|$)/.test(pollText)) {
        finalResponse = { errno: Number(poll.errno) || 1, stdout: poll.stdout || '', stderr: `${poll.stderr || '任务状态读取失败'}\njob=${job}` };
        break;
      }
    }
    if (!finalResponse) finalResponse = { errno: 124, stdout: '', stderr: `后台应用超过 10 分钟仍未完成。\njob=${job}\n日志：${MODULE}/data/logs/apply.log` };
  } else if (!response.errno) {
    finalResponse = { errno: 65, stdout: response.stdout || '', stderr: `后台未返回预期队列确认。\n预期：QUEUED ${job}\n请查看 ${MODULE}/data/logs/apply.log` };
  }
  saving = false; content.classList.remove('write-lock');
  if (finalResponse.errno) {
    showExecResult('保存与应用失败', { ...finalResponse, stderr: `${finalResponse.stderr || ''}\n任务号：${job}`.trim() });
    saveButton.disabled = dirty.size === 0;
    await loadStatus(); updateHeader();
  } else {
    dirty.clear(); dirtyCount.textContent = '0';
    showExecResult('保存并应用成功', { ...finalResponse, stdout: `${finalResponse.stdout}\nJSON、生成文件和挂载均已完成。显示服务可能缓存 XML，请重启设备以可靠生效。` });
    await loadStatus(); updateHeader();
  }
  document.querySelector('#saveText').textContent = '保存并应用';
  render();
}

function showExecResult(title, response) { showResult(title, [response.stdout, response.stderr].filter(Boolean).join('\n') || `errno=${response.errno}`); }
function showResult(title, text) { document.querySelector('#resultTitle').textContent = title; document.querySelector('#resultBody').textContent = text; resultDialog.showModal(); }

async function loadStatus() {
  const response = await exec(`${ctl} status`);
  try { status = JSON.parse(response.stdout || '{}'); } catch (_) { status = { state: 'status_error', message: response.stderr }; }
}

function updateHeader() {
  const state = status.state || 'unknown';
  const labels = { applied: '已应用', pending_reboot: '待重启', generated: '已生成', validation_failed: '校验失败', build_failed: '生成失败', rolled_back: '已回滚', mount_incomplete: '挂载不完整', not_initialized: '未初始化' };
  statusPill.textContent = `${labels[state] || state}${Number.isFinite(status.changed_files) ? ` · ${status.changed_files} 文件` : ''}`;
  statusPill.className = `status ${state === 'applied' ? 'ok' : state.includes('failed') || state === 'rolled_back' ? 'error' : 'warn'}`;
  deviceLine.textContent = `${value('device_fingerprint') || '未知设备'} · ${value('brightness_file') || ''}`;
}

function switchPage(next) {
  page = next;
  document.querySelectorAll('#nav button').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  render(); content.focus(); window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('#nav button').forEach(button => button.addEventListener('click', () => switchPage(button.dataset.page)));
saveButton.addEventListener('click', saveAndApply);

async function init() {
  const response = await exec(`${ctl} read-config`);
  if (response.errno) {
    content.innerHTML = `<section class="empty-state"><h2>无法读取模块配置</h2><p>${esc(response.stderr || '请确认从 KernelSU WebUI 打开，并检查模块是否完成初始化。')}</p></section>`;
    statusPill.textContent = '读取失败'; statusPill.className = 'status error'; return;
  }
  try { config = JSON.parse(response.stdout); }
  catch (error) { content.innerHTML = `<section class="empty-state"><h2>config.json 无效</h2><p>${esc(error)}</p></section>`; statusPill.textContent = 'JSON 错误'; statusPill.className = 'status error'; return; }
  await loadStatus(); updateHeader(); render();
}

init();
