'use strict';

function library(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('timeout')), 15000);
    script.src = src;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
    document.head.append(script);
  });
}

let started=false;
window.addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||started)return;
 const {kind,payload,job}=event.data||{};if(kind!=='heic')return;started=true;
 const send=(type,extra={})=>parent.postMessage({type,job,...extra},location.origin);
 try{await library('./vendor/heic2any.min.js');const result=await heic2any({blob:payload,toType:'image/jpeg',quality:.94});send('done',{value:Array.isArray(result)?result[0]:result});}
 catch{send('error');}
});
parent.postMessage({type:'ready'},location.origin);
