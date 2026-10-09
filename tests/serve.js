// node serve.js <dir> <port>  — minimal static server for tests
const http=require('http'),fs=require('fs'),path=require('path');
const root=path.resolve(process.argv[2]),port=+process.argv[3]||8090;
const types={'.html':'text/html','.json':'application/json','.jpg':'image/jpeg','.js':'text/javascript','.mjs':'text/javascript'};
http.createServer((q,r)=>{const p=path.join(root,decodeURIComponent(q.url.split('?')[0]).replace(/\/$/,'/index.html'));
 if(!p.startsWith(root)||!fs.existsSync(p)){r.writeHead(404);return r.end();}
 r.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});fs.createReadStream(p).pipe(r);}).listen(port,()=>console.log('serving '+root+' on '+port));
