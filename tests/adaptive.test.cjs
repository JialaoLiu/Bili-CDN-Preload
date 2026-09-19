const {test}=require('node:test');const assert=require('node:assert/strict');
require('../extension/adaptive.js');
test('probes before exhaustion, not after a stall',()=>{
 const a=new BiliAdaptive();for(let i=0;i<=8;i++)a.observe(i*1000,45,i,false);
 assert(a.risk);assert.equal(a.choose(['slow','fast'],8000,true).probe,true);
 assert.equal(a.choose(['slow','fast'],9000,true).probe,false);
});
test('two full samples, smoothing and switch margin prevent one-off promotion',()=>{
 const a=new BiliAdaptive();a.champion='slow';a.risk=true;
 a.record('slow',1048576,2000,20000);a.record('slow',1048576,2000,21000);
 a.record('fast',1048576,500,22000);
 assert.equal(a.choose(['slow','fast'],23000,false).host,'slow');
 a.record('fast',1048576,500,24000);
 assert.equal(a.choose(['slow','fast'],25000,false).host,'fast');
 a.record('slow',1048576,10,26000);a.record('slow',1048576,10,27000);
 assert.equal(a.choose(['slow','fast'],28000,false).host,'fast');
});
test('full cache, seek reset, stale samples and probe disable',()=>{
 const a=new BiliAdaptive();for(let i=0;i<=15;i++)a.observe(i*1000,20,i,false);
 assert(a.risk);a.observe(16000,300,16,true);assert(!a.risk);
 a.observe(17000,5,500,false);assert(!a.risk);
 a.risk=true;assert(!a.choose(['a','b'],30000,false).probe);
 a.record('b',1000000,100,1);a.record('b',1000000,100,2);assert.equal(a.score('b',130000),0);
});
test('a brief buffer recovery does not strand the second confirmation sample',()=>{
 const a=new BiliAdaptive();a.risk=true;
 assert.equal(a.choose(['a','b'],10000,true).host,'b');
 a.record('b',1048576,200,10100);a.risk=false;
 assert.deepEqual(a.choose(['a','b'],16000,true),{host:'b',probe:true});
});
