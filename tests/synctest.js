const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1280,height:900}],['phone',{width:390,height:844}]]){
 const p=await b.newPage({viewport:vp}); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(5000);
 await p.click('#sync-pill'); await p.waitForTimeout(300);
 const open=await p.evaluate(()=>!document.getElementById('sync-modal').hidden);
 await p.fill('#sync-input','definitely-wrong-key'); await p.click('button:has-text("Save & sync")'); await p.waitForTimeout(4000);
 const wrong=await p.evaluate(()=>({msg:document.getElementById('sync-msg').textContent,pill:document.getElementById('sync-label').textContent}));
 await p.screenshot({path:__dirname+'/sync-wrong-'+name+'.png'});
 // simulate the correct key: the Worker answers 200 with an empty store
 await p.route('**/sync',r=>r.request().headers()['x-sync-key']==='right-key-123'?r.fulfill({status:200,body:'{}',headers:{'content-type':'application/json','access-control-allow-origin':'*'}}):r.fulfill({status:401,body:'{"error":"wrong sync key"}',headers:{'content-type':'application/json','access-control-allow-origin':'*'}}));
 await p.fill('#sync-input','right-key-123'); await p.click('button:has-text("Save & sync")'); await p.waitForTimeout(2500);
 const right=await p.evaluate(()=>({msg:document.getElementById('sync-msg').textContent,pill:document.getElementById('sync-label').textContent,closed:document.getElementById('sync-modal').hidden}));
 console.log(name,'opened:',open,'| wrong:',JSON.stringify(wrong),'| right:',JSON.stringify(right),'| JS errors:',errs.length,errs.join('|'));
 await p.close();
}
await b.close();})();
