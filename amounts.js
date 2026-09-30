const labels = {
  basic: ['基本給', '基本賃金', '基本給与', '基本給料', '基本給額'],
  gross: ['支給合計', '総支給額', '総支給合計', '支給総額', '総支給', '支給額合計', '支給計', '給与支給合計'],
  deductions: ['控除合計', '控除総額', '総控除額', '控除額合計', '総控除', '控除計'],
  net: ['振込支給額', '差引支給額', '差引支給', '振込金額', '振込額', '銀行振込額', '銀行振込', '振込支給', '手取額', '手取り額', '差引支給金額']
};
const allLabels = Object.values(labels).flat().sort((a, b) => b.length - a.length);
const normalize = value => String(value || '').normalize('NFKC').replace(/[\s　・:：/／()（）［］\[\]【】]/g, '');

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

function identifyLabel(text) {
  const clean = normalize(text);
  for (const [key, aliases] of Object.entries(labels)) {
    for (const alias of aliases) {
      if (clean.includes(alias)) return { key, alias, quality: 1 };
      if (clean.length >= alias.length - 1 && clean.length <= alias.length + 1 && alias.length >= 5 && editDistance(clean, alias) <= 1) return { key, alias, quality: .78 };
    }
  }
  return null;
}

function numericValue(value) {
  let text = String(value || '').normalize('NFKC').replace(/[¥￥円\s]/g, '');
  if (!/[0-9]/.test(text)) return null;
  text = text.replace(/[Oo〇○]/g, '0').replace(/[Il|｜]/g, '1').replace(/[，．。､、]/g, ',').replace(/[^0-9,.-]/g, '');
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length < 3 || digits.length > 10) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) && number <= 9999999999 ? number : null;
}

function wordsFromTsv(pass, passIndex) {
  if (!pass.tsv) return [];
  const words = [];
  for (const line of String(pass.tsv).trim().split('\n').slice(1)) {
    const columns = line.split('\t');
    if (columns[0] !== '5' || !columns[11]?.trim()) continue;
    const x = Number(columns[6]), y = Number(columns[7]), w = Number(columns[8]), h = Number(columns[9]);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const text = normalize(columns.slice(11).join('\t'));
    if (!text || /^[|｜]+$/.test(text)) continue;
    words.push({ text, x, y, w, h, right: x + w, bottom: y + h, cx: x + w / 2, cy: y + h / 2, conf: Math.max(0, Number(columns[10]) || 0), line: columns.slice(1, 5).join('-'), pass: passIndex });
  }
  return words;
}

