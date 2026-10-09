const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1280,height:900}],['phone',{width:390,height:844}]]){
 const p=await b.newPage({viewport:vp,colorScheme:'dark'}); const errs=[],bad=[]; p.on('pageerror',e=>errs.push(e.message));
 p.on('response',r=>{if(r.status()>=400)bad.push(r.status()+' '+r.url().slice(0,90))});
 await p.route('**/data/*.json*',r=>{const n=r.request().url().split('/data/')[1].split('.json')[0];r.fulfill({path:require('path').join(process.env.DATA_DIR,n+'.json'),headers:{'access-control-allow-origin':'*','content-type':'application/json'}})});
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(4000);
 const mini=await p.evaluate(()=>document.querySelector('#ready-wrap .ready-title').innerText.replace(/\s+/g,' '));
 await p.click('.tab-btn:has-text("Lab")'); await p.waitForTimeout(400);
 await p.evaluate(()=>labView('live')); await p.waitForTimeout(1500);
 const live=await p.evaluate(()=>({sym:labSym,cfg:labCfgId,banner:document.getElementById('live-banner').innerText.replace(/\s+/g,' '),steps:document.getElementById('live-steps').innerText.replace(/\s+/g,' ').slice(0,700),ticket:document.getElementById('live-ticket').innerText.replace(/\s+/g,' ').slice(0,200),edge:document.getElementById('live-edge').innerText.replace(/\s+/g,' ').slice(0,400),chart:!!document.querySelector('#live-chart svg'),events:document.getElementById('live-events').innerText}));
 if(name==='desktop'){console.log('MINI:',mini);console.log('LIVE:',JSON.stringify(live,null,1));}
 await p.screenshot({path:__dirname+'/lab-live-'+name+'.png',fullPage:false});
 await p.evaluate(()=>labView('sim')); await p.waitForTimeout(2500);
 const sim=await p.evaluate(()=>document.getElementById('sim-out').innerText.replace(/\s+/g,' ').slice(0,900));
 if(name==='desktop')console.log('SIM:',sim);
 await p.evaluate(()=>labView('replay')); await p.waitForTimeout(1500);
 const days=await p.evaluate(()=>[...document.querySelectorAll('#rp-day option')].map(o=>o.textContent));
 // pick a day with a trade and step to the end
 const tday=await p.evaluate(()=>{const o=[...document.querySelectorAll('#rp-day option')].find(o=>o.textContent.includes('trade'));if(o){document.getElementById('rp-day').value=o.value;rpLoad();}return o&&o.value;});
 await p.waitForTimeout(600);
 const rpStart=await p.evaluate(()=>document.getElementById('rp-banner-'+labSym.slice(0,2)).innerText.replace(/\s+/g,' '));
 await p.evaluate(()=>rpAt(rpBars.length-1)); await p.waitForTimeout(400);
 const rpEnd=await p.evaluate(()=>({banner:document.getElementById('rp-banner-'+labSym.slice(0,2)).innerText.replace(/\s+/g,' '),steps:document.getElementById('rp-events-'+labSym.slice(0,2)).innerText.replace(/\s+/g,' ').slice(0,500)}));
 const ref=await p.evaluate(d=>labCfg().trades.filter(t=>t.td===d).map(t=>t.entryTime+' '+t.entry+'→'+t.exit+' '+t.why),tday);
 if(name==='desktop'){console.log('REPLAY days:',days.length,'trade day',tday);console.log(' at 9:25:',rpStart);console.log(' at end:',JSON.stringify(rpEnd));console.log(' backtest trade that day:',JSON.stringify(ref));}
 await p.screenshot({path:__dirname+'/lab-replay-'+name+'.png'});
 await p.evaluate(()=>labView('bt')); await p.waitForTimeout(300);
 const grid=await p.evaluate(()=>document.querySelectorAll('#bt-grid tr').length-1);
 await p.evaluate(()=>labSetSym('ES=F')); await p.evaluate(()=>labView('live')); await p.waitForTimeout(1200);
 const esLive=await p.evaluate(()=>({cfg:labCfgId,banner:document.getElementById('live-banner').innerText.replace(/\s+/g,' ').slice(0,200)}));
 if(name==='desktop')console.log('ES live:',JSON.stringify(esLive),'grid rows',grid);
 const hs=await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 const btns=p.locator('.tab-btn');for(let i=0;i<await btns.count();i++){await btns.nth(i).click();await p.waitForTimeout(120);}
 await p.click('.tab-btn:nth-child(1)'); await p.evaluate(() => showPage('dashboard')); await p.click('#ai-refresh-btn'); await p.waitForTimeout(2500);
 console.log(name,'hscroll:',hs,'http errors:',bad.length,bad.join(','),'JS errors:',errs.length,errs.join(' | '));
}
await b.close();})();
