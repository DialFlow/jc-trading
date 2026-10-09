const { chromium } = require('playwright'); const path=require('path'), D=process.env.DATA_DIR;
(async()=>{const b=await chromium.launch({channel:'msedge'});
for (const [name,vp] of [['desktop',{width:1280,height:900}],['phone',{width:390,height:844}]]){
 const p=await b.newPage({viewport:vp,colorScheme:'dark'}); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.route('**/data/*.json*',r=>{const f=r.request().url().match(/data\/(\w+)\.json/)[1];r.fulfill({path:path.join(D,f+'.json'),headers:{'access-control-allow-origin':'*','content-type':'application/json'}})});
 await p.goto('http://localhost:8090/'); await p.waitForTimeout(6000);
 if(name==='desktop'){
  const unit=await p.evaluate(()=>{
    const R=(o)=>({target:3000,mll:2000,trail:'eod',lock:100,dll:0,cons:0,minDays:1,buffer:2100,minPayout:500,maxPayout:0,split:0.9,wait:1,cycleCons:0,cycleDays:0,...o});
    const one=(trades,rules,stage='eval',days=10)=>simAccount({list:trades,pTrade:1},20,rules,'full',1,days,1,false,stage);
    const out={};
    // A: closes +50 pts but dips 110 pts ($2,200) on the way: fails mid-trade under the $2,000 max loss
    let x=one([{pts:50,mfe:60,mae:110}],R({}),'eval',1); out.A_dipFailsMidTrade = x.fail===1&&x.failMid===1;
    // B: loser that first runs +100 pts ($2,000) then stops −80: intraday trailing fails, EOD survives
    const tB=[{pts:-80,mfe:100,mae:80}];
    out.B_intradayFails = one(tB,R({trail:'intraday'}),'eval',1).fail===1;
    out.B_eodSurvives = one(tB,R({trail:'eod'}),'eval',1).fail===0;
    // C: +125 pts/day = +$2,495 → floor locks at +100; a later −$2,000 day (balance 495) survives, a −$2,500 (−5) fails
    const seq=(arr,rules)=>{let i=0;return simAccount({list:{get length(){return 1},0:null},pTrade:1},20,rules,'full',1,arr.length,1,false,'funded');};
    // simpler: deterministic list through Math.random override
    const det=(arr,rules,stage)=>{const real=Math.random;let k=0;Math.random=()=>{const v=(k%2===0)?0:(arr.length? (Math.floor(k/2)%arr.length)/arr.length+1e-9:0);k++;return v;};const r=simAccount({list:arr,pTrade:1},20,rules,'full',1,arr.length,1,false,stage);Math.random=real;return r;};
    out.C_lockSurvive = det([{pts:125,mfe:125,mae:0},{pts:-100,mfe:0,mae:100}],R({target:99999}),'eval').fail===0;
    out.C_lockFail = det([{pts:125,mfe:125,mae:0},{pts:-125,mfe:0,mae:125}],R({target:99999}),'eval').fail===1;
    // D: consistency 30%: one +$3,000 day can't pass alone
    out.D_consBlocks = det([{pts:151,mfe:151,mae:0}],R({cons:0.3}),'eval').pass===0;
    out.D_noConsPasses = det([{pts:151,mfe:151,mae:0}],R({cons:0}),'eval').pass===1;
    // E: funded payout: +$2,700 → withdraw $600 above the $2,100 buffer → 90% = $540
    const e=det([{pts:135.25,mfe:135.25,mae:0}],R({}),'funded'); out.E_payout = Math.round(e.payAvg)===540;
    return out;});
  console.log('UNIT:',JSON.stringify(unit));
 }
 await p.click('.tab-btn:has-text("Lab")'); await p.evaluate(()=>labView('sim')); await p.waitForTimeout(3500);
 const res={};
 for(const key of ['rapid','rapidEod','builder','pro']) for(const stage of ['eval','funded']){
   await p.evaluate(([k,s])=>{savePlan({key:k,stage:s,over:{}});simPlanForm();simRun();},[key,stage]); await p.waitForTimeout(400);
   res[key+'/'+stage]=await p.evaluate(()=>[...document.querySelectorAll('#sim-out .stat-tile')].slice(0,3).map(t=>t.querySelector('.stat-eyebrow').textContent+' '+t.querySelector('.stat-value').textContent+' ('+t.querySelector('.stat-sub').textContent+')').join(' | '));
 }
 await p.evaluate(()=>{savePlan({key:'rapid',stage:'eval',over:{}});simPlanForm();simRun();});
 if(name==='desktop'){for(const [k,v] of Object.entries(res))console.log(k.padEnd(16),v);
  console.log('LADDER rapid eval:',await p.evaluate(()=>[...document.querySelectorAll('#sim-out .bt-table tr')].slice(1).map(r=>r.innerText.replace(/\s+/g,' ')).join(' || ')));}
 await p.screenshot({path:__dirname+'/sim-'+name+'.png'});
 await p.evaluate(()=>labView('hl')); await p.waitForTimeout(2000);
 if(name==='desktop') console.log('HL survival:',await p.evaluate(()=>[...document.querySelectorAll('.hl-post')].find(a=>/survival/i.test(a.innerText))?.innerText.replace(/\s+/g,' ').slice(0,300)));
 for(const v of ['hl','live','bt','sim','ce','sc','replay']){await p.evaluate(v=>labView(v),v);await p.waitForTimeout(300);}
 const btns=p.locator('.tab-btn');for(let i=0;i<await btns.count();i++){await btns.nth(i).click();await p.waitForTimeout(100);}
 console.log(name,'hscroll:',await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),'JS errors:',errs.length,errs.join(' | '));
}
await b.close();})();
