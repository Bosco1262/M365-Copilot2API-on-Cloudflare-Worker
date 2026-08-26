const fs=require('fs');
const LOG=[];function L(s){LOG.push(s);fs.appendFileSync('flow.log',s+'\n');}
process.on('exit',()=>{try{fs.appendFileSync('flow.log','[exit] code='+process.exitCode+'\n')}catch{}});
setTimeout(()=>{L('WATCHDOG TIMEOUT');fs.writeFileSync('flow.log',LOG.join('\n'));process.exit(3)},45000);
const { JSDOM } = require('jsdom');
const BASE='http://127.0.0.1:8796';
let cookie='';
async function fwc(url,opts={}){
  opts.headers=Object.assign({},opts.headers,{cookie});
  const r=await fetch(url,opts);
  const sc=r.headers.getSetCookie?r.headers.getSetCookie():[];
  for(const c of sc){cookie=c.split(';')[0];}
  return r;
}
const loginScript=fs.readFileSync('assets/login.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const indexScript=fs.readFileSync('assets/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  L('start');
  const lp=await fwc(BASE+'/login');
  const loginHtml=await lp.text();
  const mk=(html,url)=>{const d=new JSDOM(html,{url,runScripts:'outside-only',pretendToBeVisual:true});const w=d.window;
    w.fetch=(u,o)=>fwc(u.startsWith('http')?u:new URL(u,BASE).href,o);
    if(!w.crypto)w.crypto=require('crypto').webcrypto;
    return w;};
  const lw=mk(loginHtml,BASE+'/login');
  lw.eval(loginScript);L('login script evaluated, locale='+lw.LOGIN_LOCALE);
  await sleep(80);
  const submit=w=>w.document.getElementById(w.document.getElementById('change').hidden?'loginForm':'changeForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  lw.document.getElementById('password').value='admin123';
  submit(lw);await sleep(400);
  L('after admin123 submit -> change.hidden='+lw.document.getElementById('change').hidden+' err='+JSON.stringify(lw.document.getElementById('loginError').textContent));
  if(!lw.document.getElementById('change').hidden===false){}else{L('FAIL: change view not visible');throw new Error('no change view')}
  lw.document.getElementById('current').value='admin123';
  lw.document.getElementById('next').value='newpw-123';
  lw.document.getElementById('confirm').value='newpw-123';
  let alertMsg='';lw.alert=m=>{alertMsg=m};
  lw.location.replace=u=>{L('location.replace->'+u)};
  submit(lw);await sleep(500);
  L('change submitted, alert='+JSON.stringify(alertMsg.slice(0,50)));
  // re-login fresh
  cookie='';
  const lp2=await fwc(BASE+'/login');await lp2.text();
  const lw2=mk(loginHtml,BASE+'/login');
  lw2.eval(loginScript);await sleep(60);
  lw2.document.getElementById('password').value='newpw-123';
  lw2.document.getElementById('loginForm').dispatchEvent(new lw2.Event('submit',{bubbles:true,cancelable:true}));
  await sleep(400);
  L('re-login newpw -> change.hidden='+lw2.document.getElementById('change').hidden);
  // index boot
  const ip=await fwc(BASE+'/');const indexHtml=await ip.text();
  const iw=mk(indexHtml,BASE+'/');
  iw.alert=()=>{};iw.location.replace=u=>{L('[index] replace->'+u)};
  iw.eval(indexScript);await sleep(900);
  L('[index] app.display='+iw.document.getElementById('app').style.display+' login.display='+iw.document.getElementById('login').style.display);
  L(iw.document.getElementById('app').style.display==='flex'?'PASS':'FAIL');
  fs.writeFileSync('flow.log',LOG.join('\n'));
})().catch(e=>{L('HARNESS ERROR: '+e.stack);fs.writeFileSync('flow.log',LOG.join('\n'));process.exit(1)});
