// ===== BOSS自动投递 Service Worker：编排 收集→筛选→审核→投递 + DeepSeek =====
importScripts('/src/selectors.js', '/src/salary.js'); // 让 SW 也能用 CITY_MAP（否则城市永远是全国）
const DS_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const DS_MODEL = 'deepseek-chat';
// 必须早于 Chrome 的 30 秒 fetch 等待上限结束请求（包括响应体）。
const AI_TIMEOUT_MS = 25000;
const pendingAI = new Set();
const pendingPageSteps = new Set();

let workTabId = null;
let collectTabId = null;
let running = false;

let state = {
  phase: 'idle', paused: false, aborted: false,
  jobs: [], screened: [], greetings: {}, results: [], processed: {}
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// ── 小工具 ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(a + Math.random() * (b - a));
function log(text, level) { chrome.runtime.sendMessage({ type: 'LOG', text: text, level: level || 'info' }).catch(() => {}); }
function pushPhase() { chrome.runtime.sendMessage({ type: 'PHASE', phase: state.phase }).catch(() => {}); }
function progress(cur, total, label) { chrome.runtime.sendMessage({ type: 'PROGRESS', cur: cur, total: total, label: label || '' }).catch(() => {}); }
async function waitIfPaused() { while (state.paused && !state.aborted) await sleep(400); }
function getCfg() { return chrome.storage.local.get(['dsKey', 'resumeText', 'resumeImage', 'city', 'keyword', 'count', 'experience', 'collectSource', 'excludeSeen', 'expandSearch', 'salaryPeriod', 'salaryMin', 'salaryMax', 'salaryUnknown']); }
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
function jobInfo(j) { return '岗位：' + (j.name || '') + '\n技能标签：' + ((j.tags || []).join('、')) + '\n薪资：' + (j.salary || '') + '\n公司：' + (j.company || ''); }
function findJob(id) { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === id) return state.jobs[i]; return null; }

// ── DeepSeek ──
async function callDS(messages, maxTokens) {
  const cfg = await getCfg();
  if (!cfg.dsKey) throw new Error('未配置DeepSeek API Key');
  if (state.aborted) throw new Error('已停止');
  const controller = new AbortController();
  let cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = error => { controller.abort(); reject(error); };
  });
  pendingAI.add(cancel);
  const timer = setTimeout(() => cancel(new Error('DeepSeek 请求超时（25 秒），可稍后重试或人工审核')), AI_TIMEOUT_MS);
  try {
    return await Promise.race([cancelled, (async () => {
      const resp = await fetch(DS_ENDPOINT, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.dsKey },
        body: JSON.stringify({ model: DS_MODEL, messages, max_tokens: maxTokens || 500, temperature: 0.5 })
      });
      if (!resp.ok) throw new Error('DeepSeek 请求失败（HTTP ' + resp.status + '）');
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    })()]);
  } finally {
    clearTimeout(timer);
    pendingAI.delete(cancel);
  }
}

// 筛选：只判断是否值得投（用岗位标签快速判断，不生成招呼语）
async function screenJob(cfg, job) {
  const sys = '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·适中】保留(match=true)：岗位方向与求职者简历的专业/技能/经历相关，且求职者的经验年限、学历、级别够得着该岗位（不超纲）。剔除(match=false)：方向与简历明显无关；岗位要求的经验/学历/硬技能明显超出简历；岗位级别明显高于求职者当前水平。请依据简历本身判断，不要套用任何固定行业或级别。校招、应届生、在校生、实习、经验不限岗位不得仅因缺少全职工作年限而剔除；相关课程、项目和实习都可作为能力证据。只有明确的毕业届别、学历、专业等硬性要求与简历冲突时才据此剔除；信息不足请在理由中提示人工核对，不要推断不符合。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"reason":"一句话理由"}';
  const user = '求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  const raw = await callDS([{ role: 'system', content: sys }, { role: 'user', content: user }], 200);
  let p = null;
  try { p = JSON.parse(raw); } catch (e) { const m = raw && raw.match(/\{[\s\S]*\}/); if (m) { try { p = JSON.parse(m[0]); } catch (e2) {} } }
  if (!p) return { match: false, reason: 'AI解析失败' };
  return { match: p.match === true, reason: p.reason || '' };
}

