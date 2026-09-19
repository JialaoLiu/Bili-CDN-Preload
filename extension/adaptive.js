(function(root){
  'use strict';
  class Adaptive {
    constructor(){this.samples=new Map();this.champion='';this.challenger='';this.cursor=0;this.nextProbe=0;this.lastSwitch=0;this.history=[];this.risk=false;this.reason='观察缓存增长';}
    observe(now,ahead,position,complete){
      const last=this.history.at(-1);
      if(last && Math.abs(position-last.position)>Math.max(10,(now-last.now)/1000*3))this.history=[];
      this.history.push({now,ahead,position});
      while(this.history.length>1 && now-this.history[0].now>15000)this.history.shift();
      const first=this.history[0],elapsed=(now-first.now)/1000;
      const growth=elapsed>0?(ahead-first.ahead)/elapsed:0;
      this.risk=!complete && elapsed>=8 && (ahead<60 || (elapsed>=12 && ahead<240 && growth<0.25));
      this.reason=complete?'目标缓存已完成':this.risk?'缓存余量或增长不足，提前探测':'缓存增长正常';
    }
    score(host,now){const s=this.samples.get(host);return s && now-s.at<120000 && s.count>=2?s.rate:0;}
    record(host,bytes,ms,now){
      if(bytes<262144 || ms<=0)return;
      const rate=bytes*8/ms/1000,old=this.samples.get(host);
      const fresh=old && now-old.at<120000;
      this.samples.set(host,{rate:fresh?old.rate*0.65+rate*0.35:rate,count:fresh?old.count+1:1,at:now});
    }
    choose(hosts,now,allowProbe){
      if(!hosts.length)return null;
      if(!hosts.includes(this.champion))this.champion=hosts[0];
      const current=this.score(this.champion,now);
      const best=hosts.slice().sort((a,b)=>this.score(b,now)-this.score(a,now))[0];
      if(best!==this.champion && this.score(best,now)>Math.max(current*1.3,0.5) && now-this.lastSwitch>=20000){
        this.champion=best;this.lastSwitch=now;this.reason='连续分片表现更好，已调整线路';
      }
      const pending=this.samples.get(this.challenger);
      const confirm=pending?.count===1 && now-pending.at<120000;
      // Finish the second sample even if the first block briefly lifts the buffer
      // above the trigger threshold. Otherwise a good candidate never qualifies.
      if((this.risk || confirm) && allowProbe && now>=this.nextProbe && hosts.length>1){
        const alternatives=hosts.filter(h=>h!==this.champion);
        if(!alternatives.includes(this.challenger) || this.score(this.challenger,now)>0)this.challenger=alternatives[this.cursor++%alternatives.length];
        this.nextProbe=now+6000;
        return {host:this.challenger,probe:true};
      }
      return {host:this.champion,probe:false};
    }
    fail(host){this.samples.delete(host);if(this.challenger===host)this.challenger='';}
  }
  root.BiliAdaptive=Adaptive;
})(globalThis);