function mergeLineWords(words) {
  const groups = new Map();
  for (const word of words) {
    const key = `${word.pass}-${word.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  const merged = [];
  for (const line of groups.values()) {
    line.sort((a, b) => a.x - b.x);
    for (let start = 0; start < line.length; start++) {
      let text = '';
      for (let end = start; end < Math.min(line.length, start + 4); end++) {
        const word = line[end];
        if (end > start && word.x - line[end - 1].right > Math.max(word.h, line[end - 1].h) * 2.4) break;
        text += word.text;
        const selected = line.slice(start, end + 1), first = selected[0];
        merged.push({ text, x: first.x, y: Math.min(...selected.map(item => item.y)), right: word.right, bottom: Math.max(...selected.map(item => item.bottom)), w: word.right - first.x, h: Math.max(...selected.map(item => item.h)), cx: (first.x + word.right) / 2, cy: (first.cy + word.cy) / 2, conf: Math.min(...selected.map(item => item.conf)), line: first.line, pass: first.pass });
      }
    }
  }
  return merged;
}

function spatialCandidates(pass, passIndex) {
  const merged = mergeLineWords(wordsFromTsv(pass, passIndex));
  const hits = [], numbers = [];
  for (const item of merged) {
    const label = identifyLabel(item.text);
    if (label) hits.push({ ...item, ...label });
    const value = numericValue(item.text);
    if (value !== null) numbers.push({ ...item, value });
  }
  const uniqueHits = hits.filter((hit, index) => !hits.some((other, otherIndex) => otherIndex !== index && other.key === hit.key && other.pass === hit.pass && other.x <= hit.x && other.right >= hit.right && other.w < hit.w));
  const uniqueNumbers = numbers.filter((number, index) => !numbers.some((other, otherIndex) => otherIndex !== index && other.pass === number.pass && other.line === number.line && other.x <= number.x && other.right >= number.right && other.w < number.w));
  const output = [];
  for (const hit of uniqueHits) {
    const size = Math.max(12, hit.h);
    for (const number of uniqueNumbers) {
      if (number.pass !== hit.pass || number.value < 100) continue;
      const vertical = Math.abs(number.cy - hit.cy), horizontal = number.x - hit.right;
      const overlap = Math.max(0, Math.min(hit.right, number.right) - Math.max(hit.x, number.x));
      const centerDistance = Math.abs(number.cx - hit.cx);
      let score = -Infinity;
      if (vertical <= size * 1.05 && horizontal >= -size * .35) score = 132 - Math.max(0, horizontal) / size * 2 - vertical / size * 9;
      else if (number.y >= hit.bottom - size * .2 && number.y - hit.bottom <= size * 36 && (overlap > 0 || centerDistance <= Math.max(hit.w, number.w) * .72)) score = 112 - (number.y - hit.bottom) / size * .35 - centerDistance / Math.max(hit.w, number.w) * 16;
      else if (vertical <= size * 1.05 && number.right <= hit.x + size * .35) score = 72 - (hit.x - number.right) / size - vertical / size * 8;
      if (Number.isFinite(score)) output.push({ key: hit.key, value: number.value, score: score * hit.quality + Math.min(8, number.conf / 14), pass: passIndex, x: number.x, y: number.y });
    }
  }
  return output;
}

function textCandidates(pass, passIndex) {
  const output = [], lines = String(pass.text || '').split('\n').map(normalize).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const [key, aliases] of Object.entries(labels)) {
      const alias = aliases.find(label => lines[i].includes(label));
      if (!alias) continue;
      let tail = lines[i].slice(lines[i].indexOf(alias) + alias.length);
      const next = allLabels.map(label => tail.indexOf(label)).filter(index => index >= 0).sort((a, b) => a - b)[0];
      if (next !== undefined) tail = tail.slice(0, next);
      let value = numericValue(tail);
      if (value === null && next === undefined && lines[i + 1] && !identifyLabel(lines[i + 1])) value = numericValue(lines[i + 1]);
      if (value !== null) output.push({ key, value, score: 55, pass: passIndex, x: 0, y: i });
    }
  }
  return output;
}

function choose(candidates) {
  const choices = {};
  for (const key of Object.keys(labels)) {
    const seen = new Set();
    choices[key] = candidates.filter(item => item.key === key).sort((a, b) => b.score - a.score).filter(item => {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    }).slice(0, 5);
    choices[key].push(null);
  }
  let best = { score: -Infinity, values: {} };
  for (const basic of choices.basic) for (const gross of choices.gross) for (const deductions of choices.deductions) for (const net of choices.net) {
    const selected = { basic, gross, deductions, net }, present = Object.values(selected).filter(Boolean);
    let score = present.reduce((sum, item) => sum + item.score, 0) + present.length * 18;
    if (gross && deductions && net) {
      const difference = Math.abs(gross.value - deductions.value - net.value), allowance = Math.max(1500, gross.value * .012);
      score += difference <= allowance ? 180 : -Math.min(90, difference / allowance * 14);
    }
    if (basic && gross) {
      const ratio = basic.value / gross.value;
      score += basic.value <= gross.value ? 24 : -55;
      score += ratio >= .35 && ratio <= 1 ? 36 : -12;
    }
    const used = new Set();
    for (const item of present) {
      const id = `${item.pass}-${Math.round(item.x)}-${Math.round(item.y)}-${item.value}`;
      if (used.has(id)) score -= 100;
      used.add(id);
    }
    if (score > best.score) best = { score, values: Object.fromEntries(Object.entries(selected).filter(([, item]) => item).map(([key, item]) => [key, item.value])) };
  }
  return best.values;
}

function arithmeticFallback(passes) {
  const boxes = [];
  passes.forEach((pass, passIndex) => {
    for (const item of mergeLineWords(wordsFromTsv(pass, passIndex))) {
      const value = numericValue(item.text);
      if (value !== null && value >= 1000 && value <= 20000000) boxes.push({ ...item, value });
    }
  });
  const byValue = new Map();
  for (const box of boxes) if (!byValue.has(box.value) || box.conf > byValue.get(box.value).conf) byValue.set(box.value, box);
  const unique = [...byValue.values()].slice(0, 180);
  let best = null;
  for (const gross of unique) for (const deductions of unique) {
    if (gross === deductions || gross.value < 50000 || gross.value <= deductions.value || deductions.value < 3000) continue;
    if (deductions.value < gross.value * .05) continue;
    for (const net of unique) {
      if (net === gross || net === deductions) continue;
      const difference = Math.abs(gross.value - deductions.value - net.value);
      const allowance = Math.max(8, gross.value * .0015);
      if (difference > allowance) continue;
      if (net.value < 30000) continue;
      const basics = unique.filter(item => item !== gross && item !== deductions && item !== net && item.value >= Math.max(30000, gross.value * .35) && item.value <= gross.value * 1.05);
      for (const basic of basics) {
        let score = 260 - difference / allowance * 80;
        score += Math.max(0, 45 - Math.abs(gross.value - basic.value) / gross.value * 120);
        if (basic.cy < gross.cy) score += 22;
        if (deductions.cy > gross.cy) score += 14;
        if (Math.abs(gross.cy - net.cy) < Math.max(gross.h, net.h) * 8) score += 18;
        if (!best || score > best.score) best = { score, values: { basic: basic.value, gross: gross.value, deductions: deductions.value, net: net.value } };
      }
    }
  }
  if (best?.score >= 270) return best.values;
  let inferred = null;
  for (const basic of unique) for (const extra of unique) {
    if (basic === extra || basic.value < 50000 || extra.value < 1000 || extra.value > basic.value * .25) continue;
    const grossValue = basic.value + extra.value;
    for (const deductions of unique) {
      if ([basic, extra].includes(deductions) || deductions.value < 3000 || deductions.value > grossValue * .6) continue;
      if (deductions.value < grossValue * .05) continue;
      if (basic.cy >= deductions.cy || extra.cy < basic.cy || extra.cy > deductions.cy) continue;
      const netValue = grossValue - deductions.value;
      for (const observedNet of unique) {
        if ([basic, extra, deductions].includes(observedNet)) continue;
        const distance = editDistance(String(observedNet.value), String(netValue));
        const relative = Math.abs(observedNet.value - netValue) / netValue;
        if (!(distance <= 1 || (distance <= 2 && relative <= .08))) continue;
        let score = 270 - distance * 26 - Math.min(50, relative * 80);
        const grossObserved = unique.some(item => item !== basic && item !== extra && item.value === grossValue);
        if (grossObserved) score += 70;
        const deductionRatio = deductions.value / grossValue;
        if (deductionRatio >= .08 && deductionRatio <= .4) score += 15;
        if (deductionRatio > .45) score -= 40;
        if (basic.cy < deductions.cy) score += 18;
        if (extra.cy >= basic.cy && extra.cy <= deductions.cy) score += 14;
        if (observedNet.cx > basic.cx) score += 10;
        if (!inferred || score > inferred.score) inferred = { score, values: { basic: basic.value, gross: grossValue, deductions: deductions.value, net: netValue } };
      }
    }
  }
  return inferred?.score >= 230 ? inferred.values : {};
}

export function extractAmounts(data) {
  const passes = Array.isArray(data?.passes) ? data.passes : [data || {}], candidates = [];
  passes.forEach((pass, index) => candidates.push(...spatialCandidates(pass, index), ...textCandidates(pass, index)));
  const labelled = choose(candidates);
  const labelledComplete = Object.keys(labelled).length === 4;
  const labelledConsistent = labelledComplete && labelled.basic <= labelled.gross * 1.05 && Math.abs(labelled.gross - labelled.deductions - labelled.net) <= 20;
  if (labelledConsistent) return labelled;
  const fallback = arithmeticFallback(passes);
  return Object.keys(fallback).length === 4 ? fallback : labelled;
}
