const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1440,height:950}],['phone',{width:390,height:844}]]){
 const p=await b.newPage({viewport:vp,colorScheme:'dark'}); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(6000);
 await p.click('.tab-btn:has-text("Lab")'); await p.evaluate(()=>labView('replay')); await p.waitForTimeout(2500);
 await p.evaluate(()=>{document.getElementById('rp-day').value='2026-10-06';rpLoad();}); await p.waitForTimeout(800);
 await p.evaluate(()=>{const i=rpBars.findIndex(b=>b.m>=615);rpAt(i);}); await p.waitForTimeout(300);
 for (const tf of ['15m','1h','5m']) {
   await p.evaluate(t=>rpSetTf(t),tf); await p.waitForTimeout(400);
   const info=await p.evaluate(()=>({clock:document.getElementById('rp-clock').textContent,heads:[...document.querySelectorAll('.rp-head')].map(h=>h.innerText.replace(/\s+/g,' ').slice(0,70)),labels:[...document.querySelectorAll('.rp-chart svg text')].filter(t=>/candles$/.test(t.textContent)).map(t=>t.textContent),candles:[...document.querySelectorAll('.rp-chart svg')].map(s=>s.querySelectorAll('rect[fill="var(--bull)"],rect[fill="var(--bear)"]').length),pos:[...document.querySelectorAll('.rp-chart svg text')].filter(t=>/SELL|BUY|STOP|TP/.test(t.textContent)).length}));
   if(name==='desktop') console.log(tf, JSON.stringify(info));
   if(tf!=='5m') { await p.evaluate(()=>document.getElementById('rp-panels').scrollIntoView()); await p.screenshot({path:__dirname+'/htf-'+tf+'-'+name+'.png'}); }
 }
 // play a few steps on 1H to check the forming candle updates without errors
 await p.evaluate(()=>rpSetTf('1h')); for(let k=0;k<6;k++){await p.evaluate(()=>rpStep(1));await p.waitForTimeout(80);}
 console.log(name,'hscroll:',await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),'JS errors:',errs.length,errs.join(' | '));
}
await b.close();})();
