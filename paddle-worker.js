import { PaddleOCR } from './vendor/paddle/sdk.mjs';
import { amountCandidates, monthCandidates, parsePrintedAmount, printedMonth, selectConfirmed, normalize } from './amounts.js';

let started=false;
function rectified(cv,source,poly) {
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const width=Math.max(2,Math.round(Math.max(distance(poly[0],poly[1]),distance(poly[3],poly[2]))));
  const height=Math.max(2,Math.round(Math.max(distance(poly[0],poly[3]),distance(poly[1],poly[2]))));
  const from=cv.matFromArray(4,1,cv.CV_32FC2,poly.flat()),to=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,width-1,0,width-1,height-1,0,height-1]);
  const transform=cv.getPerspectiveTransform(from,to),out=new cv.Mat();
  try { cv.warpPerspective(source,out,transform,new cv.Size(width,height),cv.INTER_CUBIC,cv.BORDER_REPLICATE);return out; }
  finally { from.delete();to.delete();transform.delete(); }
}
function contrast(mat) {
  // Local contrast of the observed pixels only. No generated characters or numbers.
  const d=mat.data,channels=mat.channels(),hist=new Uint32Array(256);
  for(let i=0;i<d.length;i+=channels)hist[Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2])]++;
  const total=mat.rows*mat.cols;
  const percentile=q=>{let count=0;for(let i=0;i<256;i++){count+=hist[i];if(count>=total*q)return i;}return 255;};
  const lo=percentile(.015),hi=percentile(.98);
  if(hi-lo<25)return;
  for(let i=0;i<d.length;i+=channels){const v=Math.max(0,Math.min(255,(.299*d[i]+.587*d[i+1]+.114*d[i+2]-lo)*255/(hi-lo)));d[i]=d[i+1]=d[i+2]=v;}
}
self.onmessage=async({data})=>{
  if(started)return;started=true;
  const send=(type,extra={})=>postMessage({type,job:data.job,...extra});
  let ocr,source;
  let phase="OCR部品の準備";
  const diagnostic=value=>{try{send("diagnostic",{value});}catch{}};
  try {
    const assets=new URL('./vendor/paddle/',import.meta.url).href;
    const localFetch=(url,options)=>{
      const target=new URL(url,location.href);
      if(target.origin!==location.origin || (options?.method&&options.method!=='GET') || options?.body)throw new Error('非対応の通信');
      return fetch(target.href,{...options,credentials:'omit'});
    };
    send('progress',{text:'端末内の読み取り準備中です。初回は約48MBの部品を読み込みます…'});
    ocr=await PaddleOCR.create({
      textDetectionModelName:'PP-OCRv5_mobile_det',textRecognitionModelName:'PP-OCRv6_small_rec',
      textDetectionModelAsset:{url:assets+'PP-OCRv5_mobile_det_onnx_infer.tar'},
      textRecognitionModelAsset:{url:assets+'PP-OCRv6_small_rec_onnx_infer.tar'},
      textRecognitionBatchSize:1,textDetectionBatchSize:1,
      ortOptions:{backend:'wasm',numThreads:1,proxy:false,wasmPaths:assets},fetch:localFetch
    });
    ocr.ort.env.logLevel='error';
    const cv=ocr.cv;
    source=cv.matFromImageData(new ImageData(new Uint8ClampedArray(data.pixels),data.width,data.height));
    send('progress',{text:'文字の位置と傾きを調べ、1行ずつ読み取っています…'});
    const start=performance.now();
    phase="文字の検出・認識";
    const [result]=await ocr.predict(source,{textDetLimitSideLen:1280,textDetLimitType:'max',textDetUnclipRatio:2.0,textRecScoreThresh:.5});
    const candidates=[...monthCandidates(result.items),...amountCandidates(result.items)];
    const verified=new Map();
    const traces=new Map(candidates.map(c=>[c,{key:c.key,label:c.label?.name||"年月",text:c.item.text,score:c.item.score,value:c.value,reason:"確認上限（30候補）により未確認"}]));
    phase="候補の再読取";
    // Bounded verification work keeps dense documents from creating unbounded loops.
    for(const candidate of candidates.slice(0,30)) {
      // Require actual source detail, not enlarged pixels. The recognizer normalizes
      // lines to 48px; very small originals can confidently repeat a wrong digit.
      const p=candidate.item.poly;
      const height=Math.min(Math.hypot(p[3][0]-p[0][0],p[3][1]-p[0][1]),Math.hypot(p[2][0]-p[1][0],p[2][1]-p[1][1]));
      const trace=traces.get(candidate);trace.height=Math.round(height*10)/10;
      if(height<32){trace.reason="文字の高さが32px未満";continue;}
      const id=JSON.stringify(candidate.item.poly);
      if(!verified.has(id)) {
        send('progress',{text:'読めた年月と金額を、元の画像でもう一度確認しています…'});
        const crop=rectified(cv,source,candidate.item.poly);
        try { contrast(crop); const [check]=await ocr.recModel.predict(cv,[crop]);verified.set(id,check); }
        finally {crop.delete();}
      }
      const check=verified.get(id);
      trace.checkText=check?.text;trace.checkScore=check?.score;
      if(!check || check.score<.90){trace.reason="再読取の確信度が0.90未満、または結果なし";continue;}
      if(candidate.key==='month')candidate.confirmed=printedMonth(check.text).length===1 && printedMonth(check.text)[0]===candidate.value;
      else {
        let text=normalize(check.text);
        if(candidate.label && text.startsWith(candidate.label.name))text=text.slice(candidate.label.name.length).replace(/^[:：]/,'');
        candidate.confirmed=parsePrintedAmount(text)===candidate.value;
      }
      trace.reason=candidate.confirmed?"再読取一致（正確さの保証ではありません）":"初回と再読取の値が不一致・解釈不可";
    }
    const output=selectConfirmed(candidates);
    diagnostic({phase:"OCR完了",width:data.width,height:data.height,fields:Object.fromEntries(['month','basic','gross','deductions','net'].map(key=>[key,{accepted:output.values[key]!==undefined,value:output.values[key],reason:output.values[key]!==undefined?"採用（原本との照合が必要）":!candidates.some(c=>c.key===key)?"候補なし：項目名・位置・初回確信度のどこで不成立かは検出文字を参照":"候補を除外、または同順位の値が競合",candidates:[...traces.values()].filter(c=>c.key===key)}])),items:result.items.slice(0,300).map(i=>({text:i.text,score:i.score,poly:i.poly})),totalItems:result.items.length});
    send('done',{value:{...output,metrics:{elapsedMs:Math.round(performance.now()-start),boxes:result.items.length,verified:verified.size,backend:'wasm-single-thread'}}});
  } catch(error) {
    diagnostic({phase:phase+'で処理エラー'});
    send('error',{code:'OCR_FAILED'});
  } finally {
    source?.delete();
    try {await ocr?.dispose();}catch{}
  }
};
