// ===== 侧边栏交互 =====
const $ = (id) => document.getElementById(id);
const CFG_FIELDS = ['dsKey', 'resumeText', 'keyword', 'city', 'count', 'experience', 'collectSource', 'excludeSeen', 'expandSearch', 'salaryPeriod', 'salaryMin', 'salaryMax', 'salaryUnknown'];

let reviewJobs = [];
let panelRunning = false;
let salaryInvalid = false;
let stateRevision = 0;
let lastNotice = '';
const phaseLabels = {idle: '未开始', collecting: '收集中', screening: 'AI筛选中', review: '待审核', delivering: '投递中', done: '已完成'};

// 折叠
document.querySelectorAll('.card-h[data-toggle]').forEach(h => {
  h.addEventListener('click', () => {
    const body = $(h.dataset.toggle);
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });
});

// 载入配置
chrome.storage.local.get(CFG_FIELDS.concat(['resumeImage']), (d) => {
  CFG_FIELDS.forEach(f => { if (d[f] !== undefined && $(f)) { if ($(f).type === 'checkbox') $(f).checked = d[f]; else $(f).value = d[f]; } });
  updateSalaryFields();
  if (reviewJobs.length) renderReview(reviewJobs, true);
  if (d.resumeImage) showImg(d.resumeImage);
});

function updateSalaryFields() {
  const enabled = !!$('salaryPeriod').value;
  ['salaryBounds', 'salaryUnknownLabel', 'salaryHint'].forEach(id => $(id).hidden = !enabled);
  const unit = { month: 'K/月', day: '元/天', year: '万/年' }[$('salaryPeriod').value];
  $('salaryMin').placeholder = '下限（' + (unit || '不限') + '）';
  $('salaryMax').placeholder = '上限（' + (unit || '不限') + '）';
}
$('salaryPeriod').addEventListener('change', () => {
  // 切换单位时清空数值，避免把月薪 20K 当作日薪 20 元。
  $('salaryMin').value = ''; $('salaryMax').value = '';
  updateSalaryFields();
  refreshSalaryReview();
});
function readSalaryFilter() {
  if (['salaryMin', 'salaryMax'].some(id => $(id).validity.badInput)) throw new Error('薪资请输入有效数字');
  return BOSS_SALARY.config({salaryPeriod: $('salaryPeriod').value, salaryMin: $('salaryMin').value,
    salaryMax: $('salaryMax').value, salaryUnknown: $('salaryUnknown').checked});
}
function refreshSalaryReview() { if (reviewJobs.length) renderReview(reviewJobs, true); }
['salaryMin', 'salaryMax'].forEach(id => $(id).addEventListener('input', refreshSalaryReview));
$('salaryUnknown').addEventListener('change', refreshSalaryReview);
function readCfg() {
  const obj = {};
  CFG_FIELDS.forEach(f => { obj[f] = $(f).type === 'checkbox' ? $(f).checked : $(f).value.trim(); });
  if (['salaryMin', 'salaryMax'].some(id => $(id).validity.badInput)) throw new Error('薪资请输入有效数字');
  BOSS_SALARY.config(obj);
  return obj;
}
function showImg(dataUrl) { $('imgPrev').innerHTML = '<img src="' + dataUrl + '">'; }

$('resumeImg').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { showImg(ev.target.result); chrome.storage.local.set({ resumeImage: ev.target.result }); };
  reader.readAsDataURL(file);
});

$('saveCfg').addEventListener('click', () => {
  let obj;
  try { obj = readCfg(); } catch (e) { addLog(e.message, 'error'); return; }
  chrome.storage.local.set(obj, () => { const s = $('saved'); s.style.display = 'inline'; setTimeout(() => s.style.display = 'none', 1500); });
});

function saveCfgSync() {
  const obj = readCfg();
  return new Promise(res => {
    chrome.storage.local.set(obj, res);
  });
}

// 运行控制
$('btnCollect').addEventListener('click', async () => {
  try { await saveCfgSync(); } catch (e) { addLog(e.message, 'error'); return; }
  if (!$('dsKey').value.trim()) return addLog('请先填 DeepSeek API Key', 'error');
  if ($('collectSource').value !== 'current' && !$('keyword').value.trim()) return addLog('请先填岗位关键词', 'error');
  $('reviewCard').style.display = 'none';
  setRunning(true);
  chrome.runtime.sendMessage({ type: 'START_COLLECT' });
});

$('btnDeliver').addEventListener('click', async () => {
  try { await saveCfgSync(); } catch (e) { addLog(e.message, 'error'); return; }
  if (reviewJobs.length) renderReview(reviewJobs, true);
  const ids = Array.from(document.querySelectorAll('.job-item input:checked')).map(c => c.dataset.id);
  if (!ids.length) return addLog('请至少勾选一个岗位', 'error');
  setRunning(true);
  addLog('开始投递 ' + ids.length + ' 个岗位', 'info');
  chrome.runtime.sendMessage({ type: 'START_DELIVER', jobIds: ids });
});

$('btnPause').addEventListener('click', () => {
  if ($('btnPause').textContent === '暂停') { $('btnPause').textContent = '继续'; chrome.runtime.sendMessage({ type: 'PAUSE' }); }
  else { $('btnPause').textContent = '暂停'; chrome.runtime.sendMessage({ type: 'RESUME' }); }
});
$('btnStop').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'STOP' }); $('btnStop').disabled = true; });
$('btnReset').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'RESET' }); $('reviewCard').style.display = 'none'; setRunning(false); });
$('clearCollected').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR_COLLECTED' }));
$('resetSearch').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'RESET_SEARCH' }));
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

