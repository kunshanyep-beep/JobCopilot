const test = require('node:test');
const assert = require('node:assert/strict');
const {worker, job} = require('./helpers.cjs');
const response = jobs => ({success: true, jobs, reason: 'target', scanned: jobs.length, duplicates: 0});
test('搜索支持应届生、多个关键词和城市，不拆分 C/C++', () => {
  const w = worker();
  const result = w.run("searchPlan({keyword:'前端，C/C++，前端',city:'北京 / 上海',experience:'102',expandSearch:false})");
  assert.equal(result.length, 4);
  assert.equal(new URL(result[3].url).searchParams.get('query'), 'C/C++');
  assert.equal(new URL(result[3].url).searchParams.get('experience'), '102');
  assert.throws(() => w.run("searchPlan({keyword:'开发',city:'错误城市'})"), /暂不支持/);
});
test('跨次收集排除历史和已投，清空收集历史不影响已投记录', async () => {
  let round = 0;
  const w = worker({processed: {sent: 1}, expandSearch: false}, msg => {
    if (msg.type === 'SCRAPE') {
      assert.ok(msg.excludeIds.includes('sent'));
      if (round++) { assert.ok(msg.excludeIds.includes('a')); return response([job('b')]); }
      return response([job('a')]);
    }
  });
  await w.run('runCollect()'); await w.run('runCollect()');
  assert.deepEqual([...w.data.collectedIds], ['a', 'b']); assert.equal(w.data.sw_screened[0].id, 'b');
  await w.send({type: 'CLEAR_COLLECTED'}); assert.equal(w.data.collectedIds, undefined); assert.equal(w.data.processed.sent, 1);
});
test('取消历史排除仍跳过已投岗位；后台再次去重', async () => {
  const w = worker({excludeSeen: false, expandSearch: false, collectedIds: ['a'], processed: {sent: 1}}, msg => {
    if (msg.type === 'SCRAPE') {assert.equal(msg.excludeIds.includes('a'), false); return response([job('a'), job('a'), job('sent')]);}
  });
  await w.run('runCollect()'); assert.equal(w.data.sw_jobs.length, 1); assert.equal(w.data.sw_jobs[0].id, 'a');
});
test('当前校园页收集不要求关键词，不重定向用户页面', async () => {
  const w = worker({collectSource: 'current', keyword: ''}, () => response([job('a')]));
  w.tabs.set(42, {id: 42, url: 'https://www.zhipin.com/school/', status: 'complete'});
  await w.run('runCollect()');
  assert.equal(w.data.sw_jobs[0].id, 'a'); assert.equal(w.calls.some(c => c.type === 'create' || c.type === 'update'), false);
});
test('一个入口耗尽后继续其他关键词；分页导航保留前页岗位', async () => {
  const w = worker({keyword: '前端,软件', count: 3}, (msg, tab) => {
    if (msg.type !== 'SCRAPE') return {};
    const url = new URL(tab.url);
    if (url.searchParams.get('page') === '2') return {...response([job('b')]), reason: 'end'};
    if (url.searchParams.get('query') === '前端') return {...response([job('a')]), reason: 'next', nextUrl: tab.url + '&page=2'};
    return response([job('c')]);
  });
  await w.run('runCollect()'); assert.deepEqual([...w.data.sw_jobs].map(j => j.id), ['a', 'b', 'c']);
});
test('停止筛选不把未审核批次写成已见岗位', async () => {
  const w = worker({}, () => response([job('a')]));
  w.run("screenJob = async () => {state.aborted = true; return {match: true};}");
  await w.run('runCollect()'); assert.equal(w.data.collectedIds, undefined);
});
test('工作标签独立创建，重复使用不会刷新同一页面', async () => {
  const w = worker(); w.tabs.set(80, {id: 80, url: 'https://www.zhipin.com/web/geek/chat', status: 'complete'});
  await w.run("ensureTab('https://www.zhipin.com/web/geek/jobs')"); await w.run("ensureTab('https://www.zhipin.com/web/geek/jobs')");
  assert.equal(w.calls.filter(c => c.type === 'create').length, 1); assert.equal(w.calls.some(c => c.type === 'update'), false);
  assert.equal(w.tabs.get(80).url, 'https://www.zhipin.com/web/geek/chat');
});
test('投递直接访问第二页岗位详情；详情失败不生成沟通动作', async () => {
  const w = worker({sw_jobs: [job('second-page')]}, msg => msg.type === 'OPEN_JD' ? {success: false, error: '已关闭'} : {});
  await w.run("runDeliver(['second-page'])");
  assert.equal(w.calls.find(c => c.type === 'create').url, job('second-page').link);
  assert.equal(w.calls.some(c => c.type === 'GO_CHAT' || c.type === 'SEND_ACTIVE'), false);
});
test('站外链接或岗位 ID 不匹配时不导航', () => {
  const w = worker();
  assert.equal(w.run("jobDetailUrl({id:'a',link:'https://www.zhipin.com.evil.test/job_detail/a.html'})"), '');
  assert.equal(w.run("jobDetailUrl({id:'a',link:'https://www.zhipin.com/job_detail/b.html'})"), '');
});
test('后台重启后恢复上一次审核列表', async () => {
  const w = worker({sw_screened: [{...job('a'), match: true}]});
  const result = await w.send({type: 'GET_STATE'}); assert.equal(result.phase, 'review'); assert.equal(result.screened[0].id, 'a');
});
test('沟通动作返回通道错误时以真实导航确认，继续发送所选岗位会话', async () => {
  const w = worker({sw_jobs: [job('a')]}, (msg, tab) => {
    if (msg.type === 'OPEN_JD') return {success: true, jd: '本科，应届生'};
    if (msg.type === 'GO_CHAT') {tab.url = 'https://www.zhipin.com/web/geek/chat?jobId=a'; return {success: false, error: 'message port closed'};}
    if (msg.type === 'CHAT_STATUS') return {success: true, ready: true, mode: 'page'};
    if (msg.type === 'SEND_ACTIVE') return {success: true};
  });
  await w.run("runDeliver(['a','a'])");
  assert.equal(w.calls.filter(c => c.type === 'SEND_ACTIVE').length, 1); assert.equal(w.data.processed.a.text, true);
});
test('沟通失败没有进入聊天时不发送简历或招呼语', async () => {
  const w = worker({sw_jobs: [job('a')]}, msg => msg.type === 'OPEN_JD' ? {success: true, jd: '应届生'} : {success: false, error: '该岗位不可沟通'});
  await w.run("runDeliver(['a'])");
  assert.equal(w.calls.some(c => c.type === 'SEND_ACTIVE'), false); assert.equal(w.data.processed, undefined);
});

