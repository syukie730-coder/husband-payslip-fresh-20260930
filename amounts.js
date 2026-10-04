// Values must occur literally in recognised text. No arithmetic, digit repair or fuzzy labels.
const aliases = {
  basic: ['基本給', '基本給与', '基本給料', '基本賃金', '基本給額'],
  gross: ['支給合計', '総支給額', '総支給合計', '支給総額', '総支給', '支給額合計', '支給計', '給与支給合計'],
  deductions: ['控除合計', '控除総額', '総控除額', '控除額合計', '総控除', '控除計'],
  net: ['振込支給額', '振込金額', '振込額', '銀行振込額', '銀行振込', '振込支給']
};
export const normalize = value => String(value || '').normalize('NFKC').replace(/[\s　]/g, '').replace(/[额给计总]/g, c => ({额:'額',给:'給',计:'計',总:'総'})[c]);
export function parsePrintedAmount(text) {
  const s = normalize(text).replace(/^[¥￥]/, '').replace(/円$/, '');
  // OCR commonly confuses the printed thousands comma with a period. Do not concatenate arbitrary strings.
  if (!/^(?:\d{1,10}|\d{1,3}(?:[,，.]\d{3}){1,3})$/.test(s)) return null;
  const value = Number(s.replace(/[,，.]/g, ''));
  return Number.isSafeInteger(value) && value <= 9999999999 ? value : null;
}
function box(item, id) {
  if (!Array.isArray(item.poly) || item.poly.length !== 4 || !item.poly.flat().every(Number.isFinite)) return null;
  const xs=item.poly.map(p=>p[0]), ys=item.poly.map(p=>p[1]);
  const x=Math.min(...xs), y=Math.min(...ys), right=Math.max(...xs), bottom=Math.max(...ys);
  return {...item,id,text:normalize(item.text),x,y,right,bottom,w:right-x,h:bottom-y,cx:(x+right)/2,cy:(y+bottom)/2};
}
function labelOf(text) {
  for (const [key, names] of Object.entries(aliases)) for (const name of [...names].sort((a,b)=>b.length-a.length)) {
    if (text===name || (text.startsWith(name) && parsePrintedAmount(text.slice(name.length).replace(/^[:：]/,''))!==null)) return {key,name,priority:key==='net'&&name.includes('振込')?2:1};
  }
  return null;
}
function mergedLabels(items) {
  const out=[];
  for (const first of items) {
    if (first.score<.82) continue;
    const neighbours=items.filter(b=>b.id!==first.id && b.x>first.x && Math.abs(b.cy-first.cy)<Math.max(b.h,first.h)*.55).sort((a,b)=>a.x-b.x);
    let text=first.text, previous=first, score=first.score, ids=[first.id];
    for (let n=0;n<6;n++) {
      const label=labelOf(text);
      if(label) { out.push({...first,...label,text,score,ids:[...ids],right:previous.right,w:previous.right-first.x,cx:(first.x+previous.right)/2});break; }
      const next=neighbours[n];
      if(!next || next.x-previous.right>Math.max(first.h,next.h)*1.6 || next.score<.82) break;
      text+=next.text;score=Math.min(score,next.score);ids.push(next.id);previous=next;
    }
  }
  return out;
}
export function amountCandidates(items) {
  const boxes=items.map(box).filter(Boolean), labels=mergedLabels(boxes), candidates=[];
  for(const label of labels) {
    const inline=label.text.slice(label.name.length).replace(/^[:：]/,'');
    if(inline && parsePrintedAmount(inline)!==null && label.ids.length===1) {
      candidates.push({key:label.key,value:parsePrintedAmount(inline),item:boxes.find(b=>b.id===label.id),label,priority:label.priority});continue;
    }
    const options=[];
    for(const number of boxes) {
      const value=parsePrintedAmount(number.text);
      if(value===null || number.score<.90 || label.ids.includes(number.id))continue;
      const h=Math.max(label.h,number.h,1), dy=number.y-label.bottom, dx=number.x-label.right;
      const yAligned=Math.abs(number.cy-label.cy)<h*.55;
      const overlap=Math.min(label.right,number.right)-Math.max(label.x,number.x);
      let distance;
      if(yAligned && dx>=-h*.15 && dx<=h*18) {
        if(boxes.some(b=>!label.ids.includes(b.id)&&b.id!==number.id&&b.x>label.right&&b.right<number.x&&Math.abs(b.cy-label.cy)<h*.55))continue;
        distance=Math.max(0,dx)/h+Math.abs(number.cy-label.cy)/h;
      } else if(dy>=-h*.1 && dy<=h*2.3 && overlap>Math.min(label.w,number.w)*.4) {
        if(labels.some(b=>b.id!==label.id&&b.cy>label.cy&&b.cy<number.cy&&Math.abs(b.cx-number.cx)<Math.max(b.w,number.w)*.5))continue;
        distance=Math.max(0,dy)/h+Math.abs(number.cx-label.cx)/Math.max(label.w,number.w);
      } else continue;
      options.push({key:label.key,value,item:number,label,priority:label.priority,distance});
    }
    options.sort((a,b)=>a.distance-b.distance);
    if(options.length && !(options[1] && options[1].value!==options[0].value && options[1].distance-options[0].distance<.3))candidates.push(options[0]);
  }
  return candidates;
}
export function printedMonth(text) {
  const s=normalize(text), matches=[];
  const re=/(令和|平成|昭和)?(元|\d{1,4})年(\d{1,2})月/g;
  for(const m of s.matchAll(re)) {
    let year=m[2]==='元'?1:Number(m[2]),month=Number(m[3]);
    if(m[1]){if(year<1||year>99)continue;year+=({令和:2018,平成:1988,昭和:1925})[m[1]];}
    else if(m[2].length!==4)continue;
    if(year>=1900 && year<=2200 && month>=1 && month<=12)matches.push(`${year}-${String(month).padStart(2,'0')}`);
  }
  // Western numeric dates are accepted only when explicitly preceded by a payroll date label.
  for(const m of s.matchAll(/(?:支給年月|給与年月|支給日|支払日)[:：]?(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?!\d)/g)) {
    if(+m[1]>=1900&&+m[1]<=2200&&+m[2]>=1&&+m[2]<=12)matches.push(`${m[1]}-${m[2].padStart(2,'0')}`);
  }
  return [...new Set(matches)];
}
export function monthCandidates(items) {
  const boxes=items.map(box).filter(Boolean), candidates=[];
  for(const b of boxes) {
    if(b.score<.90 || !/(支給年月|給与年月|支給日|支払日|給与|給料)/.test(b.text))continue;
    let row=[b];
    if(!printedMonth(b.text).length && /^(支給年月|給与年月|支給日|支払日)[:：]?$/.test(b.text)) {
      const next=boxes.filter(n=>n.x>b.x&&Math.abs(n.cy-b.cy)<Math.max(n.h,b.h)*.65).sort((a,c)=>a.x-c.x);
      for(const n of next) {if(n.x-row.at(-1).right>Math.max(n.h,b.h)*3||n.score<.85)break;row.push(n);if(printedMonth(row.map(x=>x.text).join('')).length)break;}
    }
    const months=printedMonth(row.map(x=>x.text).join(''));
    if(months.length===1)candidates.push({key:'month',value:months[0],item:{text:row.map(x=>x.text).join(''),score:Math.min(...row.map(x=>x.score)),poly:[[Math.min(...row.map(x=>x.x)),Math.min(...row.map(x=>x.y))],[Math.max(...row.map(x=>x.right)),Math.min(...row.map(x=>x.y))],[Math.max(...row.map(x=>x.right)),Math.max(...row.map(x=>x.bottom))],[Math.min(...row.map(x=>x.x)),Math.max(...row.map(x=>x.bottom))]]},priority:/支給日|支払日/.test(b.text)?2:1});
  }
  return candidates;
}
export function selectConfirmed(candidates) {
  const values={},evidence={};
  for(const key of ['month',...Object.keys(aliases)]) {
    const all=candidates.filter(c=>c.key===key && c.confirmed);
    if(!all.length)continue;
    const priority=Math.max(...all.map(c=>c.priority||1));
    const selected=all.filter(c=>(c.priority||1)===priority);
    if(new Set(selected.map(c=>c.value)).size!==1)continue;
    values[key]=selected[0].value;
    evidence[key]={text:selected[0].item.text,poly:selected[0].item.poly,score:selected[0].item.score};
  }
  return {values,evidence};
}
export function extractAmounts(data) {
  // Unverified OCR data intentionally produces no auto-filled amounts.
  return selectConfirmed(data?.candidates||[]).values;
}