// 投递时：结合该岗位的【完整JD】+ 简历，现场生成专属招呼语
async function genGreetingFromJD(cfg, job, jd) {
  const sys = '你是求职者本人，在BOSS直聘给HR发招呼语。回复会原样发给HR，严禁任何注释、说明、括号备注、字数统计或引导语。\n【格式】1.开头前15字必须是"熟悉XXX、XXX"(填该JD要求且你简历具备的核心技能1-2个)。2.紧接"做过XXX"说明简历里与该岗位相关的具体项目/经历。3.全文80-120字，真诚自然。';
  const jdText = (jd && jd.trim()) ? jd.trim() : ('技能标签：' + (job.tags || []).join('、'));
  const user = '我的简历：\n' + resumeFull(cfg) + '\n\n目标岗位：' + (job.name || '') + (job.company ? ('（' + job.company + '）') : '') + '\n该岗位JD：\n' + jdText + '\n\n请按格式生成一段招呼语，开头必须"熟悉…"，直接输出招呼语本身，不要任何多余内容。';
  const raw = await callDS([{ role: 'system', content: sys }, { role: 'user', content: user }], 300);
  return (raw || '').trim();
}

// ── tab 注入 + 发消息 ──
async function requireSiteAccess() {
  const sites = [
    {name: 'BOSS直聘', origin: '*://*.zhipin.com/*'},
    {name: 'DeepSeek', origin: 'https://api.deepseek.com/*'}
  ];
  const granted = await Promise.all(sites.map(site => chrome.permissions.contains({origins: [site.origin]})));
  const missing = sites.filter((_, i) => !granted[i]).map(site => site.name);
  if (missing.length) throw new Error('缺少网站访问权限：' + missing.join('、') + '。请在 Chrome 扩展程序 → JobCopilot → 详情 → 有权访问的网站中允许访问，然后重新开始。');
}
async function ensureInjected(tabId, file) {
  if (state.aborted) throw new Error('已停止');
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  pendingPageSteps.add(cancel);
  const timer = setTimeout(() => cancel(new Error('页面脚本加载超时，请检查 JobCopilot 的 BOSS 网站访问权限后重试')), 10000);
  try {
    await Promise.race([cancelled, chrome.scripting.executeScript({
      target: {tabId}, files: ['src/selectors.js', 'src/chat-ui.js', 'src/salary.js', file]
    })]);
  } finally {
    clearTimeout(timer);
    pendingPageSteps.delete(cancel);
  }
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'no response' });
    });
  });
}
async function waitTabComplete(tabId, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (state.aborted) throw new Error('已停止');
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(250);
  }
  throw new Error('页面加载超时，请检查网络或登录状态');
}
function resolveCity(cfg) {
  const name = (cfg.city || '全国').trim().replace(/[市省]$/, '');
  const code = CITY_MAP[name];
  if (!code) throw new Error('暂不支持城市“' + name + '”，请填写城市名或“全国”');
  return { name, code };
}
function buildSearchUrl(cfg) {
  const params = new URLSearchParams({ query: (cfg.keyword || '').trim(), city: resolveCity(cfg).code });
  // 2026-10-27 核对 BOSS 官方 condition.json：102 应届生、108 在校生、101 经验不限。
  if (['102', '108', '101'].includes(cfg.experience)) params.set('experience', cfg.experience);
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
}
function searchPlan(cfg) {
  const split = value => [...new Set(value.split(/[,，、;；\n]+/).map(s => s.trim()).filter(Boolean))];
  const keywords = split(cfg.keyword || '');
  const cities = split((cfg.city || '全国').replace(/\//g, ','));
  if (!keywords.length) throw new Error('请先填写岗位关键词');
  if (keywords.length * cities.length > 20) throw new Error('关键词与城市组合请控制在 20 组以内');
  const sources = [], seen = new Set();
  const add = (keyword, city) => {
    const url = buildSearchUrl({ ...cfg, keyword, city });
    if (!seen.has(url)) { seen.add(url); sources.push({ keyword, city, url }); }
  };
  keywords.forEach(keyword => cities.forEach(city => add(keyword, city)));
  if (cfg.expandSearch === false) return sources;
  // 有限的相关词，不把任意长句拆成宽泛单字，也不依赖额外 AI 请求。
  const related = [...new Set(keywords.flatMap(relatedKeywords))];
  related.forEach(keyword => cities.forEach(city => add(keyword, city)));
  if (cities.some(city => resolveCity({city}).name === '全国')) {
    // 全国列表也可能只展示有限结果；城市仍在用户选择的全国范围内。
    const allKeywords = [...new Set([...keywords, ...related])];
    Object.keys(CITY_MAP).filter(city => city !== '全国').forEach(city => allKeywords.forEach(keyword => add(keyword, city)));
  }
  return sources;
}
function relatedKeywords(keyword) {
  const groups = [
    [/agent|智能体/i, ['AI Agent', '智能体开发', '大模型应用开发', 'LLM应用开发']],
    [/大模型|LLM|RAG|AI.*开发|人工智能.*开发/i, ['大模型应用开发', 'AI应用开发', 'RAG开发']],
    [/前端|web开发|frontend/i, ['前端开发', 'Web前端', '前端工程师']],
    [/后端|backend/i, ['后端开发', '服务端开发']],
    [/测试开发|测开/i, ['测试开发', '自动化测试']],
  ];
  return [...new Set(groups.filter(([pattern]) => pattern.test(keyword)).flatMap(([, words]) => words))].slice(0, 6);
}
function searchResumeUrl(source, url) {
  try {
    const next = new URL(url), base = new URL(source.url);
    if (next.origin !== base.origin || !/^\/web\/geek\/jobs?$/.test(next.pathname)) return source.url;
    // 只恢复相同筛选条件的分页，不信任存储里指向其他查询的 URL。
    for (const key of ['query', 'city', 'experience']) if (next.searchParams.get(key) !== base.searchParams.get(key)) return source.url;
    return next.href;
  } catch (e) { return source.url; }
}
function jobDetailUrl(job) {
  try {
    const url = new URL(job.link);
    if (!['https:', 'http:'].includes(url.protocol) || !/(^|\.)zhipin\.com$/.test(url.hostname)) return '';
    const m = url.pathname.match(/^\/job_detail\/([^/]+)\.html$/);
    return m && m[1] === job.id ? url.href : '';
  } catch (e) { return ''; }
}
async function ensureTab(url) {
  // 只复用插件创建的工作标签，保留用户已有页面和未提交输入。
  if (workTabId === null) {
    const saved = await chrome.storage.session.get('workTabId');
    workTabId = saved.workTabId ?? null;
  }
  let tab;
  if (workTabId !== null) {
    try { tab = await chrome.tabs.get(workTabId); } catch (e) { workTabId = null; }
    if (tab && !/^https?:\/\/([^/]+\.)?zhipin\.com\//.test(tab.url || '')) tab = null;
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url });
    workTabId = tab.id;
    await chrome.storage.session.set({ workTabId });
  } else if (tab.url !== url) {
    await chrome.tabs.update(tab.id, { url });
  }
  await waitTabComplete(tab.id);
  return chrome.tabs.get(tab.id);
}
async function waitForChat(tabId, job) {
  const until = Date.now() + 15000;
  let injectedUrl = '';
  while (Date.now() < until && !state.aborted) {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url);
    if (!/(^|\.)zhipin\.com$/.test(url.hostname)) return null;
    const onChat = /^\/web\/geek\/chat(?:\/|$)/.test(url.pathname);
    const onDetail = url.href === jobDetailUrl(job) || url.pathname === new URL(jobDetailUrl(job)).pathname;
    if (tab.status === 'complete' && (onChat || onDetail)) {
      if (injectedUrl !== tab.url) {
        await ensureInjected(tabId, 'src/content-chat.js');
        injectedUrl = tab.url;
      }
      const ready = await sendToTab(tabId, { type: 'CHAT_STATUS', job });
      if (ready && ready.ready) return ready;
    }
    await sleep(300);
  }
  return null;
}
function controlCollection(action) {
  if (collectTabId !== null) sendToTab(collectTabId, { type: 'COLLECT_CONTROL', action });
}

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false;
  await requireSiteAccess();
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; state.notice = '';
  state.phase = 'collecting'; pushPhase();
  const cfg = await getCfg();
  if (!cfg.dsKey) { log('请先填写 DeepSeek API Key', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!(cfg.resumeText || '').trim()) { log('请先在设置里填写“简历文字”', 'error'); state.phase = 'idle'; pushPhase(); return; }
  const salaryFilter = BOSS_SALARY.config(cfg);
  log('薪资筛选：' + BOSS_SALARY.describe(salaryFilter));
  const count = Math.max(1, Math.min(200, parseInt(cfg.count) || 20));
  const saved = await chrome.storage.local.get(['collectedIds', 'processed', 'searchProgress']);
  state.processed = saved.processed || {};
  const history = new Set(saved.collectedIds || []);
  const excluded = new Set(Object.keys(state.processed));
  if (cfg.excludeSeen !== false) history.forEach(id => excluded.add(id));
  const picked = new Set();
  let sources;
  if (cfg.collectSource === 'current') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !/^https?:\/\/([^/]+\.)?zhipin\.com\/(web\/geek\/jobs?(?:[?#]|$)|school(?:[/?#]|$))/.test(tab.url || '')) {
      throw new Error('请先切到 BOSS 的职位列表或校园页面，再从当前页收集');
    }
    sources = [{ tab, url: tab.url, keyword: '当前页面', city: '' }];
  } else sources = searchPlan(cfg);
  const searchMode = cfg.collectSource !== 'current';
  const planKey = JSON.stringify([1, cfg.keyword, cfg.city || '全国', cfg.experience || '', cfg.expandSearch !== false, cfg.excludeSeen !== false, salaryFilter]);
  const previous = searchMode && cfg.excludeSeen !== false && saved.searchProgress?.key === planKey ? saved.searchProgress : null;
  let cursor = previous && Number.isInteger(previous.index) && previous.index >= 0 && previous.index < sources.length ? previous.index : 0;
  let resumeUrl = previous && cursor === previous.index ? previous.url : '';
  let checkpoint = {key: planKey, index: cursor, url: resumeUrl};
  const persistProgress = async () => {
    if (searchMode) await chrome.storage.local.set({searchProgress: checkpoint});
  };
  log('收集目标：' + count + ' 个新岗位，搜索入口 ' + sources.length + ' 个');
  if (searchMode && cfg.expandSearch !== false) log('自动扩展已开启：原词优先，其后使用相关词；全国范围会按城市分别搜索');
  if (previous) log('接续上次搜索进度：入口 ' + (cursor + 1) + '/' + sources.length);
  const stops = { target: '已达到收集目标', end: '已到当前列表末尾', stalled: '当前入口列表未继续加载', limit: '当前入口达到扫描预算', blocked: '页面要求人工处理', stopped: '已停止' };
  let blocked = false;
  let attempted = 0, batchLimited = false;
  // 每轮最多 12 个入口；把剩余进度存盘，避免扩大范围后一次运行无休止。
  for (; attempted < Math.min(sources.length, 12); attempted++) {
    if (state.aborted || blocked || state.jobs.length >= count) break;
    await waitIfPaused();
    if (state.aborted) break;
    const source = sources[cursor];
    log('搜索 [' + (cursor + 1) + '/' + sources.length + ']：' + source.keyword + (source.city ? ' | ' + source.city : ''));
    if (attempted) { await rand(1200, 2200); await waitIfPaused(); if (state.aborted) break; }
    let tab = source.tab || await ensureTab(searchResumeUrl(source, resumeUrl));
    checkpoint = {key: planKey, index: cursor, url: tab.url};
    let retrySource = false;
    const visited = new Set();
    for (let page = 0; page < 30 && state.jobs.length < count && !state.aborted; page++) {
      if (visited.has(tab.url)) { log('检测到重复分页，停止当前入口', 'warn'); break; }
      visited.add(tab.url);
      collectTabId = tab.id;
      await ensureInjected(tab.id, 'src/content-search.js');
      const r = await sendToTab(tab.id, { type: 'SCRAPE', salaryFilter, count: count - state.jobs.length, excludeIds: [...excluded, ...picked] });
      if (!r || !r.success) { log('收集失败：' + (r && r.error), 'error'); retrySource = true; break; }
      for (const job of r.jobs || []) {
        if (state.jobs.length < count && BOSS_SALARY.matches(job.salary, salaryFilter) && jobDetailUrl(job) && !picked.has(job.id) && !excluded.has(job.id)) {
          state.jobs.push(job); picked.add(job.id); history.add(job.id);
        }
      }
      // 在筛选完成进入审核后才记入历史；中途停止不能吞掉这批岗位。
      progress(state.jobs.length, count, '新岗位');
      log('本页扫描 ' + r.scanned + ' 个，跳过重复 ' + r.duplicates + ' 个，薪资排除 ' + (r.salarySkipped || 0) + ' 个，累计新增 ' + state.jobs.length + ' 个');
      if (r.reason === 'blocked') blocked = true;
      checkpoint.url = searchResumeUrl(source, (await chrome.tabs.get(tab.id)).url);
      if (r.reason !== 'next') { log(stops[r.reason] || r.reason, ['stalled', 'limit', 'blocked'].includes(r.reason) ? 'warn' : 'info'); if (r.detail) log(r.detail, 'warn'); break; }
      if (state.jobs.length >= count) break;
      if (state.aborted) break;
      await waitIfPaused();
      if (state.aborted) break;
      const next = new URL(r.nextUrl);
      const origin = new URL(source.url).origin;
      if (next.origin !== origin || !/^\/web\/geek\/jobs?$/.test(next.pathname)) throw new Error('分页链接不是 BOSS 职位列表');
      await chrome.tabs.update(tab.id, { url: next.href });
      await waitTabComplete(tab.id);
      tab = { id: tab.id, url: next.href };
      checkpoint.url = next.href;
      if (page === 29) { batchLimited = true; log('本轮分页预算已用完，将保存下一页地址供下次继续', 'warn'); }
    }
    collectTabId = null;
    if (state.jobs.length >= count || blocked || state.aborted || batchLimited || retrySource) break;
    cursor = (cursor + 1) % sources.length;
    resumeUrl = '';
    checkpoint = {key: planKey, index: cursor, url: ''};
    if (attempted + 1 < Math.min(sources.length, 12)) log('数量不足，继续下一个搜索入口');
  }
  if (state.aborted) return;
  if (attempted === 12 && sources.length > 12) log('本轮已搜索 12 个入口，剩余入口进度将保存；再次收集会从入口 ' + (cursor + 1) + ' 继续', 'warn');
  else if (attempted === sources.length) log('已检查本计划所有搜索入口；本轮结果可能少于目标数量', 'warn');
  log('收集到 ' + state.jobs.length + ' 个新岗位', state.jobs.length ? 'success' : 'warn');
  if (!state.jobs.length) { await persistProgress(); log(blocked ? '请先在 BOSS 页面处理验证或登录，再继续收集。' : (searchMode ? '本轮没有符合当前条件的新岗位。搜索进度已保存；可继续收集或调整关键词、城市、薪资条件。' : '当前页面没有符合条件的新岗位；可改为关键词搜索并开启自动扩展。'), 'warn'); state.phase = 'idle'; pushPhase(); return; }

  // 筛选（并发3）
  state.phase = 'screening'; pushPhase();
  log('AI 筛选中（DeepSeek）...');
  let done = 0; const total = state.jobs.length;
  progress(0, total, '筛选');
  // 保存当前批次，避免后台重启后误显示上一轮结果。每个完成项串行落盘。
  let checkpointWrites = Promise.resolve();
  const saveScreening = () => {
    const snapshot = {sw_jobs: [...state.jobs], sw_screened: [...state.screened], sw_greetings: {},
      sw_screening: {total, completed: state.screened.length}};
    checkpointWrites = checkpointWrites.then(() => chrome.storage.local.set(snapshot));
    return checkpointWrites;
  };
  await saveScreening();
  const CONC = 3;
  for (let i = 0; i < state.jobs.length; i += CONC) {
    if (state.aborted) break; await waitIfPaused(); if (state.aborted) break;
    const batch = state.jobs.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      let res;
      try { res = await screenJob(cfg, job); }
      catch (e) { res = { match: false, reason: '筛选异常:' + e.message }; }
      if (state.aborted) return;
      state.screened.push(Object.assign({}, job, { match: res.match, reason: res.reason }));
      await saveScreening();
      chrome.runtime.sendMessage({type: 'SCREENED', screened: state.screened}).catch(() => {});
      done++; progress(done, total, '筛选');
    }));
  }
  if (state.aborted) return;
  const matched = state.screened.filter(j => j.match).length;
  log('筛选完成：匹配 ' + matched + ' / ' + total, 'success');
  // 存盘：SW 可能在审核期间被浏览器回收，投递时需从存储读回
  await chrome.storage.local.set({ collectedIds: [...history], sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened, sw_screening: null,
    ...(searchMode ? {searchProgress: checkpoint} : {}) });
  state.phase = 'review'; pushPhase();
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}

