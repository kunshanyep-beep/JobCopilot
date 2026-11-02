// 搜索页 / 校园页收集，以及独立岗位详情页建联。
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let stopped = false;
  let paused = false;

  function visible(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)).filter(visible); }
  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/\/job_detail\/([^/?#]+)\.html(?:[?#]|$)/);
    const compEl = card.querySelector(SELECTORS.jobs.company);
    return {
      id: m ? m[1] : '',
      name: nameEl ? nameEl.textContent.trim() : '',
      salary: BOSS_SALARY.normalize(salEl ? salEl.textContent : ''),
      tags: Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean),
      company: compEl ? compEl.textContent.trim() : '',
      link: link
    };
  }
  function snapshot() { return getCards().map(parseCard).filter(j => j.id && j.name); }
  function signature() { return snapshot().map(j => j.id).join('|'); }
  function pageMessage() {
    const el = Array.from(document.querySelectorAll('.job-list-empty, .search-job-empty, .empty-result, .job-list-container .empty, .job-list-box .empty')).find(visible);
    return el ? el.textContent.trim() : '';
  }
  function blockedMessage() {
    const body = (document.body.innerText || document.body.textContent || '');
    if (/安全验证|请完成验证|访问过于频繁|操作过于频繁/.test(body)) return '页面要求验证或限制访问，请在 BOSS 页面处理后继续';
    if (/\/web\/user\//.test(location.pathname)) return '请先登录 BOSS 直聘';
    return '';
  }
  function pagination() {
    const candidates = Array.from(document.querySelectorAll('.school-tab-panel .look-more-btn, .options-pages .next, .page-next, .pagination .next, .pagination-next, .ui-pagination-next, .el-pagination .btn-next, .ant-pagination-next, [title="下一页"], [aria-label="下一页"], a[rel="next"]'));
    const byText = Array.from(document.querySelectorAll('.options-pages a, .options-pages button, [class*="pagination"] a, [class*="pagination"] button'))
      .filter(el => /^(下一页|下页|Next)$/i.test(el.textContent.trim()));
    const next = candidates.concat(byText).find(visible);
    return next ? (next.matches('a, button') ? next : next.querySelector('a, button') || next) : null;
  }
  function disabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.disabled, .is-disabled, [disabled], [aria-disabled="true"]'));
  }
  function atEnd() {
    return Array.from(document.querySelectorAll('.job-list-container, .job-list-box, .search-job-result, .job-list-wrapper'))
      .some(el => /没有更多职位|没有更多岗位|没有更多了|已加载全部|已经到底/.test(el.textContent));
  }
  // 列表可能在固定高度的面板内，滚动真正的祖先容器；逐屏移动兼容虚拟列表。
  function scrollForward() {
    const card = getCards()[0];
    let el = card && card.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, before + Math.max(200, el.clientHeight * 0.8));
        return el.scrollTop > before + 1;
      }
      el = el.parentElement;
    }
    const root = document.scrollingElement || document.documentElement;
    const before = root.scrollTop;
    window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));
    return root.scrollTop > before + 1;
  }
  async function waitForChange(before, timeout) {
    const until = Date.now() + timeout;
    while (Date.now() < until && !stopped) {
      if (signature() !== before || blockedMessage()) return true;
      await sleep(300);
    }
    return false;
  }
  async function scrape(count, excludeIds, salaryFilter) {
    stopped = false; paused = false;
    const excluded = new Set(excludeIds || []);
    const observed = new Set();
    const picked = new Set();
    const salarySkipped = new Set();
    const jobs = [];
    let duplicates = 0, pages = 1, reason = 'limit', nextUrl = '', detail = '';
    const pageSignatures = new Set();
    // 有界扫描；到达预算只报告扫描上限，不能冒充“没有岗位”。
    let activeMs = 0;
    let lastTick = 0;
    function tick() {
      if (Date.now() - lastTick < 10000) return;
      lastTick = Date.now();
      chrome.runtime.sendMessage({ type: 'LOG', text: '收集中：已扫描 ' + observed.size + ' 个，新增 ' + jobs.length + ' 个，重复 ' + duplicates + ' 个，薪资排除 ' + salarySkipped.size + ' 个', level: 'info' }).catch(() => {});
    }
    const limit = Math.max(1, Math.min(200, Number(count) || 20));
    for (let step = 0; step < 240 && activeMs < 180000; step++) {
      tick();
      while (paused && !stopped) { tick(); await sleep(300); }
      if (stopped) { reason = 'stopped'; break; }
      const started = Date.now();
      const blocked = blockedMessage();
      if (blocked) { reason = 'blocked'; detail = blocked; break; }
      for (const job of snapshot()) {
        if (!observed.has(job.id)) {
          observed.add(job.id);
          if (excluded.has(job.id)) duplicates++;
        }
        if (!excluded.has(job.id) && !BOSS_SALARY.matches(job.salary, salaryFilter)) {
          salarySkipped.add(job.id); continue;
        }
        salarySkipped.delete(job.id);
        if (!excluded.has(job.id) && !picked.has(job.id)) {
          picked.add(job.id); jobs.push(job);
          if (jobs.length >= limit) break;
        }
      }
      if (jobs.length >= limit) { reason = 'target'; break; }
      const before = signature();
      const moved = scrollForward();
      await sleep(500);
      if (signature() !== before || moved) { activeMs += Date.now() - started; continue; }
      // 不用“新增数为 0”判断结束：一整页都重复时仍然需要翻页。
      if (await waitForChange(before, before ? 6000 : 12000)) { activeMs += Date.now() - started; continue; }
      if (stopped) { reason = 'stopped'; break; }
      while (paused && !stopped) { tick(); await sleep(300); }
      if (stopped) { reason = 'stopped'; break; }
      const next = pagination();
      if (next && !disabled(next)) {
        if (pages >= 30 || pageSignatures.has(before)) { reason = 'limit'; break; }
        pageSignatures.add(before);
        const href = next.getAttribute('href');
        if (href && !href.startsWith('javascript:') && href !== '#') {
          const url = new URL(href, location.href);
          if (url.origin === location.origin && /^\/web\/geek\/jobs?$/.test(url.pathname) && url.href !== location.href) {
            nextUrl = url.href; reason = 'next'; break;
          }
        }
        next.click(); pages++;
        if (!await waitForChange(before, 12000)) { reason = 'stalled'; detail = '点击下一页后列表没有更新'; break; }
        activeMs += Date.now() - started;
        continue;
      }
      detail = pageMessage();
      reason = (next && disabled(next)) || atEnd() || detail ? 'end' : 'stalled';
      if (!before && !detail) detail = '未找到岗位卡片，请检查登录状态或页面是否已加载';
      break;
    }
    if (stopped) reason = 'stopped';
    return { success: true, jobs, reason, detail, nextUrl, scanned: observed.size, duplicates, salarySkipped: salarySkipped.size, pages };
  }

  function detailMatches(job) {
    const m = location.pathname.match(/^\/job_detail\/([^/]+)\.html$/);
    return !!(m && job && m[1] === job.id);
  }
  async function openJD(job) {
    if (!detailMatches(job)) return { success: false, error: '当前详情页与所选岗位不一致' };
    for (let i = 0; i < 30; i++) {
      const blocked = blockedMessage();
      if (blocked) return { success: false, error: blocked };
      const sections = document.querySelectorAll('.job-sec-text, .job-detail .text, .job-detail-body, .job-detail-box');
      const jd = Array.from(sections).filter(visible).map(el => (el.innerText || el.textContent).trim()).filter(Boolean).join('\n');
      if (jd) return { success: true, jd: jd.slice(0, 5000) };
      await sleep(300);
    }
    return { success: false, error: '岗位详情未加载，岗位可能已关闭或需要登录' };
  }
  function findChatButton(root) {
    return Array.from(root.querySelectorAll('a, button')).find(el => visible(el) && !disabled(el) && /^(立即沟通|继续沟通)$/.test(el.textContent.trim()));
  }
  async function goChat(job) {
    if (!detailMatches(job)) return { success: false, error: '当前详情页与所选岗位不一致' };
    // 入口有三种：直接跳聊天页、确认弹窗后继续、直接打开页内聊天。
    // 已就绪就立即返回，不要求中间的确认弹窗一定出现。
    const existing = BOSS_CHAT_UI.context(job);
    if (existing) return { success: true, mode: existing.mode };
    let pending = BOSS_CHAT_UI.confirmation();
    const clicked = new Set();
    let contacted = !!pending;
    if (!pending) {
      const scope = document.querySelector('.job-banner, .job-detail-box, .job-detail');
      const btn = scope && findChatButton(scope);
      if (!btn) return { success: false, error: '该岗位没有可用的沟通按钮；如需官网网申，请在岗位页继续办理' };
      if (btn.tagName === 'A') btn.target = '_self';
      btn.click();
    }
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (/^\/web\/geek\/chat(?:\/|$)/.test(location.pathname)) return { success: true, mode: 'page', contacted };
      const ready = BOSS_CHAT_UI.context(job);
      if (ready) return { success: true, mode: ready.mode, contacted };
      pending = BOSS_CHAT_UI.confirmation();
      if (pending && !clicked.has(pending.button)) {
        contacted = true;
        chrome.runtime.sendMessage({ type: 'LOG', text: '  平台默认招呼已发送，点击确认弹窗内的“继续沟通”…', level: 'info' }).catch(() => {});
        // 仅点击确认弹窗内的按钮；不反复点击背景岗位页的“继续沟通”。
        clicked.add(pending.button);
        if (pending.button.tagName === 'A') pending.button.target = '_self';
        pending.button.click();
      }
      const blocked = blockedMessage();
      if (blocked) return { success: false, contacted, error: blocked };
      await sleep(250);
    }
    return { success: false, contacted, error: contacted ? '平台默认招呼已发送，但聊天输入框未就绪；简历和定制招呼尚未发送' : '未检测到可用聊天窗口，请检查页面提示' };
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'COLLECT_CONTROL') {
      if (msg.action === 'stop') stopped = true;
      if (msg.action === 'pause') paused = true;
      if (msg.action === 'resume') paused = false;
      sendResponse({ success: true }); return;
    }
    if (msg.type === 'SCRAPE') {
      scrape(msg.count, msg.excludeIds, msg.salaryFilter).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