for (const stalledAt of ['headers', 'body']) {
  test('AI ' + stalledAt + ' 超时后整批进入待审核，不无限停在筛选中', async () => {
    const w = worker({expandSearch: false}, () => response([job('a'), job('b')]), {
      realAI: true,
      globals: {
        setTimeout: (fn, ms) => setTimeout(fn, ms === 25000 ? 5 : 0),
        fetch: async () => stalledAt === 'headers' ? new Promise(() => {}) : {ok: true, json: () => new Promise(() => {})}
      }
    });
    const result = await Promise.race([w.run('startRun(runCollect)').then(() => 'finished'), new Promise(r => setTimeout(() => r('stuck'), 100))]);
    assert.equal(result, 'finished');
    assert.equal(w.run('state.phase'), 'review');
    assert.equal(w.run('running'), false);
    assert.equal(w.data.sw_screened.length, 2);
    assert.match(w.data.sw_screened[0].reason, /超时/);
  });
}

test('停止时立即取消挂起的 AI 请求并解锁下一轮', async () => {
  let started;
  const ready = new Promise(r => {started = r;});
  let signal;
  const w = worker({expandSearch: false}, () => response([job('a')]), {
    realAI: true, globals: {fetch: async (_, opts) => {signal = opts.signal; started(); return new Promise(() => {});}, setTimeout, clearTimeout}
  });
  const run = w.run('startRun(runCollect)');
  await ready;
  await w.send({type: 'STOP'});
  const result = await Promise.race([run.then(() => 'stopped'), new Promise(r => setTimeout(() => r('stuck'), 100))]);
  assert.equal(result, 'stopped');
  assert.equal(signal.aborted, true);
  assert.equal(w.run('running'), false);
  assert.equal(w.data.collectedIds, undefined);
});

