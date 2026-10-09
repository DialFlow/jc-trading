const { chromium } = require('playwright'); const path=require('path'), D=process.env.DATA_DIR;
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1280,height:1000}],['phone',{width:390,height:844}]]){
 const p=await b.newPage({viewport:vp,colorScheme:'dark'}); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(6000);
 await p.click('.tab-btn:has-text("Lab")'); await p.evaluate(()=>{labSetSym('NQ=F');rpMode='both';labView('replay');}); await p.waitForTimeout(3000);
 await p.evaluate(()=>{document.getElementById('rp-day').value='2026-09-29';rpLoad();}); await p.waitForTimeout(800);
 const out=[];
 for (const m of [570, 600, 750]) {
   await p.evaluate(m=>{const i=rpBars.findIndex(b=>b.m>=m);rpAt(i<0?rpBars.length-1:i);},m); await p.waitForTimeout(400);
   out.push(await p.evaluate(()=>({clock:document.getElementById('rp-clock').textContent, panels:[...document.querySelectorAll('.rp-panel')].map(pn=>({head:pn.querySelector('.rp-head').innerText.replace(/\s+/g,' '),banner:pn.querySelector('.live-banner').innerText.replace(/\s+/g,' ').slice(0,140),chart:!!pn.querySelector('svg'),tf:[...pn.querySelectorAll('svg text')].some(t=>t.textContent==='5m candles'),notes:pn.querySelectorAll('.rpn').length}))})));
 }
 if(name==='desktop') console.log(JSON.stringify(out,null,1));
 await p.evaluate(()=>{const i=rpBars.findIndex(b=>b.m>=600);rpAt(i);}); await p.waitForTimeout(300);
 await p.screenshot({path:__dirname+'/dual-'+name+'.png',fullPage:false});
 for (const md of ['ES=F','NQ=F','both']) { await p.evaluate(m=>rpSetMode(m),md); await p.waitForTimeout(300); }
 const n=await p.evaluate(()=>document.querySelectorAll('.rp-panel').length);
 await p.evaluate(()=>rpPlay()); await p.waitForTimeout(1500); await p.evaluate(()=>rpPlay());
 const options=await p.evaluate(()=>[...document.querySelectorAll('#rp-day option')].slice(0,6).map(o=>o.textContent));
 for(const v of ['hl','live','bt','sim','ss','ce','sc','replay']){await p.evaluate(v=>labView(v),v);await p.waitForTimeout(300);}
 console.log(name,'panels after toggles:',n,'| day list:',options.join(' / '),'| hscroll:',await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),'| JS errors:',errs.length,errs.join(' | '));
}
await b.close();})();
