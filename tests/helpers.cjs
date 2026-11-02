const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const src = name => fs.readFileSync(path.join(__dirname, '..', 'JobCopilot · AI', 'src', name), 'utf8');
const job = id => ({id, name: '前端开发（校招）', company: '测试公司', tags: ['应届生', '本科'], link: `https://www.zhipin.com/job_detail/${id}.html`});
const card = (id, type = 'job-card-box') => `<li class="${type}"><a href="/job_detail/${id}.html?securityId=fixture"><span class="job-name">前端开发（校招）</span><span class="job-salary">10-15K</span><ul class="tag-list"><li>应届生</li><li>本科</li></ul></a><a class="company-info"><span class="${type === 'job-card-wrapper' ? 'company-logo' : 'company-name'}">测试公司</span></a></li>`;
function page(html, url = 'https://www.zhipin.com/web/geek/jobs', script = 'content-search.js') {
  const dom = new JSDOM(html, {url, runScripts: 'outside-only'});
  const w = dom.window;
  const listeners = [], messages = [];
  let time = 0;
  w.Date.now = () => time;
  w.setTimeout = fn => { time += 300; return setImmediate(fn); };
  w.scrollBy = () => {};
  w.HTMLElement.prototype.getClientRects = function () { return this.style.display === 'none' ? [] : [{}]; };
  w.chrome = { runtime: { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async m => {messages.push(m);} } };
  w.eval(src('salary.js')); w.eval(src('selectors.js')); w.eval(src('chat-ui.js')); w.eval(src(script));
  return { dom, w, messages, listeners, load: name => w.eval(src(name)), send: msg => new Promise(resolve => listeners[0](msg, {}, resolve)) };
}
function worker(config = {}, respond = () => ({success: true, jobs: [], reason: 'end', scanned: 0, duplicates: 0}), options = {}) {
  const data = {dsKey: 'test-key', resumeText: '测试简历：计算机专业，前端项目', keyword: '前端', city: '北京', count: 2, ...config};
  const session = {}, calls = [], messages = [], listeners = [], tabs = new Map();
  let time = 0;
  const storage = values => ({get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, values[k]])), set: async obj => Object.assign(values, obj), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }});
  const chrome = {
    runtime: {onInstalled: {addListener() {}}, onMessage: {addListener: fn => listeners.push(fn)}, sendMessage: async m => { messages.push(m); }},
    sidePanel: {setPanelBehavior: async () => {}},
    permissions: {contains: async () => true},
    storage: {local: storage(data), session: storage(session)},
    scripting: {executeScript: async p => calls.push({type: 'inject', ...p})},
    tabs: {
      create: async ({url}) => {const t = {id: tabs.size + 1, url, status: 'complete'}; tabs.set(t.id, t); calls.push({type: 'create', ...t}); return {...t};},
      update: async (id, props) => {Object.assign(tabs.get(id), props); calls.push({type: 'update', id, ...props}); return {...tabs.get(id)};},
      get: async id => {if (!tabs.has(id)) throw new Error('no tab'); return {...tabs.get(id)};},
      query: async () => [...tabs.values()],
      sendMessage: (id, msg, cb) => {calls.push({type: 'message', id, ...msg}); cb(respond(msg, tabs.get(id), data));}
    }
  };
  const context = vm.createContext({chrome, URL, URLSearchParams, console, Date: class extends Date {static now() {return time;}}, setTimeout: (fn, ms) => {time += ms; return setImmediate(fn);}, fetch: async () => { throw new Error('Tests must not access AI or send real applications'); }, AbortController, clearTimeout, ...options.globals});
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(src(file.split('/').pop()), context));
  vm.runInContext(src('background.js'), context);
  if (!options.realAI) vm.runInContext("screenJob = async () => ({match: true, reason: '测试匹配'}); genGreetingFromJD = async () => '测试招呼语';", context);
  return {data, session, calls, messages, tabs, context, run: js => vm.runInContext(js, context), send: msg => new Promise(resolve => listeners[0](msg, {}, resolve))};
}
module.exports = {src, page, worker, job, card};
