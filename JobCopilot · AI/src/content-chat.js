// 同时支持独立聊天页和岗位详情内的聊天弹窗。
(function () {
  if (window.__bossToudiChat) return;
  window.__bossToudiChat = true;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let sending = false;

  async function waitContext(job, timeout = 8000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const context = BOSS_CHAT_UI.context(job);
      if (context) return context;
      await sleep(250);
    }
    return null;
  }
  function stillCurrent(context, job) {
    const current = BOSS_CHAT_UI.context(job);
    return current && current.input === context.input && current.root === context.root;
  }
  function inputText(el) {
    return el.matches('textarea, input') ? el.value : el.textContent || '';
  }
  const normalize = text => (text || '').replace(/\s+/g, '');
  function deliveredMessages(context, greeting) {
    return BOSS_CHAT_UI.outgoing(context.root).filter(el =>
      normalize(el.textContent).includes(normalize(greeting)) &&
      !el.matches('.sending, .failed, [data-status="sending"], [data-status="failed"]') &&
      !el.querySelector('.send-fail, .message-error, .sending, [data-status="failed"]'));
  }
  async function sendText(context, job, greeting) {
    const input = context.input;
    if (!stillCurrent(context, job)) return { ok: false, err: '聊天窗口已变化，未发送' };
    if (inputText(input).trim()) return { ok: false, err: '聊天框中已有未发送草稿，请先处理，插件不会覆盖' };
    const before = deliveredMessages(context, greeting).length;
    input.focus();
    if (input.matches('textarea')) {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, greeting);
    } else input.textContent = greeting;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: greeting }));
    await sleep(300);
    if (normalize(inputText(input)) !== normalize(greeting)) return { ok: false, err: '招呼语未完整填入输入框' };

    // 等页面响应输入后，只用一种发送动作；不能回车后紧接着再点发送。
    let button = BOSS_CHAT_UI.sendButton(context.root);
    for (let i = 0; button && BOSS_CHAT_UI.disabled(button) && i < 12; i++) {
      if (!stillCurrent(context, job)) return { ok: false, err: '聊天窗口已变化，未发送' };
      await sleep(250);
      button = BOSS_CHAT_UI.sendButton(context.root);
    }
    if (!stillCurrent(context, job)) return { ok: false, err: '聊天窗口已变化，未发送' };
    if (button) {
      if (BOSS_CHAT_UI.disabled(button)) return { ok: false, err: '发送按钮不可用，请检查页面提示' };
      button.click();
    } else {
      // 仅完整聊天页支持旧版回车发送；页内弹窗缺少按钮时不猜测行为。
      if (context.mode !== 'page') return { ok: false, err: '聊天弹窗没有可用的发送按钮' };
      const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent('keydown', options));
      input.dispatchEvent(new KeyboardEvent('keyup', options));
    }
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      if (!stillCurrent(context, job)) return { ok: false, err: '发送后聊天窗口发生变化，结果未确认，请人工核对' };
      if (!inputText(input).trim() && deliveredMessages(context, greeting).length > before) return { ok: true };
    }
    return { ok: false, err: '发送结果未确认：未同时看到输入清空和对应消息，请人工核对，未自动重发' };
  }
  function dataURLtoFile(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/);
    if (!mime || !mime[1].startsWith('image/')) throw new Error('简历图片格式不正确');
    const bytes = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
    return new File([bytes], 'resume.png', { type: mime[1] });
  }
  async function sendImage(context, job, image) {
    if (!image) return true;
    if (!stillCurrent(context, job)) return false;
    // 只使用当前聊天区域的图片上传控件，不使用页面上的附件简历上传框。
    const controls = context.mode === 'page' ? context.input.closest('.message-controls') || context.root : context.root;
    const input = controls.querySelector('.btn-sendimg input[type="file"], .chat-toolbar input[type="file"][accept*="image"]');
    if (!input || input.disabled) return false;
    const before = new Set(BOSS_CHAT_UI.outgoing(context.root).flatMap(el => Array.from(el.querySelectorAll('img')).map(img => img.src)));
    const dt = new DataTransfer();
    dt.items.add(dataURLtoFile(image));
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files').set.call(input, dt.files);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      if (!stillCurrent(context, job)) return false;
      const sentImage = BOSS_CHAT_UI.outgoing(context.root).some(el =>
        !el.querySelector('.send-fail, .message-error, .sending') &&
        Array.from(el.querySelectorAll('img')).some(img => img.src && !before.has(img.src) && img.complete && img.naturalWidth > 0));
      if (sentImage) return true;
    }
    return false;
  }
  async function sendActive(msg) {
    if (sending) return { success: false, error: '当前聊天正在发送，请勿重复触发' };
    sending = true;
    try {
      if (!(msg.greeting || '').trim()) return { success: false, error: '招呼语为空' };
      const context = await waitContext(msg.job);
      if (!context) return { success: false, error: '未找到当前岗位的可用聊天输入框' };
      if (inputText(context.input).trim()) return { success: false, error: '聊天框中已有未发送草稿，请先处理' };
      const imageOk = await sendImage(context, msg.job, msg.image);
      const textResult = await sendText(context, msg.job, msg.greeting);
      if (!textResult.ok) return { success: false, imageOk, error: textResult.err };
      return { success: true, imageOk, textOk: true, mode: context.mode };
    } finally { sending = false; }
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHAT_STATUS') {
      const context = BOSS_CHAT_UI.context(msg.job);
      sendResponse({ success: true, ready: !!context, mode: context && context.mode });
      return;
    }
    if (msg.type === 'SEND_ACTIVE') {
      sendActive(msg).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SEND') {
      sendResponse({ success: false, error: '请从所选岗位进入聊天后发送，不自动切换到其他会话' });
    }
  });
})();
