const TESSERACT_MODULE_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

const SKIP_ITEM_PATTERNS = [
  /^(小計|合計|総合計|お買上|お買い上げ|支払|現金|お釣|おつり|釣銭|WAON|クレジット|電子マネー)/i,
  /(消費税|外税|内税|対象額|税込|税率|軽減税率)/,
  /^(TEL|FAX|電話|レジ|店No|取引|取No|ID|登録番号|担当者|営業時間)/i,
  /(領収証|領収書|お買い上げありがとうございます|ポイント|残高)/,
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeLine(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[｜|]/g, ' ')
    .replace(/[￥]/g, '¥')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function moneyAtEnd(line) {
  const normalized = normalizeLine(line);
  const match = normalized.match(/(?:^|\s)[¥]?\s*(-?\d[\d,]*)\s*(?:円)?\s*[※*＊]?\s*[)）]?\s*$/);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) ? value : null;
}

function dateFromText(text) {
  const normalized = String(text || '').normalize('NFKC');
  const patterns = [
    /(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})\s*日?/,
    /(20\d{2})(\d{2})(\d{2})/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function storeFromLines(lines) {
  for (let i = 0; i < Math.min(lines.length - 1, 12); i += 1) {
    const current = lines[i];
    const next = lines[i + 1];
    if (/^(AEON|イオン)$/i.test(current) && /店/.test(next)) return next;
    if (/(マツモトキヨシ|ドラッグ|スーパー|ストア|マート)/i.test(current) && !/店/.test(current) && /店/.test(next) && next.length < 25) {
      return `${current} ${next}`;
    }
  }

  const candidates = lines.slice(0, 22).map((line, index) => {
    const compact = line.replace(/\s+/g, '');
    if (!line || line.length > 55) return null;
    if (/^(領収証|領収書|お買い上げ|ありがとうございます)/.test(compact)) return null;
    if (/(住所|TEL|FAX|電話|営業時間|登録番号|レジ|取引|店No|No\.)/i.test(line)) return null;
    if (/^https?:/i.test(line)) return null;
    if (/^[\d\-\/:. ]+$/.test(line)) return null;

    let score = Math.max(0, 12 - index) * 0.05;
    if (/(店|スーパー|ストア|マート|AEON|イオン|マツモトキヨシ|ドラッグ|薬局|コンビニ)/i.test(line)) score += 5;
    if (/[ぁ-んァ-ヶ一-龠]/.test(line)) score += 1;
    if (/株式会社|有限会社/.test(line)) score += 0.5;
    return { line, score };
  }).filter(Boolean);

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 1 ? candidates[0].line : '';
}

function shouldSkipItemName(name) {
  const compact = name.replace(/\s+/g, '');
  if (!compact) return true;
  if (/^[()（）\[\]\d×xX*＊※\s]+$/.test(compact)) return true;
  if (/(\d+個.*単|数量.*単価)/.test(compact)) return true;
  return SKIP_ITEM_PATTERNS.some(pattern => pattern.test(compact));
}

function allocateDelta(items, delta) {
  if (!items.length || delta === 0) return items.map(() => 0);
  const weights = items.map(item => Math.max(1, item.printedAmount));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const sign = delta >= 0 ? 1 : -1;
  const absDelta = Math.abs(delta);
  const allocations = weights.map((weight, index) => {
    const raw = (weight / totalWeight) * absDelta;
    return { index, value: Math.floor(raw), fraction: raw - Math.floor(raw) };
  });
  let remaining = absDelta - allocations.reduce((sum, row) => sum + row.value, 0);
  allocations.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) allocations[i % allocations.length].value += 1;
  allocations.sort((a, b) => a.index - b.index);
  return allocations.map(row => row.value * sign);
}

