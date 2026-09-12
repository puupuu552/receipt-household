const TESSERACT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tesseractLoaderPromise = null;

function loadTesseractBrowser() {
  if (globalThis.Tesseract?.createWorker) return Promise.resolve(globalThis.Tesseract);
  if (tesseractLoaderPromise) return tesseractLoaderPromise;

  tesseractLoaderPromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('OCRエンジンの読み込みがタイムアウトしました。通信状態を確認して、もう一度お試しください。'));
    }, 30000);

    const finish = () => {
      clearTimeout(timeoutId);
      if (globalThis.Tesseract?.createWorker) resolve(globalThis.Tesseract);
      else reject(new Error('OCRエンジンを初期化できませんでした。アプリを最新版へ更新して再度お試しください。'));
    };

    const fail = () => {
      clearTimeout(timeoutId);
      reject(new Error('OCRエンジンを読み込めませんでした。インターネット接続を確認してください。'));
    };

    const existing = document.querySelector('script[data-receipt-tesseract]');
    if (existing) {
      if (globalThis.Tesseract?.createWorker) finish();
      else {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', fail, { once: true });
      }
      return;
    }

    const script = document.createElement('script');
    script.src = TESSERACT_SCRIPT_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.receiptTesseract = '1';
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', fail, { once: true });
    document.head.appendChild(script);
  }).catch(error => {
    tesseractLoaderPromise = null;
    throw error;
  });

  return tesseractLoaderPromise;
}

const SKIP_ITEM_PATTERNS = [
  /^(小計|合計|総合計|お買上|お買い上げ|支払|現金|お釣|おつり|釣銭|WAON|クレジット|電子マネー)/i,
  /(消費税|外税|内税|対象額|税込|税率|軽減税率)/,
  /^(TEL|FAX|電話|レジ|店No|取引|取No|ID|登録番号|担当者|営業時間)/i,
  /(領収証|領収書|お買い上げありがとうございます|ポイント|残高|お得情報|カウンセリング)/,
];

const RECEIPT_START_PATTERNS = [
  /領収証/,
  /領収書/,
  /お買上明細/,
  /お買い上げ明細/,
  /買上明細/,
];

const RECEIPT_END_PATTERNS = [
  /^小計/,
  /小計\s*\d*点?/,
  /^SUB\s*TOTAL/i,
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeLine(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[｜|]/g, ' ')
    .replace(/[￥]/g, '¥')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function compactLine(value) {
  return normalizeLine(value).replace(/\s+/g, '');
}

function moneyAtEnd(line) {
  const normalized = normalizeLine(line);
  const match = normalized.match(/(?:^|\s)[¥]?[\s]*(-?\d[\d,]*)\s*(?:円)?\s*[※*＊]?\s*[)）]?\s*$/);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) ? value : null;
}

function amountTextAtEnd(line) {
  return normalizeLine(line).match(/(?:^|\s)[¥]?[\s]*-?\d[\d,]*\s*(?:円)?\s*[※*＊]?\s*[)）]?\s*$/)?.[0] || '';
}

function datePartsFromLine(line) {
  const normalized = String(line || '').normalize('NFKC');
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
    return { year, month, day };
  }
  return null;
}

function dateFromText(text) {
  const rows = String(text || '').split(/\r?\n/);
  for (const line of rows) {
    const parts = datePartsFromLine(line);
    if (!parts) continue;
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }
  return null;
}

