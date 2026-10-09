const { chromium } = require('playwright');
const path = require('path'), D = process.env.DATA_DIR;
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1280,height:900}],['phone',{width:390,height:844}]]){
 const p=await b.newPage({viewport:vp,colorScheme:'dark'}); const errs=[],bad=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('response',r=>{if(r.status()>=400)bad.push(r.status()+' '+r.url().slice(0,80))});
 await p.route('**/data/*.json*',r=>{const f=r.request().url().match(/data\/(\w+)\.json/)[1];r.fulfill({path:path.join(D,f+'.json'),headers:{'access-control-allow-origin':'*','content-type':'application/json'}})});
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(6500);
 const g=sel=>p.evaluate(s=>document.querySelector(s)?.innerText.replace(/\s+/g,' ').trim(),sel);
 if(name==='desktop'){
  console.log('ORDER:',await p.evaluate(()=>[...document.querySelectorAll('#page-dashboard > div, #page-dashboard > .section-label')].map(e=>e.id||e.className.split(' ')[0]||e.textContent.slice(0,20)).filter(Boolean).join(' › ')));
  console.log('MARKET:',await g('.mk'));
  console.log('SIGNAL:',await g('#ai-direction-label'),'| score',await g('#ai-score'),'|',await g('#ai-conf-badge'));
  console.log('REASONS:',(await p.$$eval('#ai-reasoning-list .ai-reasoning-item',els=>els.map(e=>e.innerText.replace(/\s+/g,' ')))).join('\n   '));
  console.log('ANALYSIS:',(await g('#analysis-wrap')).slice(0,1500));
  console.log('EVENTS:',await g('#events-card'));
  console.log('SECTORS:',(await g('#sector-card')).slice(0,200));
  console.log('CONF HISTORY:',await g('.cf-hist'));
  // notes feed the analysis
  await p.fill('#dash-notes','Expecting a bearish fade into lunch, tech weak.'); await p.waitForTimeout(1200);
  console.log('NOTES →',(await g('.an-ctx')));
  await p.fill('#dash-notes','');
  // refresh changes the timestamp
  const t1=await g('#analysis-wrap .section-label'); await p.click('#ai-refresh-btn'); await p.waitForTimeout(3500); console.log('REFRESH:',t1,'→',await g('#analysis-wrap .section-label'));
  await p.evaluate(()=>anSetSym('ES=F')); await p.waitForTimeout(300); console.log('ES head:',await g('.an-head'));
 }
 await p.locator('#page-dashboard').screenshot({path:__dirname+'/dash-'+name+'.png'});
 await p.click('.tab-btn:has-text("Lab")'); await p.evaluate(()=>labView('ce')); await p.waitForTimeout(1500);
 if(name==='desktop') console.log('LAB CE:',(await g('#lab-ce')).slice(0,600));
 await p.screenshot({path:__dirname+'/ce-'+name+'.png'});
 for(const v of ['hl','live','bt','sim','ce','sc','replay']){await p.evaluate(v=>labView(v),v);await p.waitForTimeout(400);}
 const btns=p.locator('.tab-btn');for(let i=0;i<await btns.count();i++){await btns.nth(i).click();await p.waitForTimeout(120);}
 const hs=await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
 console.log(name,'hscroll:',hs,'http errors:',bad.length,bad.join(','),'JS errors:',errs.length,errs.join(' | '));
}
await b.close();})();