function parseItems(lines) {
  const items = [];
  let receiptLevelDiscount = 0;

  for (const original of lines) {
    const line = normalizeLine(original);
    if (!line) continue;

    const amount = moneyAtEnd(line);
    if (amount === null) continue;

    const amountText = line.match(/(?:^|\s)[¥]?\s*-?\d[\d,]*\s*(?:円)?\s*[※*＊]?\s*[)）]?\s*$/)?.[0] || '';
    let name = normalizeLine(line.slice(0, line.length - amountText.length));
    const hasReducedMark = /^[※*＊]/.test(name) || /[※*＊]\s*$/.test(line);
    name = name.replace(/^[※*＊]\s*/, '').replace(/[※*＊]\s*$/, '').trim();

    const isDiscount = /(値引|割引|クーポン|OFF|オフ)/i.test(name);
    if (isDiscount) {
      const discount = amount > 0 ? -amount : amount;
      if (items.length) {
        const previous = items[items.length - 1];
        previous.printedAmount = Math.max(0, previous.printedAmount + discount);
        previous.discountAmount = (previous.discountAmount || 0) + discount;
      } else {
        receiptLevelDiscount += discount;
      }
      continue;
    }

    if (amount <= 0 || shouldSkipItemName(name)) continue;

    items.push({
      itemName: name,
      printedAmount: amount,
      paidAmount: amount,
      taxRateHint: hasReducedMark ? 8 : null,
      discountAmount: 0,
    });
  }

  return { items, receiptLevelDiscount };
}

function findReceiptNumbers(lines) {
  let subtotal = null;
  let total = null;
  let tax = 0;
  let taxFound = false;

  for (const line of lines) {
    const compact = line.replace(/\s+/g, '');
    const amount = moneyAtEnd(line);
    if (amount === null) continue;

    if (/小計/.test(compact) && !/対象額/.test(compact)) subtotal = amount;

    if (!/小計/.test(compact) && /(総合計|合計)/.test(compact)) total = amount;

    if (total === null && /(支払額|お買上計|お買い上げ計)/.test(compact)) total = amount;

    if (/(消費税|外税|内税)/.test(compact) && !/対象額/.test(compact)) {
      if (/税込/.test(compact) && /対象/.test(compact)) continue;
      tax += Math.abs(amount);
      taxFound = true;
    }
  }

  return { subtotal, total, tax: taxFound ? tax : 0 };
}

export function parseReceiptText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  const purchaseDate = dateFromText(rawText);
  const storeName = storeFromLines(lines);
  const { items, receiptLevelDiscount } = parseItems(lines);
  const numbers = findReceiptNumbers(lines);
  const warnings = [];

  const itemSum = items.reduce((sum, item) => sum + item.printedAmount, 0) + receiptLevelDiscount;
  let subtotal = numbers.subtotal ?? itemSum;
  let total = numbers.total;
  const tax = numbers.tax;

  if (total === null) {
    if (tax > 0 && subtotal > 0) total = subtotal + tax;
    else total = itemSum;
    warnings.push('合計金額を明確に読み取れなかったため、明細から仮計算しています。');
  }

  if (subtotal === null || subtotal <= 0) subtotal = itemSum;

  let pricingMode = 'unknown';
  const tolerance = Math.max(2, Math.round(Math.max(total || 0, subtotal || 0) * 0.01));
  if (items.length && Math.abs(itemSum - total) <= tolerance) {
    pricingMode = 'tax-included';
  } else if (items.length && Math.abs(itemSum - subtotal) <= tolerance && total >= subtotal) {
    pricingMode = 'tax-excluded';
  }

  let reconciled = false;
  if (items.length) {
    if (pricingMode === 'tax-included') {
      items.forEach(item => { item.paidAmount = item.printedAmount; });
      reconciled = Math.abs(items.reduce((sum, item) => sum + item.paidAmount, 0) - total) <= tolerance;
    } else {
      const delta = total - itemSum;
      const relativeDifference = Math.abs(delta) / Math.max(1, itemSum);
      if (relativeDifference <= 0.18) {
        const allocations = allocateDelta(items, delta);
        items.forEach((item, index) => {
          item.paidAmount = Math.max(0, item.printedAmount + allocations[index]);
        });
        const paidSum = items.reduce((sum, item) => sum + item.paidAmount, 0);
        if (paidSum !== total && items.length) items[items.length - 1].paidAmount += total - paidSum;
        reconciled = items.reduce((sum, item) => sum + item.paidAmount, 0) === total;
        if (pricingMode === 'unknown' && delta !== 0) {
          warnings.push('税・値引きの内訳を確定できなかったため、総額との差額を商品へ按分しています。');
        }
      } else {
        items.forEach(item => { item.paidAmount = item.printedAmount; });
        warnings.push('明細合計とレシート合計の差が大きいため、商品金額の確認が必要です。');
      }
    }
  }

  if (!purchaseDate) warnings.push('購入日を読み取れませんでした。日付を確認してください。');
  if (!storeName) warnings.push('店舗名を読み取れませんでした。店舗名を入力してください。');
  if (!items.length) warnings.push('商品明細を読み取れませんでした。商品を手動で追加してください。');

  return {
    purchaseDate,
    storeName,
    subtotal: Math.max(0, Math.round(subtotal || 0)),
    tax: Math.max(0, Math.round(tax || Math.max(0, (total || 0) - (subtotal || 0)))),
    total: Math.max(0, Math.round(total || 0)),
    pricingMode,
    reconciled,
    warnings,
    items,
    rawText: String(rawText || ''),
  };
}

