const test = require('node:test');
const assert = require('node:assert/strict');
const {page, card} = require('./helpers.cjs');

test('普通列表与校园卡片都能收集，按职位 ID 去重并保留链接参数', async () => {
  const p = page(card('a') + card('a', 'job-card-wrapper') + card('b', 'job-card-wrapper'));
  const r = await p.send({type: 'SCRAPE', count: 2});
  assert.equal(r.jobs.length, 2); assert.equal(r.jobs[1].company, '测试公司');
  assert.match(r.jobs[1].link, /securityId=fixture/); assert.equal(r.reason, 'target'); p.dom.window.close();
});
test('整页都在历史记录中仍翻页，下一页新岗位计入目标数量', async () => {
  const p = page(`<ul id="list">${card('old')}</ul><div class="options-pages"><button class="next">下一页</button></div>`);
  let clicks = 0;
  p.w.document.querySelector('button').onclick = () => { clicks++; p.w.document.querySelector('#list').innerHTML = card('new'); };
  const r = await p.send({type: 'SCRAPE', count: 1, excludeIds: ['old']});
  assert.equal(clicks, 1); assert.equal(r.jobs[0].id, 'new'); assert.equal(r.duplicates, 1); p.dom.window.close();
});
test('真实分页链接交给后台导航，不丢失已经收集的岗位', async () => {
  const p = page(card('a') + '<div class="options-pages"><a class="next" href="?page=2">下一页</a></div>');
  const r = await p.send({type: 'SCRAPE', count: 2});
  assert.equal(r.reason, 'next'); assert.match(r.nextUrl, /page=2/); assert.equal(r.jobs.length, 1); p.dom.window.close();
});
test('等待异步加载，而不是连续几个重复快照就结束', async () => {
  const p = page(card('old'));
  const base = p.w.setTimeout; let polls = 0;
  p.w.setTimeout = fn => base(() => {if (++polls === 12) p.w.document.body.innerHTML += card('slow'); fn();});
  const r = await p.send({type: 'SCRAPE', count: 1, excludeIds: ['old']});
  assert.equal(r.jobs[0].id, 'slow'); p.dom.window.close();
});
test('识别禁用的下一页；普通加载停滞不能误报末页', async () => {
  const p = page(card('a') + '<div class="options-pages"><button class="next" disabled>下一页</button></div>');
  const r = await p.send({type: 'SCRAPE', count: 2}); assert.equal(r.reason, 'end'); p.dom.window.close();
  const q = page(card('a')); const rr = await q.send({type: 'SCRAPE', count: 2}); assert.equal(rr.reason, 'stalled'); q.dom.window.close();
});
test('向真实滚动容器逐屏滚动，虚拟列表中的新岗位不会漏掉', async () => {
  const p = page(`<div id="scroller" style="overflow-y:auto">${card('old')}</div>`);
  const el = p.w.document.querySelector('#scroller'); let top = 0;
  Object.defineProperties(el, {scrollHeight: {value: 2000}, clientHeight: {value: 500}, scrollTop: {get: () => top, set: v => {top = v; if (top >= 400) el.innerHTML = card('next');}}});
  const r = await p.send({type: 'SCRAPE', count: 1, excludeIds: ['old']});
  assert.equal(r.jobs[0].id, 'next'); assert.equal(top, 400); p.dom.window.close();
});
test('停止收集会结束等待，重复注入不重建监听器', async () => {
  const p = page(card('a')); p.load('selectors.js'); p.load('content-search.js'); assert.equal(p.listeners.length, 1);
  const task = p.send({type: 'SCRAPE', count: 3}); await p.send({type: 'COLLECT_CONTROL', action: 'stop'});
  assert.equal((await task).reason, 'stopped'); p.dom.window.close();
});
test('验证页面单独报告，需要人工处理而非列表耗尽', async () => {
  const p = page('<div>请完成安全验证</div>');
  const r = await p.send({type: 'SCRAPE', count: 3}); assert.equal(r.reason, 'blocked'); assert.equal(r.jobs.length, 0); p.dom.window.close();
});
test('独立详情不需要原列表卡片，并拒绝错误岗位和相关推荐沟通按钮', async () => {
  const p = page('<div class="job-banner"><h1>校招岗位</h1></div><div class="job-sec-text">本科，应届生，前端开发</div><aside><button>立即沟通</button></aside>', 'https://www.zhipin.com/job_detail/target.html');
  assert.equal((await p.send({type: 'OPEN_JD', job: {id: 'target'}})).success, true);
  assert.equal((await p.send({type: 'OPEN_JD', job: {id: 'wrong'}})).success, false);
  assert.equal((await p.send({type: 'GO_CHAT', job: {id: 'target'}})).success, false); p.dom.window.close();
});
test('校园首页热门岗位读完后跟随查看更多进入应届生完整列表', async () => {
  const p = page(`<div class="school-tab-panel">${card('a', 'job-card-wrapper')}<a class="look-more-btn" href="/web/geek/job?experience=102">查看更多</a></div>`, 'https://www.zhipin.com/school/');
  const r = await p.send({type: 'SCRAPE', count: 20});
  assert.equal(r.reason, 'next'); assert.equal(new URL(r.nextUrl).searchParams.get('experience'), '102'); p.dom.window.close();
});
