const test = require('node:test');
const assert = require('node:assert/strict');
const {page, worker, job} = require('./helpers.cjs');

test('岗位内聊天弹窗已出现时，建联应成功而不是等待 URL 跳转', async () => {
  const p = page('<div class="job-banner"><a href="javascript:;">继续沟通</a></div>', 'https://www.zhipin.com/job_detail/target.html');
  p.w.document.querySelector('a').onclick = () => {
    p.w.document.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap"><div class="chat-container"><textarea placeholder="请简短描述您的问题"></textarea><button class="btn-send">发送</button></div></div>');
  };
  const r = await p.send({type:'GO_CHAT',job:{id:'target'}});
  assert.equal(r.success, true, r.error);
  assert.equal(r.mode, 'inline');
  p.w.close();
});

test('后台支持不改变详情 URL 的聊天窗口，不误报未进入聊天页', async () => {
  const w = worker({sw_jobs:[job('a')]}, msg => {
    if(msg.type==='OPEN_JD') return {success:true,jd:'测试岗位'};
    if(msg.type==='GO_CHAT') return {success:true,mode:'inline'};
    if(msg.type==='CHAT_STATUS') return {success:true,ready:true,mode:'inline'};
    if(msg.type==='SEND_ACTIVE') return {success:true,imageOk:true};
    return {success:false};
  });
  await w.run("runDeliver(['a'])");
  assert.equal(w.calls.filter(c=>c.type==='SEND_ACTIVE').length,1);
  assert.equal(w.data.processed.a.text,true);
});

test('实际 BOSS 确认弹窗使用 span.btn-sure，必须点击弹窗内继续沟通', async () => {
  const p = page('<div class="job-banner"><a href="javascript:;">立即沟通</a></div>', 'https://www.zhipin.com/job_detail/target.html');
  let confirmations = 0;
  p.w.document.querySelector('a').onclick = () => {
    p.w.document.body.insertAdjacentHTML('beforeend', '<div class="dialog-wrap greet-pop greet-boss-pop"><div class="dialog-container"><div class="dialog-title">已向BOSS发送消息</div><div class="dialog-footer"><div class="btns"><span class="btn btn-outline btn-cancel">留在此页</span><span class="btn btn-sure" ka="dialog_confirm">继续沟通</span></div></div></div></div>');
    p.w.document.querySelector('.btn-sure').onclick = () => { confirmations++; p.w.document.querySelector('.dialog-container').innerHTML = '<textarea placeholder="请简短描述您的问题"></textarea><button class="btn-send">发送</button>'; };
  };
  const r = await p.send({type:'GO_CHAT',job:{id:'target'}});
  assert.equal(confirmations,1);
  assert.equal(r.success,true,r.error);
  p.w.close();
});

