const test = require('node:test');
const assert = require('node:assert/strict');
const {worker, job} = require('./helpers.cjs');
const empty = (reason = 'stalled') => ({success: true, jobs: [], reason, scanned: 116, duplicates: 116});
const found = id => ({success: true, jobs: [job(id)], reason: 'target', scanned: 1});

test('116 个结果全重复或低薪后，自动换搜索入口寻找新岗位', async () => {
  const w = worker({keyword: 'agent智能体AI开发', city: '全国', count: 1, experience: '102',
    salaryPeriod: 'month', salaryMin: '15', expandSearch: true}, (msg, tab) => {
    if (msg.type !== 'SCRAPE') return {};
    const url = new URL(tab.url);
    assert.equal(url.searchParams.get('experience'), '102');
    assert.equal(msg.salaryFilter.min, 15);
    if (url.searchParams.get('query') === 'agent智能体AI开发') {
      return {success: true, jobs: [], reason: 'stalled', scanned: 116, duplicates: 92, salarySkipped: 24};
    }
    return {success: true, jobs: [{...job('new'), salary: '20-30K'}], reason: 'target', scanned: 1};
  });
  await w.run('runCollect()');
  assert.equal(w.data.sw_jobs?.[0]?.id, 'new', '原入口停滞后仍应继续寻找新岗位');
});

test('默认扩展，原词优先且 URL 去重，具体城市不擅自扩大', () => {
  const w = worker();
  const plan = w.run("searchPlan({keyword:'agent智能体AI开发，AI Agent',city:'上海，北京市',experience:'102'})");
  assert.equal(plan[0].keyword, 'agent智能体AI开发');
  assert.equal(plan[3].keyword, 'AI Agent');
  assert.ok(plan.some(s => s.keyword === '智能体开发'));
  assert.equal(new Set(plan.map(s => s.url)).size, plan.length);
  for (const s of plan) {
    const u = new URL(s.url);
    assert.ok(['101010100', '101020100'].includes(u.searchParams.get('city')));
    assert.equal(u.searchParams.get('experience'), '102');
  }
  const exact = w.run("searchPlan({keyword:'C/C++',city:'北京',expandSearch:false})");
  assert.equal(exact.length, 1); assert.equal(exact[0].keyword, 'C/C++');
});

test('全国单词没有相关词时也按城市寻找，保留原词', async () => {
  const w = worker({keyword: '编译器', city: '全国', count: 1}, (msg, tab) => {
    if (msg.type !== 'SCRAPE') return {};
    const url = new URL(tab.url);
    assert.equal(url.searchParams.get('query'), '编译器');
    return url.searchParams.get('city') === '100010000' ? empty('end') : found('city-job');
  });
  await w.run('runCollect()');
  assert.equal(w.data.sw_jobs[0].id, 'city-job');
});

test('每轮入口预算结束持久化位置，后台重启也从剩余入口继续', async () => {
  const w = worker({keyword:'智能体开发',city:'全国'}, msg => msg.type === 'SCRAPE' ? empty() : {});
  await w.run('runCollect()');
  const firstUrls = w.calls.filter(c => c.type === 'create' || c.type === 'update').map(c => c.url);
  assert.equal(firstUrls.length, 12);
  assert.equal(w.data.searchProgress.index, 12);
  const restarted = worker(w.data, msg => msg.type === 'SCRAPE' ? found('fresh') : {});
  restarted.data.count = 1;
  await restarted.run('runCollect()');
  const url = restarted.calls.find(c => c.type === 'create').url;
  assert.equal(firstUrls.includes(url), false);
  assert.equal(restarted.data.sw_jobs[0].id, 'fresh');
});

test('分页预算后记录真正的下一页，不重新回第一页', async () => {
  const w = worker({keyword:'编译器',city:'北京',expandSearch:false,count:1}, (msg, tab) => {
    if (msg.type !== 'SCRAPE') return {};
    const next = new URL(tab.url);
    const page = Number(next.searchParams.get('page') || 1);
    if (page >= 31) return found('page31');
    next.searchParams.set('page', page + 1);
    return {...empty('next'), nextUrl: next.href};
  });
  await w.run('runCollect()');
  assert.equal(new URL(w.data.searchProgress.url).searchParams.get('page'), '31');
  const before = w.calls.length;
  await w.run('runCollect()');
  assert.equal(w.data.sw_jobs[0].id, 'page31');
  assert.equal(w.calls.slice(before).some(c => c.type === 'update'), false);
});

