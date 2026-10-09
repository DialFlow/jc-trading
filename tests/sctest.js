const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1280,height:900}],['phone',{width:390,height:844}]]){
 const ctx=await b.newContext({viewport:vp,colorScheme:'dark'}); await ctx.grantPermissions(['notifications'],{origin:'http://localhost:8090'});
 const p=await ctx.newPage(); const errs=[],bad=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('response',r=>{if(r.status()>=400)bad.push(r.status()+' '+r.url().slice(0,80))});
 await p.route('**/data/*.json*',r=>{const n=r.request().url().split('/data/')[1].split('.json')[0];r.fulfill({path:require('path').join(process.env.DATA_DIR,n+'.json'),headers:{'access-control-allow-origin':'*','content-type':'application/json'}})});
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(5000);
 await p.click('.tab-btn:has-text("Lab")'); await p.evaluate(()=>labView('sc')); await p.waitForTimeout(3000);
 const sc=await p.evaluate(()=>({exit:labExit,exitOpts:[...document.querySelectorAll('#lab-exit option')].map(o=>o.textContent),chips:document.querySelector('.sc-chips').innerText.replace(/\s+/g,' '),cards:document.querySelectorAll('#lab-sc .hl-post').length,
   oct8:(()=>{const a=[...document.querySelectorAll('#lab-sc .hl-post')][0];return a?a.innerText.replace(/\s+/g,' ').slice(0,1200):''})()}));
 if(name==='desktop'){console.log('SCENARIOS:',JSON.stringify(sc,null,1));}
 await p.screenshot({path:__dirname+'/sc-'+name+'.png'});
 // one winner and one loss, detailed
 await p.evaluate(()=>scSet('f','loss')); await p.waitForTimeout(300);
 const loss=await p.evaluate(()=>document.querySelector('#lab-sc .hl-post')?.innerText.replace(/\s+/g,' ').slice(0,700));
 await p.evaluate(()=>{scSet('f','win');scSet('d','pro');}); await p.waitForTimeout(300);
 const win=await p.evaluate(()=>document.querySelector('#lab-sc .hl-post')?.innerText.replace(/\s+/g,' ').slice(0,700));
 if(name==='desktop'){console.log('LOSS (simple):',loss);console.log('WIN (detailed):',win);}
 await p.evaluate(()=>{scSet('d','simple');scSet('f','all');});
 // replay link
 await p.evaluate(()=>scReplay(document.querySelector('#rp-day option')?.value||'2026-10-08')); await p.waitForTimeout(800);
 const rp=await p.evaluate(()=>!document.getElementById('lab-replay').hidden&&document.getElementById('rp-day').value);
 // readiness at 10:12 with exit plan
 const rd=await p.evaluate(async()=>{const full=JSON.parse(JSON.stringify(labRaw));const td=TJR.et(full.bars['NQ=F']['5m'].slice(-1)[0][0]).td;
   const cut=full.bars['NQ=F']['5m'].find(r=>{const e=TJR.et(r[0]);return e.td===td&&e.m===605})[0];
   for(const s of ['NQ=F','ES=F'])labRaw.bars[s]['5m']=full.bars[s]['5m'].filter(r=>r[0]<=cut);
   const rn=Date.now,rg=getCurrentETTime;Date.now=()=>(cut+360)*1000;const [Y,M,D]=td.split('-').map(Number);window.getCurrentETTime=()=>new Date(Y,M-1,D,10,12);
   readySym='NQ=F';showPage('dashboard');renderReadiness();
   const o={title:document.querySelector('#ready-wrap .ready-title').textContent,sub:document.querySelector('#ready-wrap .ready-sub').textContent,exit:document.querySelector('#ready-wrap .ready-exit')?.innerText.replace(/\s+/g,' ').slice(0,700)};
   labRaw=full;Date.now=rn;window.getCurrentETTime=rg;renderReadiness();return o;});
 if(name==='desktop'){console.log('REPLAY link →',rp);console.log('READINESS 10:12:',JSON.stringify(rd,null,1));}
 await p.locator('#ready-wrap').screenshot({path:__dirname+'/ready-exit-'+name+'.png'}).catch(()=>{});
 // alerts toggle + exit switch
 await p.click('#ready-wrap button:has-text("Alerts")'); await p.waitForTimeout(300);
 const al=await p.evaluate(()=>alertsOn());
 await p.click('.tab-btn:has-text("Lab")'); await p.evaluate(()=>{labView('live');labSetExit('rules');}); await p.waitForTimeout(1200);
 const liveRules=await p.evaluate(()=>document.getElementById('live-edge').innerText.replace(/\s+/g,' ').slice(0,420));
 if(name==='desktop'){console.log('alerts on:',al);console.log('LIVE edge (rules exit):',liveRules);}
 for(const v of ['hl','live','bt','sim','sc','replay']){await p.evaluate(v=>labView(v),v);await p.waitForTimeout(500);}
 const btns=p.locator('.tab-btn');for(let i=0;i<await btns.count();i++){await btns.nth(i).click();await p.waitForTimeout(120);}
 const hs=await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 console.log(name,'hscroll:',hs,'http errors:',bad.length,bad.join(','),'JS errors:',errs.length,errs.join(' | '));
 await ctx.close();
}
await b.close();})();
