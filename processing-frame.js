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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function enhance(image, binary = false) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    histogram[gray]++;
  }
  const total = canvas.width * canvas.height;
  const percentile = target => {
    let count = 0;
    for (let i = 0; i < 256; i++) {
      count += histogram[i];
      if (count >= total * target) return i;
    }
    return 255;
  };
  let low = percentile(.015);
  const high = percentile(.985);
  if (high - low < 36) low = Math.max(0, high - 100);
  let threshold = 190;
  if (binary) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];
    let background = 0, weightBackground = 0, best = -1;
    for (let i = 0; i < 256; i++) {
      weightBackground += histogram[i];
      if (!weightBackground) continue;
      const weightForeground = total - weightBackground;
      if (!weightForeground) break;
      background += i * histogram[i];
      const meanBackground = background / weightBackground;
      const meanForeground = (sum - background) / weightForeground;
      const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (between > best) { best = between; threshold = i; }
    }
    threshold = Math.min(220, Math.max(115, threshold + 8));
  }
  for (let i = 0; i < data.length; i += 4) {
    let gray = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    gray = Math.max(0, Math.min(255, (gray - low) * 255 / (high - low)));
    if (binary) gray = gray < threshold ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = gray;
    data[i + 3] = 255;
  }
  const ruleRows = [];
  for (let y = 0; y < canvas.height; y++) {
    let dark = 0;
    for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4] < 175) dark++;
    if (dark > canvas.width * .55) ruleRows.push(y);
  }
  for (const y of ruleRows) {
    for (let yy = Math.max(0, y - 2); yy <= Math.min(canvas.height - 1, y + 2); yy++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (yy * canvas.width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
      }
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function crop(source, x, width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = source.height;
  canvas.getContext('2d').drawImage(source, x, 0, width, source.height, 0, 0, width, source.height);
  return canvas;
}

function moveTsv(tsv, xOffset, blockOffset) {
  const lines = String(tsv || '').split('\n');
  return lines.slice(1).map(line => {
    const columns = line.split('\t');
    if (columns.length < 12) return line;
    columns[2] = String((Number(columns[2]) || 0) + blockOffset);
    columns[6] = String((Number(columns[6]) || 0) + xOffset);
    return columns.join('\t');
  }).join('\n');
}

let started = false;
let worker;

window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== location.origin || started) return;
  const { kind, payload, job } = event.data || {};
  if (!['ocr', 'heic'].includes(kind)) return;
  started = true;
  const send = (type, extra = {}) => parent.postMessage({ type, job, ...extra }, location.origin);
  try {
    if (kind === 'heic') {
      await library('./vendor/heic2any.min.js');
      const result = await heic2any({ blob: payload, toType: 'image/jpeg', quality: .9 });
      send('done', { value: Array.isArray(result) ? result[0] : result });
      return;
    }

    await library('./vendor/tesseract.min.js');
    let pass = 1;
    worker = await Tesseract.createWorker(['jpn', 'eng'], 1, {
      workerPath: new URL('./vendor/worker.min.js', location.href).href,
      corePath: new URL('./vendor/core/', location.href).href,
      langPath: new URL('./vendor/lang', location.href).href,
      workerBlobURL: false,
      logger: message => {
        if (message.status === 'recognizing text') {
          send('progress', { text: `写真の文字を詳しく確認中（${pass}/2）… ${Math.round(message.progress * 100)}％` });
        }
      },
      errorHandler: () => send('error')
    });
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const image = await loadImage(payload);
    let canvas = enhance(image, false);
    let result = await worker.recognize(canvas, {}, { text: true, tsv: true });
    const passes = [{ text: result.data.text, tsv: result.data.tsv, width: canvas.width, height: canvas.height }];
    const { extractAmounts } = await import('./amounts.js');
    const first = extractAmounts({ passes });
    if (Object.keys(first).length < 4) {
      canvas.width = canvas.height = 1;
      pass = 2;
      send('progress', { text: '表と小さい文字を別の方法で確認しています（2/2）…' });
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      canvas = enhance(image, false);
      const overlap = Math.round(canvas.width * .08);
      const split = Math.round(canvas.width / 2);
      const left = crop(canvas, 0, split + overlap);
      const rightX = split - overlap;
      const right = crop(canvas, rightX, canvas.width - rightX);
      const leftResult = await worker.recognize(left, {}, { text: true, tsv: true });
      const rightResult = await worker.recognize(right, {}, { text: true, tsv: true });
      const header = String(leftResult.data.tsv || '').split('\n')[0];
      passes.push({
        text: `${leftResult.data.text || ''}\n${rightResult.data.text || ''}`,
        tsv: `${header}\n${moveTsv(leftResult.data.tsv, 0, 1000)}\n${moveTsv(rightResult.data.tsv, rightX, 2000)}`,
        width: canvas.width,
        height: canvas.height
      });
      left.width = left.height = right.width = right.height = 1;
    }
    canvas.width = canvas.height = 1;
    await worker.terminate();
    worker = null;
    send('done', { value: { passes } });
  } catch {
    send('error');
    try { await worker?.terminate(); } catch {}
    worker = null;
  }
});

parent.postMessage({ type: 'ready' }, location.origin);