$('selAll').addEventListener('change', (e) => {
  document.querySelectorAll('.job-item:not(.skip) input').forEach(c => c.checked = e.target.checked);
});

function setRunning(running) {
  stateRevision++;
  panelRunning = running;
  $('btnCollect').disabled = running;
  $('btnDeliver').disabled = running || salaryInvalid;
  $('btnReset').disabled = running;
  $('clearCollected').disabled = running;
  $('resetSearch').disabled = running;
  $('btnPause').disabled = !running;
  $('btnStop').disabled = !running;
  if (!running) $('btnPause').textContent = '暂停';
}

// 渲染审核列表
function renderReview(screened, preserveSelection = false) {
  const selected = new Map(Array.from(document.querySelectorAll('.job-item input')).map(c => [c.dataset.id, c.checked]));
  reviewJobs = screened;
  let filter;
  try { filter = readSalaryFilter(); salaryInvalid = false; }
  catch (e) {
    salaryInvalid = true;
    $('reviewList').innerHTML = '';
    $('reviewCount').textContent = '请修正薪资范围';
    $('salaryReviewSummary').textContent = e.message;
    $('btnDeliver').disabled = true;
    $('reviewCard').style.display = 'block';
    return;
  }
  screened = screened.filter(j => BOSS_SALARY.matches(j.salary, filter));
  $('salaryReviewSummary').textContent = filter.period
    ? '当前薪资：' + BOSS_SALARY.describe(filter) + '；已隐藏 ' + (reviewJobs.length - screened.length) + ' 个不符合或薪资解析异常的岗位。'
    : '当前不限薪资。';
  $('btnDeliver').disabled = panelRunning;
  const checked = j => (preserveSelection && selected.has(j.id) ? selected.get(j.id) : j.match) ? ' checked' : '';
  const matched = screened.filter(j => j.match);
  const skipped = screened.filter(j => !j.match);
  $('reviewCount').textContent = '匹配 ' + matched.length + ' / ' + screened.length;
  let html = '';
  matched.forEach(j => {
    html += '<div class="job-item"><input type="checkbox"' + checked(j) + ' data-id="' + esc(j.id) + '">'
      + '<div class="job-main"><div class="job-title">' + esc(j.name) + '</div>'
      + '<div class="job-sub">' + esc(j.company) + ' · ' + esc(BOSS_SALARY.normalize(j.salary)) + '</div><div class="job-sub">' + esc((j.tags || []).join(' · ')) + '</div>'
      + '<div class="job-reason m">✓ ' + esc(j.reason) + '</div></div></div>';
  });
  skipped.forEach(j => {
    html += '<div class="job-item skip"><input type="checkbox"' + checked(j) + ' data-id="' + esc(j.id) + '">'
      + '<div class="job-main"><div class="job-title">' + esc(j.name) + '</div>'
      + '<div class="job-sub">' + esc(j.company) + ' · ' + esc(BOSS_SALARY.normalize(j.salary)) + '</div><div class="job-sub">' + esc((j.tags || []).join(' · ')) + '</div>'
      + '<div class="job-reason s">✗ ' + esc(j.reason) + '</div></div></div>';
  });
  $('reviewList').innerHTML = html || '<div class="job-sub">无岗位</div>';
  $('reviewCard').style.display = 'block';
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 消息接收
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') addLog(msg.text, msg.level);
  if (msg.type === 'PROGRESS') $('progText').textContent = (msg.label ? msg.label + ' ' : '') + msg.cur + '/' + msg.total;
  if (msg.type === 'PHASE') {
    $('phaseText').textContent = phaseLabels[msg.phase] || msg.phase;
    setRunning(['collecting', 'screening', 'delivering'].includes(msg.phase));
  }
  if (msg.type === 'SCREENED') { stateRevision++; renderReview(msg.screened, true); }
  if (msg.type === 'DONE') { setRunning(false); $('progText').textContent = ''; }
});

function addLog(text, level) {
  level = level || 'info';
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const el = document.createElement('div');
  el.className = 'log-item ' + level;
  el.innerHTML = '<span class="log-time">[' + t + ']</span>' + esc(text);
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

// 运行期间定期核对后台状态：后台被回收后不能永久停在“筛选中”。
// 版本检查防止较早的查询响应覆盖刚收到的实时状态。
function syncState() {
  const revision = stateRevision;
  chrome.runtime.sendMessage({type: 'GET_STATE'}, saved => {
    if (chrome.runtime.lastError || !saved || revision !== stateRevision) return;
    if (Array.isArray(saved.screened) && (saved.screened.length || reviewJobs.length)) renderReview(saved.screened, true);
    const busy = ['collecting', 'screening', 'delivering'].includes(saved.phase);
    setRunning(busy);
    $('phaseText').textContent = phaseLabels[saved.phase] || saved.phase;
    $('btnPause').textContent = saved.paused ? '继续' : '暂停';
    if (!busy) $('progText').textContent = '';
    if (saved.notice && saved.notice !== lastNotice) { addLog(saved.notice, 'warn'); lastNotice = saved.notice; }
  });
}
syncState();
setInterval(() => { if (panelRunning) syncState(); }, 5000);