async function imageElementFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    // The image has decoded by the time the promise resolves; revoking is safe after draw.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function preprocessImage(file, onProgress) {
  onProgress?.({ phase: 'prepare', progress: 0.03, message: '画像をOCR向けに準備しています…' });
  const image = await imageElementFromFile(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error('画像サイズを取得できませんでした。');

  const scale = Math.min(1, 1600 / sourceWidth, 3200 / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!ctx) throw new Error('画像処理を開始できませんでした。');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  if ('filter' in ctx) ctx.filter = 'grayscale(1) contrast(1.18)';
  ctx.drawImage(image, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('画像の変換に失敗しました。')), 'image/jpeg', 0.92);
  });
  canvas.width = 1;
  canvas.height = 1;
  onProgress?.({ phase: 'prepare', progress: 0.08, message: '画像準備完了' });
  return blob;
}

function progressMessage(status, progress) {
  const percent = Math.round(clamp(Number(progress || 0), 0, 1) * 100);
  if (/loading tesseract core/i.test(status)) return 'OCRエンジンを読み込み中…';
  if (/initializing tesseract/i.test(status)) return 'OCRエンジンを初期化中…';
  if (/loading language/i.test(status)) return '日本語OCRデータを読み込み中…';
  if (/initializing api/i.test(status)) return '日本語OCRを準備中…';
  if (/recognizing text/i.test(status)) return `文字を読み取り中… ${percent}%`;
  return 'OCR処理中…';
}

export async function recognizeReceiptImage(file, onProgress) {
  if (!(file instanceof Blob)) throw new Error('レシート画像を選択してください。');
  const prepared = await preprocessImage(file, onProgress);

  onProgress?.({ phase: 'engine', progress: 0.1, message: 'OCRエンジンを読み込み中…' });
  let worker;
  try {
    const { createWorker } = await import(TESSERACT_MODULE_URL);
    worker = await createWorker(['jpn', 'eng'], 1, {
      logger: event => {
        const p = Number(event?.progress || 0);
        const status = String(event?.status || '');
        const mapped = /recognizing text/i.test(status) ? 0.35 + p * 0.6 : 0.12 + p * 0.2;
        onProgress?.({ phase: status, progress: clamp(mapped, 0.1, 0.95), message: progressMessage(status, p) });
      },
    });
    const result = await worker.recognize(prepared);
    onProgress?.({ phase: 'done', progress: 1, message: '読み取り完了。内容を確認してください。' });
    return {
      text: result?.data?.text || '',
      confidence: Number(result?.data?.confidence || 0),
    };
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch { /* noop */ }
    }
  }
}
