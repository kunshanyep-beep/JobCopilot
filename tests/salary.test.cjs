const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {src, page, card, worker, job} = require('./helpers.cjs');
const ctx = vm.createContext({});
vm.runInContext(src('salary.js'), ctx);
const salary = ctx.BOSS_SALARY;
const monthly = salary.config({salaryPeriod: 'month', salaryMin: '15', salaryMax: '25', salaryUnknown: false});

test('解析月薪多薪、元和万元、日薪、年薪，不把多薪当作月薪金额', () => {
  for (const [label, period, min, max] of [
    ['10-20K·13薪', 'month', 10, 20], ['１５～２５Ｋ·１４薪', 'month', 15, 25],
    ['1.5-2.5万/月', 'month', 15, 25], ['15000-25000元/月', 'month', 15, 25],
    ['200-300元/天', 'day', 200, 300], ['200元/日', 'day', 200, 200],
    ['30-50万/年', 'year', 30, 50], ['300000元/年', 'year', 30, 30],
    ['20K以上', 'month', 20, Infinity], ['10K以下', 'month', 0, 10],
  ]) {
    const parsed = salary.parse(label);
    assert.ok(parsed, label); assert.equal(parsed.period, period, label);
    assert.equal(parsed.min, min, label); assert.equal(parsed.max, max, label);
  }
  for (const text of ['', '面议', '薪资保密', '300', '20-10K', '20K·股票']) assert.equal(salary.parse(text), null, text);
});
test('区间相交包括边界，支持单侧、不限、未知薪资策略，计薪方式不混算', () => {
  for (const text of ['10-15K', '25-30K', '20K', '10-30K']) assert.equal(salary.matches(text, monthly), true, text);
  for (const text of ['5-14K', '26-30K', '200-300元/天', '20万/年', '面议']) assert.equal(salary.matches(text, monthly), false, text);
  assert.equal(salary.matches('面议', salary.config({salaryPeriod: 'month'})), true);
  assert.equal(salary.matches('1K', salary.config({})), true);
  assert.equal(salary.matches('面议', salary.config({})), true);
  assert.equal(salary.matches('50K', salary.config({salaryPeriod: 'month', salaryMin: 15})), true);
  assert.equal(salary.matches('10K', salary.config({salaryPeriod: 'month', salaryMax: 15})), true);
  assert.equal(salary.matches('250元/天', salary.config({salaryPeriod: 'day', salaryMin: 200})), true);
  assert.equal(salary.matches('30-50万/年', salary.config({salaryPeriod: 'year', salaryMin: 40})), true);
});
test('校验错误范围、负数、无效数字，零有效，旧配置默认不限', () => {
  for (const bounds of [{salaryMin: -1}, {salaryMax: 'abc'}, {salaryMin: 30, salaryMax: 20}, {salaryMax: Infinity}]) {
    assert.throws(() => salary.config({salaryPeriod: 'month', ...bounds}), /薪资/);
  }
  assert.equal(salary.config({salaryPeriod: 'month', salaryMin: '0'}).min, 0);
  assert.equal(salary.config({}).period, '');
});
test('低薪整页继续翻页直到收满，过滤数按职位去重，目标只计算符合条件的岗位', async () => {
  const p = page(`<ul id="list">${card('low').replace('10-15K', '5-8K')}</ul><div class="options-pages"><button class="next">下一页</button></div>`);
  p.w.document.querySelector('button').onclick = () => { p.w.document.querySelector('#list').innerHTML = card('match').replace('10-15K', '15-20K'); };
  const r = await p.send({type: 'SCRAPE', count: 1, salaryFilter: monthly});
  assert.equal(r.reason, 'target'); assert.equal(r.jobs[0].id, 'match'); assert.equal(r.salarySkipped, 1);
  p.w.close();
});
test('后台传递薪资条件，过滤岗位不进入 AI 或历史；放宽范围后仍能收集', async () => {
  const w = worker({salaryPeriod: 'month', salaryMin: '15', salaryUnknown: false}, msg => {
    assert.equal(msg.salaryFilter.period, 'month');
    return {success: true, jobs: [{...job('low'), salary: '5-8K'}, {...job('high'), salary: '15-20K'}], reason: 'end', scanned: 2, duplicates: 0};
  });
  await w.run('runCollect()');
  assert.deepEqual([...w.data.collectedIds], ['high']);
  assert.deepEqual([...w.data.sw_screened].map(j => j.id), ['high']);
  w.data.salaryMin = '5';
  await w.run('runCollect()');
  assert.deepEqual([...w.data.sw_jobs].map(j => j.id), ['low']);
});
test('非法薪资配置在后台也会拒绝，不打开页面', async () => {
  const w = worker({salaryPeriod: 'day', salaryMin: '300', salaryMax: '200'});
  await assert.rejects(w.run('runCollect()'), /薪资下限/);
  assert.equal(w.calls.length, 0);
});

test('真实岗位薪资使用私有字体编码时，不得作为面议绕过 15K 下限', () => {
  const filter = salary.config({salaryPeriod: 'month', salaryMin: '15', salaryUnknown: true});
  // 当前 BOSS 卡片“用友BIP开发实习生”的原始薪资字符，不是 ASCII 数字。
  assert.equal(salary.matches('\ue034-\ue035K', filter), false);
});
test('BOSS 私有字体数字转为可读薪资，已存旧数据同样能判定区间', () => {
  assert.equal(salary.normalize('\ue035-\ue036K'), '4-5K');
  assert.equal(salary.normalize('\ue032\ue036-\ue033\ue031K·\ue032\ue034薪'), '15-20K·13薪');
  const f = salary.config({salaryPeriod: 'month', salaryMin: 15, salaryUnknown: true});
  assert.equal(salary.matches('\ue032\ue036-\ue033\ue031K·\ue032\ue034薪', f), true);
  assert.equal(salary.matches('3-4K（其他备注）', f), false);
  assert.equal(salary.matches('\ue123-\ue125K', f), false);
  assert.equal(salary.matches('', f), true);
  assert.equal(salary.matches('薪资面议', f), true);
});
test('投递旧审核列表也必须在导航和建联前排除低薪岗位', async () => {
  const w = worker({salaryPeriod:'month', salaryMin:15, salaryUnknown:true, sw_jobs:[{...job('low'),salary:'\ue034-\ue035K'}]});
  await w.run("runDeliver(['low'])");
  assert.equal(w.calls.some(c=>c.type==='create'||c.type==='update'||c.type==='GO_CHAT'||c.type==='SEND_ACTIVE'),false);
});
test('收集真实字体卡片时跳过 3–4K，15–20K 解码后才计入目标', async () => {
  const p=page(card('low').replace('10-15K','\ue034-\ue035K')+card('high').replace('10-15K','\ue032\ue036-\ue033\ue031K'));
  const r=await p.send({type:'SCRAPE',count:1,salaryFilter:salary.config({salaryPeriod:'month',salaryMin:15,salaryUnknown:true})});
  assert.equal(r.jobs.length,1); assert.equal(r.jobs[0].id,'high'); assert.equal(r.jobs[0].salary,'15-20K'); assert.equal(r.salarySkipped,1);
  p.w.close();
});