test('目标在第二页达到后下轮从第二页继续，历史和已投仍排除', async () => {
  const w = worker({keyword:'编译器',city:'北京',expandSearch:false,count:1,processed:{sent:1}}, (msg, tab) => {
    if (msg.type !== 'SCRAPE') return {};
    assert.ok(msg.excludeIds.includes('sent'));
    const url = new URL(tab.url);
    if (!url.searchParams.has('page')) {url.searchParams.set('page', '2'); return {...empty('next'),nextUrl:url.href};}
    return found(msg.excludeIds.includes('first') ? 'second' : 'first');
  });
  await w.run('runCollect()');
  const before = w.calls.length;
  await w.run('runCollect()');
  assert.equal(w.calls.slice(before).some(c => c.type === 'update'), false);
  assert.equal(w.data.sw_jobs[0].id, 'second');
});

test('修改薪资条件从原入口重新搜索；重置进度不清除去重记录', async () => {
  const w = worker({keyword:'智能体',city:'全国',collectedIds:['seen'],processed:{sent:1}}, msg => msg.type === 'SCRAPE' ? empty() : {});
  await w.run('runCollect()'); assert.equal(w.data.searchProgress.index, 12);
  w.data.salaryPeriod = 'month'; w.data.salaryMin = '15';
  const before = w.calls.length;
  await w.run('runCollect()');
  const url = w.calls.slice(before).find(c => c.type === 'update').url;
  assert.equal(new URL(url).searchParams.get('city'), '100010000');
  assert.equal(new URL(url).searchParams.get('query'), '智能体');
  await w.send({type:'RESET_SEARCH'});
  assert.equal(w.data.searchProgress, undefined);
  assert.deepEqual(w.data.collectedIds, ['seen']); assert.equal(w.data.processed.sent, 1);
  await w.send({type:'CLEAR_COLLECTED'}); assert.equal(w.data.searchProgress, undefined);
});

test('出现验证即停止整个搜索计划，不通过切换入口继续访问', async () => {
  const w = worker({keyword:'智能体',city:'全国'}, msg => msg.type === 'SCRAPE' ? empty('blocked') : {});
  await w.run('runCollect()');
  assert.equal(w.calls.filter(c => c.type === 'create' || c.type === 'update').length, 1);
  assert.equal(w.data.searchProgress.index, 0);
});

test('当前页模式不扩展，不改写搜索进度', async () => {
  const previous = {key:'previous',index:10,url:''};
  const w = worker({collectSource:'current',expandSearch:true,searchProgress:previous}, msg => msg.type === 'SCRAPE' ? empty() : {});
  w.tabs.set(42,{id:42,url:'https://www.zhipin.com/school/',status:'complete'});
  await w.run('runCollect()');
  assert.equal(w.calls.some(c => c.type === 'create' || c.type === 'update'), false);
  assert.deepEqual(w.data.searchProgress, previous);
});

test('筛选中停止时进度与历史一起不提交，避免吞掉尚未审核岗位', async () => {
  const w = worker({keyword:'智能体',city:'全国',count:1}, msg => msg.type === 'SCRAPE' ? found('new') : {});
  w.run('screenJob = async () => {state.aborted=true; return {match:true};}');
  await w.run('runCollect()');
  assert.equal(w.data.searchProgress, undefined); assert.equal(w.data.collectedIds, undefined);
});

test('多个入口返回相同岗位仍去重；原入口达到扫描预算后切换', async () => {
  let calls = 0;
  const w = worker({keyword:'智能体',city:'上海',count:2,collectedIds:['old'],processed:{sent:1}}, msg => {
    if (msg.type !== 'SCRAPE') return {};
    calls++;
    if (calls === 1) return {...empty('limit'),jobs:[job('first')]};
    assert.ok(msg.excludeIds.includes('first'));
    return {...found('second'),jobs:[job('first'),job('old'),job('sent'),job('second')]};
  });
  await w.run('runCollect()');
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(w.data.sw_jobs, j => j.id), ['first','second']);
});

test('关闭扩展只搜配置入口；所有入口耗尽后有界结束', async () => {
  const w = worker({keyword:'前端,后端',city:'北京',expandSearch:false}, msg => msg.type === 'SCRAPE' ? empty('end') : {});
  await w.run('runCollect()');
  assert.equal(w.calls.filter(c => c.type === 'create' || c.type === 'update').length, 2);
  assert.equal(w.data.searchProgress.index, 0);
  assert.ok(w.messages.some(m => /已检查本计划所有/.test(m.text || '')));
});

test('恢复地址必须是相同查询的站内列表，不跟随被篡改的 URL', () => {
  const w = worker();
  const base = 'https://www.zhipin.com/web/geek/jobs?query=AI&city=100010000&experience=102';
  const source = JSON.stringify({url:base});
  for (const url of ['https://evil.test/', base.replace('query=AI','query=销售'), base.replace('experience=102','experience=108')]) {
    assert.equal(w.run(`searchResumeUrl(${source}, ${JSON.stringify(url)})`), base);
  }
  assert.equal(w.run(`searchResumeUrl(${source}, ${JSON.stringify(base+'&page=2')})`),base+'&page=2');
});
