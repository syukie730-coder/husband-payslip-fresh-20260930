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
  const total = canvas.width * canvas.height;
  const grays = new Uint8Array(total);
  const histogram = new Uint32Array(256);
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
    const gray = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    grays[pixel] = gray;
    histogram[gray]++;
  }
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
  let integral;
  if (binary) {
    const stride = canvas.width + 1;
    integral = new Uint32Array(stride * (canvas.height + 1));
    for (let y = 1; y <= canvas.height; y++) {
      let rowSum = 0;
      for (let x = 1; x <= canvas.width; x++) {
        rowSum += grays[(y - 1) * canvas.width + x - 1];
        integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
      }
    }
  }
  const radius = Math.max(18, Math.round(Math.min(canvas.width, canvas.height) / 55));
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
    let gray = grays[pixel];
    if (binary) {
      const x = pixel % canvas.width, y = Math.floor(pixel / canvas.width);
      const x1 = Math.max(0, x - radius), y1 = Math.max(0, y - radius), x2 = Math.min(canvas.width - 1, x + radius), y2 = Math.min(canvas.height - 1, y + radius), stride = canvas.width + 1;
      const sum = integral[(y2 + 1) * stride + x2 + 1] - integral[y1 * stride + x2 + 1] - integral[(y2 + 1) * stride + x1] + integral[y1 * stride + x1];
      const mean = sum / ((x2 - x1 + 1) * (y2 - y1 + 1));
      gray = gray < mean - 11 ? 0 : 255;
    } else gray = Math.max(0, Math.min(255, (gray - low) * 255 / (high - low)));
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

function crop(source, x, y, width, height, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function moveTsv(tsv, xOffset, yOffset, scale, blockOffset) {
  const lines = String(tsv || '').split('\n');
  return lines.slice(1).map(line => {
    const columns = line.split('\t');
    if (columns.length < 12) return line;
    columns[2] = String((Number(columns[2]) || 0) + blockOffset);
    columns[6] = String(Math.round((Number(columns[6]) || 0) / scale + xOffset));
    columns[7] = String(Math.round((Number(columns[7]) || 0) / scale + yOffset));
    columns[8] = String(Math.round((Number(columns[8]) || 0) / scale));
    columns[9] = String(Math.round((Number(columns[9]) || 0) / scale));
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
      canvas = enhance(image, true);
      const overlapX = Math.round(canvas.width * .09), overlapY = Math.round(canvas.height * .09);
      const halfW = Math.round(canvas.width / 2), halfH = Math.round(canvas.height / 2);
      const tiles = [
        { x: 0, y: 0, w: halfW + overlapX, h: halfH + overlapY },
        { x: halfW - overlapX, y: 0, w: canvas.width - halfW + overlapX, h: halfH + overlapY },
        { x: 0, y: halfH - overlapY, w: halfW + overlapX, h: canvas.height - halfH + overlapY },
        { x: halfW - overlapX, y: halfH - overlapY, w: canvas.width - halfW + overlapX, h: canvas.height - halfH + overlapY }
      ];
      const texts = [], tsvParts = [];
      let header = '';
      for (let index = 0; index < tiles.length; index++) {
        const tile = tiles[index], tileScale = Math.min(1.65, 2300 / tile.w);
        const tileCanvas = crop(canvas, tile.x, tile.y, tile.w, tile.h, tileScale);
        const tileResult = await worker.recognize(tileCanvas, {}, { text: true, tsv: true });
        if (!header) header = String(tileResult.data.tsv || '').split('\n')[0];
        texts.push(tileResult.data.text || '');
        tsvParts.push(moveTsv(tileResult.data.tsv, tile.x, tile.y, tileScale, (index + 1) * 1000));
        tileCanvas.width = tileCanvas.height = 1;
      }
      await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789,.¥￥円' });
      const numberResult = await worker.recognize(canvas, {}, { text: true, tsv: true });
      texts.push(numberResult.data.text || '');
      tsvParts.push(moveTsv(numberResult.data.tsv, 0, 0, 1, 9000));
      const summaryX = Math.round(canvas.width * .5), summaryY = Math.round(canvas.height * .28), summaryW = canvas.width - summaryX, summaryH = canvas.height - summaryY;
      const summaryScale = Math.min(2.35, 2500 / summaryW);
      const summaryCanvas = crop(canvas, summaryX, summaryY, summaryW, summaryH, summaryScale);
      const summaryResult = await worker.recognize(summaryCanvas, {}, { text: true, tsv: true });
      texts.push(summaryResult.data.text || '');
      tsvParts.push(moveTsv(summaryResult.data.tsv, summaryX, summaryY, summaryScale, 10000));
      summaryCanvas.width = summaryCanvas.height = 1;
      passes.push({
        text: texts.join('\n'),
        tsv: `${header}\n${tsvParts.join('\n')}`,
        width: canvas.width,
        height: canvas.height
      });
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
