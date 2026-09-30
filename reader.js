function abortError(){return new DOMException('中止しました','AbortError');}
function isolated(kind,payload,signal,onProgress,timeout){return new Promise((resolve,reject)=>{
 if(signal.aborted){reject(abortError());return;}const frame=document.createElement('iframe');frame.hidden=true;frame.src=new URL(kind==='heic'?'./heic-frame.html':'./processing-frame.html',import.meta.url).href;frame.title='写真の端末内処理';const job=crypto.randomUUID();let finished=false;
 const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',message);signal.removeEventListener('abort',abort);frame.remove();};
 const finish=(error,value)=>{if(finished)return;finished=true;cleanup();error?reject(error):resolve(value);};
 const abort=()=>finish(abortError());const timer=setTimeout(()=>finish(new Error('処理が時間内に終わりませんでした')),timeout);
 function message(e){if(e.source!==frame.contentWindow||e.origin!==location.origin)return;const d=e.data;if(d?.type==='ready'){frame.contentWindow.postMessage({kind,payload,job},location.origin);return;}if(d?.job!==job)return;if(d.type==='progress')onProgress?.(d.text);if(d.type==='done')finish(null,d.value);if(d.type==='error')finish(new Error('写真を処理できませんでした'));}
 window.addEventListener('message',message);signal.addEventListener('abort',abort,{once:true});frame.onerror=()=>finish(new Error('読み込みに失敗しました'));document.body.append(frame);
 });}
function decode(blob,signal){return new Promise((resolve,reject)=>{if(signal.aborted){reject(abortError());return;}const img=new Image(),url=URL.createObjectURL(blob);const clean=()=>{clearTimeout(timer);URL.revokeObjectURL(url);signal.removeEventListener('abort',abort);img.onload=null;img.onerror=null;};const abort=()=>{clean();img.src='';reject(abortError());};const timer=setTimeout(()=>{clean();img.src='';reject(new Error('画像を開けません'));},12000);img.onload=()=>{clean();resolve(img);};img.onerror=()=>{clean();reject(new Error('非対応の画像'));};signal.addEventListener('abort',abort,{once:true});img.src=url;});}
function imageDataURL(img,maxEdge,quality){
 const ratio=Math.min(1,maxEdge/Math.max(img.naturalWidth,img.naturalHeight));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*ratio));c.height=Math.max(1,Math.round(img.naturalHeight*ratio));const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,c.width,c.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(img,0,0,c.width,c.height);const result=c.toDataURL('image/jpeg',quality);c.width=c.height=1;return result;
}
export async function prepareImage(file,signal){
 if(file.size>50*1024*1024)throw new Error('画像が大きすぎます');let blob=file,img;
 try{img=await decode(blob,signal);}catch(e){if(signal.aborted)throw e;const header=new TextDecoder('latin1').decode(await file.slice(0,80).arrayBuffer());if(!/\.hei[cf]$/i.test(file.name)&&!/hei[cf]/i.test(file.type)&&!/ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(header))throw e;blob=await isolated('heic',file,signal,null,45000);img=await decode(blob,signal);}
 if(signal.aborted)throw abortError();if(!img.naturalWidth||!img.naturalHeight)throw new Error('空の画像');return {storedImage:imageDataURL(img,2200,.86),ocrImage:imageDataURL(img,3400,.92)};
}
export async function recognize(image,signal,onProgress){const data=await isolated('ocr',image,signal,onProgress,150000);const {extractAmounts}=await import('./amounts.js');return extractAmounts(data);}
