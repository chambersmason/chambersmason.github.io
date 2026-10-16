/* First-party visit log for masonchambers.com: no cookies, nothing sent to third parties. */
(function(){
  try{
    var id='';try{id=sessionStorage.getItem('mc_s')||'';if(!id){id=Math.random().toString(36).slice(2,10);sessionStorage.setItem('mc_s',id)}}catch(e){}
    var pv=Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4), t0=Date.now(), seen=0, sc=0, done=0;
    function send(t,x){var d={t:t,pv:pv,sid:id,p:location.pathname,h:location.host};for(var k in x)d[k]=x[k];
      var b=JSON.stringify(d);if(!(navigator.sendBeacon&&navigator.sendBeacon('/_v',b)))fetch('/_v',{method:'POST',body:b,keepalive:true})}
    send('view',{r:document.referrer,q:location.search,w:screen.width,hgt:screen.height,
      tz:(Intl.DateTimeFormat().resolvedOptions().timeZone||''),l:navigator.language||''});
    if(/[?&]ref=qr\b/.test(location.search)&&history.replaceState)history.replaceState(null,'',location.pathname+location.hash);
    addEventListener('scroll',function(){var h=document.documentElement,m=h.scrollHeight-innerHeight;
      sc=Math.max(sc,m>0?Math.round(100*scrollY/m):100)},{passive:true});
    document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');
      if(a)send('click',{href:a.href,text:(a.textContent||'').trim().slice(0,80)})},true);
    function leave(force){if((force||document.visibilityState==='hidden')&&!done){done=1;send('leave',{ms:Date.now()-t0,sc:sc})}
      else if(document.visibilityState==='visible'){done=0}}
    document.addEventListener('visibilitychange',function(){leave()});addEventListener('pagehide',function(){leave(1)});
  }catch(e){}
})();
