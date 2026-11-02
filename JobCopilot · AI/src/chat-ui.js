// 搜索页和聊天页共用的只读就绪检测。重复注入安全。
var BOSS_CHAT_UI = (() => {
  const dialogs = '[role="dialog"], .dialog-wrap, .dialog-container, .boss-dialog, .chat-dialog, .chat-pop';
  const inputs = '#chat-input, .chat-input[contenteditable], [contenteditable="true"], textarea';
  function visible(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
  }
  function disabled(el) {
    return !!(el.disabled || el.closest('.disabled, .is-disabled, [disabled], [aria-disabled="true"]'));
  }
  function editor(root) {
    return Array.from(root.querySelectorAll(inputs)).find(el => visible(el) && !disabled(el) && !el.readOnly && el.getAttribute('contenteditable') !== 'false');
  }
  function context(job) {
    if (/^\/web\/geek\/chat(?:\/|$)/.test(location.pathname)) {
      const input = editor(document);
      return input ? { mode: 'page', root: document, input } : null;
    }
    const match = location.pathname.match(/^\/job_detail\/([^/]+)\.html$/);
    if (!match || !job || match[1] !== job.id) return null;
    for (const root of document.querySelectorAll(dialogs)) {
      if (!visible(root)) continue;
      const input = editor(root);
      if (input) return { mode: 'inline', root, input };
    }
    return null;
  }
  function confirmation() {
    for (const root of document.querySelectorAll(dialogs)) {
      if (!visible(root) || !/已向\s*BOSS\s*发送消息/i.test(root.textContent)) continue;
      const button = Array.from(root.querySelectorAll('a, button, [role="button"], .btn'))
        .find(el => visible(el) && !disabled(el) && el.textContent.trim() === '继续沟通');
      if (button) return { root, button };
    }
    return null;
  }
  function sendButton(root) {
    return Array.from(root.querySelectorAll('button, a, [role="button"], .btn-send, .btn, [class*="send-btn"]'))
      .find(el => visible(el) && /^(发送|发送消息)$/.test(el.textContent.trim()));
  }
  function outgoing(root) {
    return Array.from(root.querySelectorAll('.item-myself, .message-item.is-self, .message-item.is-me, .chat-message-right, .message-item.sent, .message-item.myself, .msg-item.myself')).filter(visible);
  }
  return { visible, disabled, context, confirmation, sendButton, outgoing };
})();