test('没有确认弹窗、已经存在聊天输入框时不重复点击背景沟通按钮', async () => {
  const p = page('<div class="job-banner"><button>继续沟通</button></div><div class="dialog-wrap"><textarea></textarea><span class="btn-send">发送</span></div>', 'https://www.zhipin.com/job_detail/target.html');
  let clicks = 0; p.w.document.querySelector('button').onclick = () => clicks++;
  const r = await p.send({type:'GO_CHAT',job:{id:'target'}});
  assert.equal(r.mode,'inline'); assert.equal(clicks,0); p.w.close();
});
test('确认弹窗延迟出现也能继续，只点击一次确认按钮', async () => {
  const p = page('<div class="job-banner"><a>立即沟通</a></div>', 'https://www.zhipin.com/job_detail/target.html');
  let polls = 0, clicks = 0;
  const timeout = p.w.setTimeout;
  p.w.setTimeout = fn => timeout(() => {
    if (++polls === 10) {
      p.w.document.body.insertAdjacentHTML('beforeend','<div class="dialog-wrap"><div>已向BOSS发送消息</div><span class="btn btn-sure">继续沟通</span></div>');
      p.w.document.querySelector('.btn-sure').onclick = () => {clicks++;};
    }
    if(polls===15) p.w.document.querySelector('.dialog-wrap').innerHTML='<textarea></textarea><button>发送</button>';
    fn();
  });
  const r = await p.send({type:'GO_CHAT',job:{id:'target'}});
  assert.equal(r.success,true); assert.equal(clicks,1); p.w.close();
});
test('没有弹窗也没有聊天入口时有界结束，不反复点击背景按钮', async () => {
  const p = page('<div class="job-banner"><button>继续沟通</button></div>', 'https://www.zhipin.com/job_detail/target.html');
  let clicks = 0; p.w.document.querySelector('button').onclick = () => clicks++;
  const r = await p.send({type:'GO_CHAT',job:{id:'target'}});
  assert.equal(r.success,false); assert.equal(clicks,1); p.w.close();
});
test('只有隐藏的确认弹窗不会误点击', async () => {
  const p = page('<div class="job-banner"><button>继续沟通</button></div><div class="dialog-wrap" style="display:none">已向BOSS发送消息<span class="btn">继续沟通</span></div>', 'https://www.zhipin.com/job_detail/target.html');
  let clicks=0; p.w.document.querySelector('.btn').onclick=()=>clicks++;
  assert.equal((await p.send({type:'GO_CHAT',job:{id:'target'}})).success,false);
  assert.equal(clicks,0); p.w.close();
});
function chat(html = '', mode = 'inline') {
  return page((mode==='inline'?'<div class="dialog-wrap">':'<div class="chat-conversation">')+'<div class="messages">'+html+'</div><div class="message-controls"><textarea></textarea><button class="btn-send">发送</button></div></div>', mode==='inline'?'https://www.zhipin.com/job_detail/target.html':'https://www.zhipin.com/web/geek/chat', 'content-chat.js');
}
const send = {type:'SEND_ACTIVE',job:{id:'target'},greeting:'测试招呼，请查收'};
function confirmSend(p) {
  const input=p.w.document.querySelector('textarea');
  p.w.document.querySelector('button').onclick=()=>{
    const bubble=p.w.document.createElement('li'); bubble.className='item-myself'; bubble.textContent=input.value;
    p.w.document.querySelector('.messages').append(bubble); input.value='';
  };
}
test('页内弹窗只点发送一次，不同时按回车；对应消息出现后确认成功', async () => {
  const p=chat(); confirmSend(p); let enter=0,clicks=0;
  p.w.document.querySelector('textarea').onkeydown=()=>enter++;
  p.w.document.querySelector('button').addEventListener('click',()=>clicks++);
  const r=await p.send(send);
  assert.equal(r.success,true,r.error); assert.equal(enter,0); assert.equal(clicks,1); p.w.close();
});
test('完整聊天页就绪探测及发送仍兼容', async () => {
  const p=chat('', 'page'); confirmSend(p);
  const status=await p.send({type:'CHAT_STATUS',job:{id:'target'}});
  assert.equal(status.mode,'page'); assert.equal(status.ready,true);
  assert.equal((await p.send(send)).success,true); p.w.close();
});
test('只清空输入框、或只存在历史同文消息都不误报发送成功', async () => {
  for (const old of ['', '<li class="item-myself">测试招呼，请查收</li>']) {
    const p=chat(old); let clicks=0;
    p.w.document.querySelector('button').onclick=()=>{clicks++; p.w.document.querySelector('textarea').value='';};
    assert.equal((await p.send(send)).success,false); assert.equal(clicks,1); p.w.close();
  }
});
test('不覆盖用户草稿、不向错误岗位弹窗发送', async () => {
  const p=chat(); let clicks=0; p.w.document.querySelector('button').onclick=()=>clicks++;
  const input=p.w.document.querySelector('textarea'); input.value='用户原有草稿';
  assert.equal((await p.send(send)).success,false); assert.equal(input.value,'用户原有草稿');
  input.value=''; assert.equal((await p.send({...send,job:{id:'other'}})).success,false);
  assert.equal(clicks,0); p.w.close();
});
test('不把页面附件简历上传控件当作聊天图片入口；缺少图片入口明确返回', async () => {
  const p=chat(); confirmSend(p);
  const attachment=p.w.document.createElement('input');attachment.type='file';attachment.accept='image/png,application/pdf';p.w.document.body.append(attachment);
  let changes=0; attachment.onchange=()=>changes++;
  const r=await p.send({...send,image:'data:image/png;base64,AA=='});
  assert.equal(r.success,true); assert.equal(r.imageOk,false); assert.equal(changes,0); p.w.close();
});
test('后台明确记录图片未确认，而不是完整投递成功，且不会重复发文字', async () => {
  const w=worker({sw_jobs:[job('a')],resumeImage:'test'},msg=>{
    if(msg.type==='OPEN_JD') return {success:true,jd:'test'};
    if(msg.type==='GO_CHAT') return {success:true,mode:'inline'};
    if(msg.type==='CHAT_STATUS') return {ready:true,mode:'inline'};
    if(msg.type==='SEND_ACTIVE') return {success:true,imageOk:false};
  });
  await w.run("runDeliver(['a'])");
  assert.equal(w.data.processed.a.text,true); assert.equal(w.data.processed.a.image,false);
  assert.ok(w.messages.some(m=>m.type==='LOG'&&m.text.includes('图片待核对 1')));
  await w.run("runDeliver(['a'])");
  assert.equal(w.calls.filter(c=>c.type==='SEND_ACTIVE').length,1);
});