test('每个已完成筛选先落盘，后台重启可恢复部分结果并提示中断', async () => {
  const w = worker({expandSearch: false}, () => response([job('a'), job('b')]));
  let finishLast;
  w.context.lastJob = new Promise(r => {finishLast = r;});
  w.run("screenJob = async (cfg, job) => job.id === 'b' ? lastJob : {match: true, reason: '测试匹配'}");
  const run = w.run('runCollect()');
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  try {
    assert.equal(w.data.sw_screened?.length, 1);
    const restarted = worker({...w.data});
    const restored = await restarted.send({type: 'GET_STATE'});
    assert.equal(restored.phase, 'review');
    assert.equal(restored.screened[0].id, 'a');
    assert.match(restored.notice, /中断/);
    assert.equal(w.data.collectedIds, undefined);
  } finally {finishLast({match: true}); await run;}
});

test('恢复旧版抢救结果时总数未知也能显示清楚的中断提示', async () => {
  const w = worker({sw_screened: [{...job('a'), match:true}], sw_screening: {completed:1}});
  const saved = await w.send({type:'GET_STATE'});
  assert.match(saved.notice, /已恢复 1 个结果/);
});

test('网站权限被关闭时启动立即报错，不进入无限等待的脚本注入', async () => {
  const w = worker();
  w.context.chrome.permissions = {contains: async () => false};
  w.context.chrome.scripting.executeScript = () => new Promise(() => {});
  const verdict = await Promise.race([w.run('startRun(runCollect)').then(() => 'finished'), new Promise(r => setTimeout(() => r('stuck'), 100))]);
  assert.equal(verdict, 'finished');
  assert.equal(w.run('running'), false);
  assert.equal(w.calls.some(c => c.type === 'create'), false);
  assert.ok(w.messages.some(m => m.type === 'LOG' && /网站访问权限/.test(m.text)));
});

test('页面脚本注入不返回也会超时退出收集', async () => {
  const w = worker({}, undefined, {globals: {setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? 5 : 0)}});
  w.context.chrome.scripting.executeScript = () => new Promise(() => {});
  const verdict = await Promise.race([w.run('startRun(runCollect)').then(() => 'finished'), new Promise(r => setTimeout(() => r('stuck'), 100))]);
  assert.equal(verdict, 'finished');
  assert.equal(w.run('running'), false);
  assert.ok(w.messages.some(m => m.type === 'LOG' && /页面脚本.*超时/.test(m.text)));
});

test('脚本注入挂起时停止立即解锁，迟到的注入完成不继续收集', async () => {
  const w = worker({}, undefined, {globals: {setTimeout, clearTimeout}});
  let entered, complete;
  const ready = new Promise(r => {entered = r;});
  w.context.chrome.scripting.executeScript = () => {entered(); return new Promise(r => {complete = r;});};
  const run = w.run('startRun(runCollect)');
  await ready;
  await w.send({type: 'STOP'});
  const verdict = await Promise.race([run.then(() => 'stopped'), new Promise(r => setTimeout(() => r('stuck'), 100))]);
  assert.equal(verdict, 'stopped');
  assert.equal(w.run('running'), false);
  complete([]);
  await new Promise(r => setImmediate(r));
  assert.equal(w.calls.some(c => c.type === 'SCRAPE'), false);
});

test('缺少权限时保留已恢复的审核结果', async () => {
  const w = worker({sw_screened: [{...job('a'), match:true}]});
  await w.send({type:'GET_STATE'});
  w.context.chrome.permissions.contains = async () => false;
  await w.run('startRun(runCollect)');
  const saved = await w.send({type:'GET_STATE'});
  assert.equal(saved.phase, 'review');
  assert.equal(saved.screened[0].id, 'a');
  assert.ok(w.messages.some(m => m.type === 'SCREENED' && m.screened[0].id === 'a'));
});