function storeFromLines(lines) {
  for (let i = 0; i < Math.min(lines.length - 1, 16); i += 1) {
    const current = lines[i];
    const next = lines[i + 1];
    if (/^(AEON|イオン)$/i.test(current) && /店/.test(next)) return next;
    if (/(マツモトキヨシ|ドラッグ|スーパー|ストア|マート)/i.test(current) && !/店/.test(current) && /店/.test(next) && next.length < 30) {
      return `${current} ${next}`;
    }
  }

  const candidates = lines.slice(0, 24).map((line, index) => {
    const compact = compactLine(line);
    if (!line || line.length > 55) return null;
    if (/^(領収証|領収書|お買い上げ|ありがとうございます)/.test(compact)) return null;
    if (/(住所|TEL|FAX|電話|営業時間|登録番号|レジ|取引|店No|No\.)/i.test(line)) return null;
    if (/^https?:/i.test(line)) return null;
    if (/^[\d\-\/:. ]+$/.test(line)) return null;

    let score = Math.max(0, 14 - index) * 0.05;
    if (/(店|スーパー|ストア|マート|AEON|イオン|マツモトキヨシ|ドラッグ|薬局|コンビニ)/i.test(line)) score += 5;
    if (/[ぁ-んァ-ヶ一-龠]/.test(line)) score += 1;
    if (/株式会社|有限会社/.test(line)) score += 0.5;
    return { line, score };
  }).filter(Boolean);

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 1 ? candidates[0].line : '';
}

function shouldSkipItemName(name) {
  const compact = compactLine(name);
  if (!compact) return true;
  if (/^[()（）\[\]\d×xX*＊※\s]+$/.test(compact)) return true;
  if (/(\d+個.*単|数量.*単価)/.test(compact)) return true;
  return SKIP_ITEM_PATTERNS.some(pattern => pattern.test(compact));
}

function cleanItemName(name) {
  let value = normalizeLine(name)
    .replace(/^[※*＊]\s*/, '')
    .replace(/[※*＊]\s*$/, '')
    .replace(/^[△▲●■□◆◇・:：]+\s*/, '')
    .trim();

  // ドラッグストア等の先頭商品コードを除去。R-1等の商品名は対象外。
  value = value.replace(/^\d{2,5}[A-Z]{0,3}\s*(?=[ぁ-んァ-ヶ一-龠])/i, '');
  return value.trim();
}

