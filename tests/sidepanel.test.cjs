const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {src, job} = require('./helpers.cjs');
function panel(config = {}, getState = () => ({phase: 'idle', screened: []})) {
  const dom = new JSDOM(src('sidepanel.html'), {runScripts: 'outside-only'});
  const w = dom.window, messages = [], data = {...config}, ticks = [], listeners = [];
  w.setInterval = fn => { ticks.push(fn); return ticks.length; };
  w.chrome = {storage: {local: {get: (_, cb) => cb(data), set: (obj, cb) => {Object.assign(data, obj); if (cb) cb();}}}, runtime: {onMessage: {addListener: fn => listeners.push(fn)}, sendMessage: (msg, cb) => {messages.push(msg); if (cb) cb(getState());}}};
  w.eval(src('salary.js')); w.eval(src('sidepanel.js'));
  return {w, data, messages, dom, tick: () => ticks.forEach(fn => fn()), receive: msg => listeners.forEach(fn => fn(msg))};
}
test('新配置能保存和回显，当前页模式无关键词也能开始', async () => {
  const p = panel({dsKey: 'test', collectSource: 'current', experience: '102', excludeSeen: false});
  assert.equal(p.w.document.querySelector('#excludeSeen').checked, false);
  assert.equal(p.w.document.querySelector('#experience').value, '102');
  p.w.document.querySelector('#btnCollect').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(p.messages.some(m => m.type === 'START_COLLECT')); assert.equal(p.data.excludeSeen, false); p.w.close();
});
test('自动扩展默认开启，可关闭并保存；重置搜索只发送专用消息', () => {
  const p = panel();
  const checkbox = p.w.document.getElementById('expandSearch');
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  p.w.document.getElementById('saveCfg').click();
  assert.equal(p.data.expandSearch, false);
  p.w.document.getElementById('resetSearch').click();
  assert.equal(p.messages.at(-1).type, 'RESET_SEARCH');
  p.w.close();
  const q = panel({expandSearch:false});
  assert.equal(q.w.document.getElementById('expandSearch').checked, false); q.w.close();
});
test('AI 未推荐岗位默认不勾选但允许人工选择，展示应届生标签', async () => {
  const p = panel();
  p.w.renderReview([{...job('a'), match: false, reason: '需要核对毕业届别'}]);
  const checkbox = p.w.document.querySelector('.skip input');
  assert.equal(checkbox.disabled, false); assert.equal(checkbox.checked, false);
  checkbox.click(); p.w.document.querySelector('#btnDeliver').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.messages.find(m => m.type === 'START_DELIVER').jobIds[0], 'a');
  assert.match(p.w.document.querySelector('#reviewList').textContent, /应届生/); p.w.close();
});

test('薪资配置持久化并回显，切换计薪单位清空数值避免混用', () => {
  const p = panel({salaryPeriod: 'month', salaryMin: '15', salaryMax: '25', salaryUnknown: false});
  const el = id => p.w.document.getElementById(id);
  assert.equal(el('salaryBounds').hidden, false);
  assert.equal(el('salaryMin').value, '15'); assert.equal(el('salaryUnknown').checked, false);
  el('salaryMin').value = '18'; el('saveCfg').click(); assert.equal(p.data.salaryMin, '18');
  el('salaryPeriod').value = 'day'; el('salaryPeriod').dispatchEvent(new p.w.Event('change'));
  assert.equal(el('salaryMin').value, ''); assert.equal(el('salaryMax').value, '');
  assert.match(el('salaryMin').placeholder, /元\/天/); p.w.close();
});
test('无效薪资范围不能保存或开始收集，旧配置默认不限', async () => {
  const p = panel({dsKey: 'test', keyword: '开发'});
  const el = id => p.w.document.getElementById(id);
  assert.equal(el('salaryBounds').hidden, true);
  el('salaryPeriod').value = 'month'; el('salaryMin').value = '25'; el('salaryMax').value = '15';
  el('saveCfg').click(); el('btnCollect').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.data.salaryMin, undefined);
  assert.equal(p.messages.some(m => m.type === 'START_COLLECT'), false);
  assert.match(el('log').textContent, /下限不能高于上限/); p.w.close();
});

test('15K 条件立即过滤已有审核列表，字体编码薪资解码显示', () => {
  const p=panel({salaryPeriod:'month',salaryMin:'15',salaryUnknown:true});
  const jobs=[{...job('low'),salary:'\ue034-\ue035K',match:true},{...job('high'),salary:'\ue032\ue036-\ue033\ue031K',match:true}];
  p.w.renderReview(jobs);
  assert.equal(p.w.document.querySelector('[data-id="low"]'),null);
  assert.match(p.w.document.querySelector('#reviewList').textContent,/15-20K/);
  const min=p.w.document.getElementById('salaryMin'); min.value='3'; min.dispatchEvent(new p.w.Event('input'));
  assert.ok(p.w.document.querySelector('[data-id="low"]'));
  min.value='15'; min.dispatchEvent(new p.w.Event('input'));
  assert.equal(p.w.document.querySelector('[data-id="low"]'),null);
  p.w.close();
});
test('点击投递会先保存当前薪资，旧低薪岗位不能被全选带回', async () => {
  const p=panel();
  p.w.renderReview([{...job('low'),salary:'3-4K',match:true},{...job('high'),salary:'15-20K',match:true}]);
  const el=id=>p.w.document.getElementById(id);
  el('salaryPeriod').value='month'; el('salaryMin').value='15';
  el('btnDeliver').click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.data.salaryMin,'15');
  assert.deepEqual(Array.from(p.messages.find(m=>m.type==='START_DELIVER').jobIds),['high']); p.w.close();
});

// 模拟后台被 Chrome 回收：侧栏仍开着，下次查询返回恢复后的审核状态。
test('后台重启后侧栏自动脱离 AI 筛选中，保留审核勾选', () => {
  const jobs = [{...job('a'), match: true}];
  let saved = {phase: 'screening', screened: jobs};
  const p = panel({}, () => saved);
  const el = id => p.w.document.getElementById(id);
  assert.equal(el('phaseText').textContent, 'AI筛选中');
  assert.equal(el('btnDeliver').disabled, true);
  p.w.document.querySelector('.job-item input').checked = false;
  saved = {phase: 'review', screened: jobs};
  p.tick();
  assert.equal(el('phaseText').textContent, '待审核');
  assert.equal(el('btnDeliver').disabled, false);
  assert.equal(p.w.document.querySelector('.job-item input').checked, false);
  p.w.close();
});

test('旧状态查询晚于实时消息返回时不能把界面锁回筛选中', () => {
  const p = panel();
  let delayed;
  p.w.chrome.runtime.sendMessage = (_, callback) => {delayed = callback;};
  p.w.syncState();
  p.receive({type: 'PHASE', phase: 'review'});
  delayed({phase: 'screening', screened: []});
  assert.equal(p.w.document.getElementById('phaseText').textContent, '待审核');
  assert.equal(p.w.document.getElementById('btnDeliver').disabled, false);
  p.w.close();
});