// ── 流程：投递（单个闭环：打开目标详情→建联→进聊天页→发图片+招呼语→下一个）──
async function runDeliver(jobIds) {
  state.aborted = false; state.paused = false;
  await requireSiteAccess();
  state.results = [];
  state.phase = 'delivering'; pushPhase();
  // SW 可能在审核期间被回收，内存丢了就从存储读回
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  const cfg = await getCfg();
  const savedProcessed = await chrome.storage.local.get('processed');
  state.processed = savedProcessed.processed || {};
  if (!cfg.resumeImage) log('未上传简历图片，将只发招呼语', 'warn');

  const ids = [...new Set(jobIds || [])].filter(id => !state.processed[id]);
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }

  for (let k = 0; k < ids.length; k++) {
    if (state.aborted) break; await waitIfPaused(); if (state.aborted) break;
    const job = findJob(ids[k]);
    if (!job) { log('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); continue; }
    // 审核列表可能来自旧版本或旧条件；每个岗位在导航/建联前检查最新已保存的薪资条件。
    const salaryFilter = BOSS_SALARY.config(await getCfg());
    job.salary = BOSS_SALARY.normalize(job.salary);
    if (!BOSS_SALARY.matches(job.salary, salaryFilter)) {
      state.results.push({ id: job.id, name: job.name, skipped: true });
      log('  薪资不符合当前条件，跳过：' + job.name + '（' + (job.salary || '未标明') + '）', 'warn');
      progress(k + 1, ids.length, '投递');
      continue;
    }
    log('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));

    // 直接访问收集时的详情链接，不依赖列表第一页仍有这张卡片。
    const url = jobDetailUrl(job);
    if (!url) { recordFail(job, '岗位详情链接无效'); progress(k + 1, ids.length, '投递'); continue; }
    const tab = await ensureTab(url);
    await ensureInjected(tab.id, 'src/content-search.js');
    log('  读取岗位JD...');
    const jdr = await sendToTab(tab.id, { type: 'OPEN_JD', job });
    if (!jdr || !jdr.success) { recordFail(job, (jdr && jdr.error) || '读取详情失败'); log('  ' + ((jdr && jdr.error) || '读取详情失败'), 'error'); progress(k + 1, ids.length, '投递'); continue; }
    const jd = jdr.jd || '';
    if (state.aborted) break;

    // 2. 用【完整JD + 简历】现场生成这个岗位专属的招呼语
    log('  AI生成专属招呼语...');
    let greeting = '';
    try { greeting = await genGreetingFromJD(cfg, job, jd); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (!greeting) { recordFail(job, '招呼语生成失败'); log('  招呼语为空，跳过', 'warn'); progress(k + 1, ids.length, '投递'); continue; }

    // 3. 点立即沟通 → 继续沟通（跳聊天页）
    log('  建立联系并识别聊天入口...');
    await waitIfPaused(); if (state.aborted) break;
    const chatResult = await sendToTab(tab.id, { type: 'GO_CHAT', job });
    const chatReady = await waitForChat(tab.id, job);
    if (!chatReady) {
      recordFail(job, (chatResult && chatResult.error) || '未跳转聊天页');
      log('  ' + ((chatResult && chatResult.error) || '未进入聊天页，跳过'), 'error');
      progress(k + 1, ids.length, '投递'); continue;
    }
    await waitIfPaused(); if (state.aborted) break;
    await ensureInjected(tab.id, 'src/content-chat.js');
    log('  已进入' + (chatReady.mode === 'inline' ? '岗位页内聊天' : '聊天页') + '，发送简历图片 + 招呼语...');
    const r = await sendToTab(tab.id, { type: 'SEND_ACTIVE', job, image: cfg.resumeImage || '', greeting: greeting });
    if (r && r.success) {
      const partial = !!cfg.resumeImage && r.imageOk !== true;
      recordOk(job, partial);
      state.processed[job.id] = { text: true, image: r.imageOk === true };
      await chrome.storage.local.set({ processed: state.processed });
      log(partial ? '  招呼语已发送；简历图片未确认发送，请人工核对（不会自动重发招呼语）' : '  ✓ 投递成功', partial ? 'warn' : 'success');
    }
    else { recordFail(job, (r && r.error) || '发送失败'); log('  失败：' + (r && r.error), 'error'); }
    progress(k + 1, ids.length, '投递');
    await rand(2500, 4500);
  }
  if (!state.aborted) finishDeliver();
}
function recordOk(job, partial = false) { state.results.push({ id: job.id, name: job.name, ok: true, partial }); }
function recordFail(job, msg) { state.results.push({ id: job.id, name: job.name, ok: false, msg: msg }); }
function finishDeliver() {
  const ok = state.results.filter(r => r.ok && !r.partial).length;
  const partial = state.results.filter(r => r.partial).length;
  const skipped = state.results.filter(r => r.skipped).length;
  const fail = state.results.length - ok - partial - skipped;
  state.phase = 'done'; pushPhase();
  log('投递完成：成功 ' + ok + ' | 图片待核对 ' + partial + ' | 薪资跳过 ' + skipped + ' | 失败 ' + fail, fail || partial ? 'warn' : 'success');
  chrome.runtime.sendMessage({ type: 'DONE', ok: ok, fail: fail }).catch(() => {});
}

async function startRun(task) {
  if (running) return;
  running = true;
  try { await task(); }
  catch (e) {
    if (!state.aborted) log(e.message, 'error');
    state.phase = state.screened.length ? 'review' : 'idle'; pushPhase();
    if (state.screened.length) chrome.runtime.sendMessage({type: 'SCREENED', screened: state.screened}).catch(() => {});
  }
  finally { collectTabId = null; running = false; if (state.aborted) { state.phase = 'idle'; pushPhase(); } }
}
// ── 消息入口 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_COLLECT') { if (running) { sendResponse({ ok: false }); return; } startRun(runCollect); sendResponse({ ok: true }); return; }
  if (msg.type === 'START_DELIVER') { if (running) { sendResponse({ ok: false }); return; } startRun(() => runDeliver(msg.jobIds)); sendResponse({ ok: true }); return; }
  if (msg.type === 'PAUSE') { state.paused = true; controlCollection('pause'); log('已暂停', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESUME') { state.paused = false; controlCollection('resume'); log('继续', 'info'); sendResponse({ ok: true }); return; }
  if (msg.type === 'STOP') { state.aborted = true; state.paused = false; pendingAI.forEach(cancel => cancel(new Error('已停止'))); pendingPageSteps.forEach(cancel => cancel(new Error('已停止'))); controlCollection('stop'); log('正在停止，等待当前步骤结束', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'CLEAR_COLLECTED') { if (running) { sendResponse({ ok: false }); return; } chrome.storage.local.remove(['collectedIds', 'searchProgress']).then(() => { log('已清空收集历史与搜索进度，已投记录仍保留'); sendResponse({ ok: true }); }); return true; }
  if (msg.type === 'RESET_SEARCH') { if (running) { sendResponse({ ok: false }); return; } chrome.storage.local.remove('searchProgress').then(() => { log('下次将从首个搜索入口开始，收集历史和已投记录仍保留'); sendResponse({ ok: true }); }); return true; }
  if (msg.type === 'RESET') { if (running) { sendResponse({ ok: false }); return; } state.processed = {}; chrome.storage.local.set({ processed: {}, sw_jobs: [], sw_screened: [], sw_greetings: {}, sw_screening: null }); state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; state.phase = 'idle'; pushPhase(); log('已重置（清空已投记录）', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['sw_screened', 'sw_screening']).then(saved => {
      if (!running && state.phase === 'idle' && !state.screened.length && ((saved.sw_screened || []).length || saved.sw_screening)) {
        state.screened = saved.sw_screened || []; state.phase = 'review';
        if (saved.sw_screening) state.notice = '上次筛选已中断，已恢复 ' + state.screened.length + (saved.sw_screening.total ? '/' + saved.sw_screening.total : '') + ' 个结果；可审核已完成项或重新收集。';
      }
      sendResponse({ phase: state.phase, screened: state.screened, paused: state.paused, notice: state.notice || '' });
    });
    return true;
  }
});

chrome.storage.local.get('processed').then(r => { if (r.processed) state.processed = r.processed; });