function looksLikeHumanItemName(name) {
  const value = cleanItemName(name);
  if (!value || shouldSkipItemName(value)) return false;
  if (value.length > 60) return false;
  if (/^[=+_~`^:;,.!?\-]/.test(value)) return false;
  if (/^[A-Za-z]{1,4}$/.test(value)) return false;
  return /[ぁ-んァ-ヶ一-龠A-Za-z]/.test(value);
}

function findReceiptNumbers(lines) {
  let subtotal = null;
  let total = null;
  let directTax = null;
  const taxBreakdown = [];

  for (const line of lines) {
    const compact = compactLine(line);
    const amount = moneyAtEnd(line);
    if (amount === null) continue;

    if (/小計/.test(compact) && !/対象額/.test(compact)) subtotal = amount;

    if (!/小計/.test(compact) && /(総合計|^合計|合計¥?|お買上計|お買い上げ計)/.test(compact)) {
      total = amount;
    }

    if (/(内,?消費税等|消費税等|消費税|外税|内税)/.test(compact) && !/(対象|税率)/.test(compact)) {
      directTax = Math.abs(amount);
      continue;
    }

    if (/(税|消費税)/.test(compact) && /(8%|10%|対象)/.test(compact)) {
      taxBreakdown.push(Math.abs(amount));
    }
  }

  const tax = directTax ?? taxBreakdown.reduce((sum, value) => sum + value, 0);
  return { subtotal, total, tax };
}

function isReceiptStart(line) {
  const compact = compactLine(line);
  return RECEIPT_START_PATTERNS.some(pattern => pattern.test(compact));
}

function isReceiptEnd(line) {
  const compact = compactLine(line);
  return RECEIPT_END_PATTERNS.some(pattern => pattern.test(compact));
}

function isPaymentOrSummaryLine(line) {
  const compact = compactLine(line);
  return /^(小計|合計|総合計|現金|お釣|おつり|釣銭|支払|WAON|クレジット|電子マネー)/i.test(compact)
    || /(消費税|外税|内税|対象額|対象¥|税率|軽減税率|ポイント|残高)/.test(compact);
}

function findItemZone(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isReceiptStart(lines[i])) start = i + 1;
  }

  if (start < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (datePartsFromLine(lines[i])) start = i + 1;
    }
  }

  if (start < 0) start = 0;

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (isReceiptEnd(lines[i])) {
      end = i;
      break;
    }
  }

  // 小計の読取に失敗しても、支払・税セクションへ入ったら商品抽出を止める。
  if (end === lines.length) {
    for (let i = start; i < lines.length; i += 1) {
      const compact = compactLine(lines[i]);
      if (/^(合計|総合計|現金|支払|お釣|おつり)/.test(compact)
        || /(消費税|対象額|税率|\d+%対象)/.test(compact)
        || (/税/.test(compact) && /\d/.test(compact))) {
        end = i;
        break;
      }
    }
  }

  return { start, end, lines: lines.slice(start, end) };
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

function parseItems(lines, numbers) {
  const { lines: itemLines, start, end } = findItemZone(lines);
  const items = [];
  let receiptLevelDiscount = 0;
  let pendingName = '';
  const receiptMax = Math.max(0, numbers.total || 0, numbers.subtotal || 0);

  const appendItem = (name, amount, originalLine) => {
    const cleaned = cleanItemName(name);
    if (!looksLikeHumanItemName(cleaned) || amount <= 0) return false;
    if (receiptMax > 0 && amount > Math.max(receiptMax + 5, Math.round(receiptMax * 1.05))) return false;
    if (amount < 10 && !/[ぁ-んァ-ヶ一-龠]/.test(cleaned)) return false;

    const reduced = /^[※*＊]/.test(normalizeLine(originalLine)) || /[※*＊]\s*$/.test(normalizeLine(originalLine));
    items.push({
      itemName: cleaned,
      printedAmount: amount,
      paidAmount: amount,
      taxRateHint: reduced ? 8 : null,
      discountAmount: 0,
    });
    return true;
  };

  for (const original of itemLines) {
    const line = normalizeLine(original);
    if (!line || isPaymentOrSummaryLine(line)) continue;

    const amount = moneyAtEnd(line);
    if (amount !== null) {
      const amountText = amountTextAtEnd(line);
      let name = normalizeLine(line.slice(0, line.length - amountText.length));
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
        pendingName = '';
        continue;
      }

      if (!cleanItemName(name) && pendingName) name = pendingName;
      if (appendItem(name, amount, line)) pendingName = '';
      continue;
    }

    // 数量・単価補足は商品名として使わない。
    const compact = compactLine(line);
    if (/^[（(]?\d+個.*単\d+/.test(compact) || /^(数量|個数|単価)/.test(compact)) continue;
    if (isReceiptStart(line) || isReceiptEnd(line) || shouldSkipItemName(line)) continue;

    if (looksLikeHumanItemName(line)) {
      pendingName = pendingName ? `${pendingName} ${line}` : line;
      // 誤結合を避けるため、長すぎる保留テキストは直近行だけ残す。
      if (pendingName.length > 50) pendingName = line;
    }
  }

  return { items, receiptLevelDiscount, zone: { start, end } };
}

export function parseReceiptText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  const purchaseDate = dateFromText(rawText);
  const storeName = storeFromLines(lines);
  const numbers = findReceiptNumbers(lines);
  const { items, receiptLevelDiscount, zone } = parseItems(lines, numbers);
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
  if (zone.end === lines.length && lines.length > 8) warnings.push('小計位置を特定できませんでした。商品一覧を確認してください。');

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
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function detectReceiptHorizontalBounds(image) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) return { x: 0, width: sourceWidth };

  const sampleWidth = 220;
  const sampleHeight = Math.max(120, Math.round(sourceHeight * (sampleWidth / sourceWidth)));
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return { x: 0, width: sourceWidth };
  ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

  const y0 = Math.floor(sampleHeight * 0.05);
  const y1 = Math.ceil(sampleHeight * 0.92);
  const ratios = new Array(sampleWidth).fill(0);

  for (let x = 0; x < sampleWidth; x += 1) {
    let lightNeutral = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 2) {
      const offset = (y * sampleWidth + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > 150 && (max - min) < 58) lightNeutral += 1;
      count += 1;
    }
    ratios[x] = count ? lightNeutral / count : 0;
  }

  const mask = ratios.map(value => value >= 0.25);
  const segments = [];
  let start = null;
  for (let x = 0; x < sampleWidth; x += 1) {
    if (mask[x] && start === null) start = x;
    if ((!mask[x] || x === sampleWidth - 1) && start !== null) {
      const end = mask[x] && x === sampleWidth - 1 ? x : x - 1;
      segments.push({ start, end, width: end - start + 1 });
      start = null;
    }
  }

  const center = sampleWidth / 2;
  const viable = segments.filter(segment => segment.width >= sampleWidth * 0.18);
  viable.sort((a, b) => {
    const aContains = a.start <= center && a.end >= center ? 1 : 0;
    const bContains = b.start <= center && b.end >= center ? 1 : 0;
    if (aContains !== bContains) return bContains - aContains;
    const aDist = Math.abs((a.start + a.end) / 2 - center);
    const bDist = Math.abs((b.start + b.end) / 2 - center);
    if (aDist !== bDist) return aDist - bDist;
    return b.width - a.width;
  });

  const best = viable[0];
  if (!best || best.width > sampleWidth * 0.93) return { x: 0, width: sourceWidth };

  const padding = Math.round(sampleWidth * 0.035);
  const left = Math.max(0, best.start - padding);
  const right = Math.min(sampleWidth - 1, best.end + padding);
  const x = Math.round((left / sampleWidth) * sourceWidth);
  const width = Math.max(1, Math.round(((right - left + 1) / sampleWidth) * sourceWidth));

  if (width < sourceWidth * 0.2) return { x: 0, width: sourceWidth };
  return { x, width };
}

async function preprocessImage(file, onProgress) {
  onProgress?.({ phase: 'prepare', progress: 0.03, message: 'レシート部分を検出しています…' });
  const image = await imageElementFromFile(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error('画像サイズを取得できませんでした。');

  const crop = detectReceiptHorizontalBounds(image);
  const targetScale = Math.min(3, 1800 / crop.width, 4200 / sourceHeight);
  const scale = Math.max(0.55, targetScale);
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!ctx) throw new Error('画像処理を開始できませんでした。');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = 'grayscale(1) contrast(1.42) brightness(1.04)';
  ctx.drawImage(image, crop.x, 0, crop.width, sourceHeight, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('画像の変換に失敗しました。')), 'image/jpeg', 0.94);
  });

  canvas.width = 1;
  canvas.height = 1;
  onProgress?.({ phase: 'prepare', progress: 0.09, message: 'レシートを拡大・高コントラスト化しました' });
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
    const Tesseract = await loadTesseractBrowser();
    const createWorker = Tesseract?.createWorker;
    if (typeof createWorker !== 'function') throw new Error('OCRエンジンを開始できませんでした。');

    worker = await createWorker(['jpn', 'eng'], 1, {
      logger: event => {
        const p = Number(event?.progress || 0);
        const status = String(event?.status || '');
        const mapped = /recognizing text/i.test(status) ? 0.35 + p * 0.6 : 0.12 + p * 0.2;
        onProgress?.({ phase: status, progress: clamp(mapped, 0.1, 0.95), message: progressMessage(status, p) });
      },
    });

    try {
      await worker.setParameters({
        tessedit_pageseg_mode: '4',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
    } catch {
      // Tesseract buildによって未対応パラメータがあってもOCR自体は継続する。
    }

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
