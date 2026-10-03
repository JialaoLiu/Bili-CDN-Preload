const {chromium}=require(process.env.BILI_PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.env.BILI_TEST_EXTENSION||path.join(__dirname,'../extension'));
const scripts=['vendor/core.js','vendor/cached-xhr.js','buffer-core.js','adaptive.js','i18n.js','player.js'];
function media(seed,chunk){const count=90,indexSize=32+12*count,b=Buffer.alloc(indexSize+count*chunk,seed);b.writeUInt32BE(indexSize);b.write('sidx',4);b.writeUInt32BE(0,8);b.writeUInt32BE(1,12);b.writeUInt32BE(1000,16);b.writeUInt32BE(0,20);b.writeUInt32BE(0,24);b.writeUInt16BE(0,28);b.writeUInt16BE(count,30);for(let i=0;i<count;i++){b.writeUInt32BE(chunk,32+i*12);b.writeUInt32BE(10000,36+i*12);b.writeUInt32BE(0x90000000,40+i*12);}return {b,indexSize};}
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.BILI_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const context=await browser.newContext(),calls=[],errors=[];
    const files={'hdr.m4s':media(125,262144),'sdr.m4s':media(120,262144),'audio.m4s':media(80,32768)};
    await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.hostname==='www.bilibili.com')return route.fulfill({contentType:'text/html',body:'<video></video>'});const file=files[u.pathname.split('/').pop()];if(!file)return route.abort();const h={'access-control-allow-origin':'*','access-control-expose-headers':'content-range,content-length'};if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{...h,'access-control-allow-headers':'range'}});const m=/bytes=(\d+)-(\d+)/.exec(req.headers().range||'');if(!m)throw new Error('expected finite range');const start=+m[1],end=+m[2];calls.push({name:u.pathname.split('/').pop(),host:u.hostname,start,end});await new Promise(r=>setTimeout(r,10));return route.fulfill({status:206,headers:{...h,'content-range':`bytes ${start}-${end}/${file.b.length}`,'content-type':'video/mp4'},body:file.b.subarray(start,end+1)});});
    await context.addInitScript({content:scripts.map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n;\n')});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://www.bilibili.com/video/BVHdrTest');
    assert.deepEqual(await page.evaluate(()=>{const s=document.querySelector('#bili-buffer-five-min').shadowRoot;return [s.getElementById('region').value,s.getElementById('parallelPlayback').checked];}),['mainland',true]);
    await page.evaluate(indexSize=>{Object.defineProperty(document.querySelector('video'),'duration',{value:900});const route=(name,id,codec)=>({id,codecs:codec,height:2160,baseUrl:'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/1/999/'+name,segment_base:{initialization:'0-7',index_range:'0-'+(indexSize-1)}});window.__playinfo__={data:{quality:125,dash:{video:[route('hdr.m4s',125,'hvc1.2.4.L156.90'),route('sdr.m4s',120,'av01.0.12M.08')],audio:[route('audio.m4s',30280,'mp4a.40.2')]}}};},files['hdr.m4s'].indexSize);
    const select=async name=>{await page.evaluate(name=>fetch('https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/1/999/'+name,{headers:{Range:'bytes=0-1023'}}).then(r=>r.arrayBuffer()),name);await page.waitForFunction(name=>{const s=document.querySelector('#bili-buffer-five-min').shadowRoot;return s.getElementById('videoBar').value===100&&s.getElementById('trackInfo').textContent.includes(name==='hdr.m4s'?'HEVC':'AV1');},name);};
    await select('hdr.m4s');assert.match(await page.locator('#trackInfo').textContent(),/HDR 真彩 · HEVC/);
    await select('sdr.m4s');assert.match(await page.locator('#trackInfo').textContent(),/AV1/);
    await select('hdr.m4s');assert.match(await page.locator('#trackInfo').textContent(),/HDR 真彩 · HEVC/);
    const start=20*1024*1024;
    const valid=await page.evaluate(async start=>{const url='https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/1/999/hdr.m4s';for(const offset of [0,262144]){const b=new Uint8Array(await fetch(url,{headers:{Range:`bytes=${start+offset}-${start+offset+524287}`}}).then(r=>r.arrayBuffer()));if(b.length!==524288||!b.every(x=>x===125))return false;}return true;},start);
    assert.equal(valid,true);const far=calls.filter(c=>c.name==='hdr.m4s'&&c.start>=start);assert.equal(far.reduce((n,c)=>n+c.end-c.start+1,0),786432,'returning to HDR must not retain an obsolete cache pool');
    await page.evaluate(()=>{const s=document.querySelector('#bili-buffer-five-min').shadowRoot;s.getElementById('parallelPlayback').checked=false;s.getElementById('parallelPlayback').dispatchEvent(new Event('change'));s.getElementById('region').value='overseas';s.getElementById('region').dispatchEvent(new Event('change'));});await page.reload();
    assert.deepEqual(await page.evaluate(()=>{const s=document.querySelector('#bili-buffer-five-min').shadowRoot;return [s.getElementById('region').value,s.getElementById('parallelPlayback').checked];}),['overseas',false]);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({hdrMetadataAndRequests:'PASS',qualitySwitch:'HDR→SDR→HDR',overlapDownloaded:786432,defaults:'mainland + parallel',laterPreferencesPreserved:true,displayHDRTested:false}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
