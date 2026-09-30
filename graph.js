export function renderChart(target,records){
 target.replaceChildren();if(!records.length){const p=document.createElement('p');p.className='empty';p.textContent='明細を保存すると、ここにグラフが表示されます。';target.append(p);return;}
 const totals=new Map();for(const r of records)totals.set(r.month,(totals.get(r.month)||0)+r.net);const months=[...totals].sort((a,b)=>a[0].localeCompare(b[0])),max=Math.max(1,...months.map(x=>x[1]));
 const note=document.createElement('p');note.className='hint';note.textContent='同じ月の明細が複数ある場合は合計します。';target.append(note);
 for(const [month,value] of months){const row=document.createElement('div');row.className='chart-row';const label=document.createElement('div');label.className='chart-label';const m=document.createElement('span');m.textContent=month.replace('-','年')+'月';const v=document.createElement('strong');v.textContent=value.toLocaleString('ja-JP')+' 円';label.append(m,v);const track=document.createElement('div');track.className='bar-track';track.setAttribute('aria-hidden','true');const bar=document.createElement('div');bar.className='bar';bar.style.width=(value/max*100)+'%';track.append(bar);row.append(label,track);target.append(row);}
}
