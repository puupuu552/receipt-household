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

function amountMatchAtEnd(line) {
  // 軽減税率記号「※」が OCR で「3%」になる例（138※ -> 1383%）を補正。
  const normalized = normalizeLine(line).replace(/(\d{2,5})3%\s*$/, '$1※');

  // 通常ケース。金額前に空白があるレシート。
  let match = normalized.match(/(?:^|\s)([¥]?\s*-?\d[\d,]*)\s*(?:円)?\s*[※*＊%]?\s*[)）]?\s*$/);
  // OCR は商品名と価格の空白を消すことがあるため、末尾2桁以上なら連結状態も許可する。
  // 例: 「国産生芋100%板蒟蒻108」 -> 108
  if (!match) match = normalized.match(/([^\d]|^)([¥]?\s*-?\d[\d,]{1,5})\s*(?:円)?\s*[※*＊%]?\s*[)）]?\s*$/);
  if (!match) return null;

  const raw = (match[2] ?? match[1] ?? '').replace(/[¥\s]/g, '');
  const value = Number(raw.replaceAll(',', ''));
  if (!Number.isFinite(value)) return null;

  const full = match[0];
  // 連結ケースでは先頭の非数字1文字は商品名側なので除外する。
  const text = match[2] ? full.slice(full.indexOf(match[2])) : full;
  return { value, text };
}

function moneyAtEnd(line) {
  return amountMatchAtEnd(line)?.value ?? null;
}

function amountTextAtEnd(line) {
  return amountMatchAtEnd(line)?.text || '';
}

function quantityTimesUnit(line) {
  const compact = compactLine(line).replace(/[xX]/g, '×');
  const patterns = [
    /(\d{1,3})個.*?×.*?単(?:価)?[¥￥]?(\d{1,6})/,
    /(\d{1,3})個.*?単(?:価)?[¥￥]?(\d{1,6})/,
    /数量(\d{1,3}).*?単価[¥￥]?(\d{1,6})/,
  ];
  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (!match) continue;
    const qty = Number(match[1]);
    const unit = Number(match[2]);
    if (qty > 0 && qty <= 99 && unit > 0 && unit <= 999999) return { qty, unit, total: qty * unit };
  }
  return null;
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

const JP_WEEKDAY = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

function formatDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekdayHintFromLine(line) {
  const match = String(line || '').normalize('NFKC').match(/[（(]\s*([日月火水木金土])\s*[）)]/);
  return match ? JP_WEEKDAY[match[1]] : null;
}

function daysFromNow(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.abs(date.getTime() - today.getTime()) / 86400000;
}

function repairDateWithWeekday(parts, weekday) {
  if (weekday === null || weekday === undefined) return parts;
  const exact = new Date(parts.year, parts.month - 1, parts.day);
  if (exact.getFullYear() === parts.year && exact.getMonth() === parts.month - 1 && exact.getDate() === parts.day && exact.getDay() === weekday) return parts;

  const candidates = [];
  for (let yearOffset = -1; yearOffset <= 1; yearOffset += 1) {
    for (let dayOffset = -2; dayOffset <= 2; dayOffset += 1) {
      const date = new Date(parts.year + yearOffset, parts.month - 1, parts.day + dayOffset);
      if (date.getDay() !== weekday) continue;
      const editCost = Math.abs(yearOffset) * 2 + Math.abs(dayOffset);
      const recencyPenalty = Math.min(3.5, daysFromNow(date) / 180);
      candidates.push({
        year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
        score: editCost + recencyPenalty,
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || parts;
}

function dateFromText(text) {
  const rows = String(text || '').split(/\r?\n/);
  for (const line of rows) {
    const parts = datePartsFromLine(line);
    if (!parts) continue;
    const repaired = repairDateWithWeekday(parts, weekdayHintFromLine(line));
    const repairedFlag = repaired.year !== parts.year || repaired.month !== parts.month || repaired.day !== parts.day;
    return {
      date: formatDateParts(repaired.year, repaired.month, repaired.day),
      repaired: repairedFlag,
      original: formatDateParts(parts.year, parts.month, parts.day),
    };
  }
  return { date: null, repaired: false, original: null };
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

function repairLikelyItemName(name) {
  const original = cleanItemName(name);
  let value = original;

  // 表記ゆれ・OCRで起きやすい誤字だけを保守的に補正する。
  value = value.replace(/\bT\s+V\b/gi, 'TV');
  value = value.replace(/キウィ/g, 'キウイ');
  value = value.replace(/コー[ソン]天/g, 'コーン天');

  if (/国産生芋100%板/.test(value) && !/(蒟蒻|こんにゃく)/.test(value)) {
    value = '国産生芋100%板蒟蒻';
  }

  const compact = value.replace(/\s+/g, '');
  if (/^TV/.test(compact) && /トマト/.test(compact) && /(各|どし|ごし|らご)/.test(compact)) {
    value = 'TV あらごしトマト';
  }

  return { name: value, repaired: value !== original, original };
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
  let taxIncluded = false;
  let taxExcluded = false;
  let itemCountHint = null;
  const taxBreakdown = [];

  for (const line of lines) {
    const compact = compactLine(line);
    const amount = moneyAtEnd(line);

    const countMatch = compact.match(/(?:小計)?(\d{1,2})点/);
    if (countMatch) {
      const count = Number(countMatch[1]);
      if (count > 0 && count < 100) itemCountHint = count;
    }

    if (amount === null) continue;

    if (/小計/.test(compact) && !/対象額/.test(compact)) subtotal = amount;

    if (!/小計/.test(compact) && /(総合計|^合計|合計¥?|お買上計|お買い上げ計)/.test(compact)) {
      total = amount;
    }

    if (/(内,?消費税等|内消費税等|内税)/.test(compact) && !/(対象|税率)/.test(compact)) {
      directTax = Math.abs(amount);
      taxIncluded = true;
      continue;
    }

    if (/(外税)/.test(compact) && !/(対象|税率)/.test(compact)) {
      directTax = Math.abs(amount);
      taxExcluded = true;
      continue;
    }

    // 「消費税等」だけの行は店舗によって内税/外税の表記差があるので税額だけ保持。
    if (/(消費税等|消費税)/.test(compact) && !/(対象|税率)/.test(compact)) {
      directTax = Math.abs(amount);
      continue;
    }

    if (/(税|消費税)/.test(compact) && /(8%|10%|対象)/.test(compact)) {
      taxBreakdown.push(Math.abs(amount));
    }
  }

  const tax = directTax ?? taxBreakdown.reduce((sum, value) => sum + value, 0);
  return { subtotal, total, tax, taxIncluded, taxExcluded, itemCountHint };
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

function unpricedItemScore(line) {
  const value = cleanItemName(line);
  if (!looksLikeHumanItemName(value)) return -1;
  if (value.length < 3 || value.length > 48) return -1;
  if (/^(領収|レシート|鐘|商品|明細)$/.test(value)) return -1;
  if (/(レジ|責:|取\d|登録|電話|営業時間|http|www\.)/i.test(value)) return -1;
  let score = 0;
  if (/[ぁ-んァ-ヶ一-龠]/.test(value)) score += 4;
  if (/[A-Za-z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 0.5;
  score += Math.min(3, value.length / 12);
  return score;
}

function parseItems(lines, numbers) {
  const { lines: itemLines, start, end } = findItemZone(lines);
  const items = [];
  let receiptLevelDiscount = 0;
  let pendingName = '';
  const unpricedCandidates = [];
  const pricedLineIndices = [];
  const receiptMax = Math.max(0, numbers.total || 0, numbers.subtotal || 0);

  const appendItem = (name, amount, originalLine) => {
    const repairedName = repairLikelyItemName(name);
    const cleaned = repairedName.name;
    if (!looksLikeHumanItemName(cleaned) || amount <= 0) return false;
    if (receiptMax > 0 && amount > Math.max(receiptMax + 5, Math.round(receiptMax * 1.05))) return false;
    if (amount < 10 && !/[ぁ-んァ-ヶ一-龠]/.test(cleaned)) return false;

    const reduced = /^[※*＊]/.test(normalizeLine(originalLine)) || /[※*＊]\s*$/.test(normalizeLine(originalLine));
    items.push({
      itemName: cleaned,
      ocrName: repairedName.original || cleaned,
      nameRepaired: repairedName.repaired,
      printedAmount: amount,
      paidAmount: amount,
      taxRateHint: reduced ? 8 : null,
      discountAmount: 0,
    });
    return true;
  };

  for (let lineIndex = 0; lineIndex < itemLines.length; lineIndex += 1) {
    const original = itemLines[lineIndex];
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
      if (appendItem(name, amount, line)) { pricedLineIndices.push(lineIndex); pendingName = ''; }
      continue;
    }

    // 数量×単価が読めた場合は直前商品の金額を算数で補正する。
    const compact = compactLine(line);
    const quantityInfo = quantityTimesUnit(line);
    if (quantityInfo) {
      if (items.length) {
        const previous = items[items.length - 1];
        const calculated = quantityInfo.total;
        if (calculated > 0 && calculated !== previous.printedAmount) {
          previous.printedAmount = calculated;
          previous.paidAmount = calculated;
          previous.inferred = true;
          previous.correctionReason = '数量×単価から補正';
        }
      }
      continue;
    }
    if (/^[（(]?\d+個.*単\d+/.test(compact) || /^(数量|個数|単価)/.test(compact)) continue;
    if (isReceiptStart(line) || isReceiptEnd(line) || shouldSkipItemName(line)) continue;

    if (looksLikeHumanItemName(line)) {
      const score = unpricedItemScore(line);
      if (score >= 0) unpricedCandidates.push({ name: cleanItemName(line), score, lineIndex });
      pendingName = pendingName ? `${pendingName} ${line}` : line;
      // 誤結合を避けるため、長すぎる保留テキストは直近行だけ残す。
      if (pendingName.length > 50) pendingName = line;
    }
  }

  // v1.4.2: 差額だけを根拠に「存在しない商品」を作らない。
  // ただし、OCR上に価格なしの商品名らしい行が実際に存在し、しかも
  // それが価格付き商品の間に1行だけある場合は、その実在OCR行に限って
  // 小計との差額を価格候補として付ける。必ず要確認にする。
  const currentSum = items.reduce((sum, item) => sum + item.printedAmount, 0) + receiptLevelDiscount;
  const targetSubtotal = Number(numbers.subtotal || 0);
  const missingCount = numbers.itemCountHint ? Number(numbers.itemCountHint) - items.length : null;
  const remainder = targetSubtotal - currentSum;
  const plausibleRemainder = targetSubtotal > 0
    && remainder >= 10
    && remainder <= Math.min(9999, Math.max(500, Math.round(targetSubtotal * 0.45)));

  const firstPriced = pricedLineIndices.length ? Math.min(...pricedLineIndices) : -1;
  const lastPriced = pricedLineIndices.length ? Math.max(...pricedLineIndices) : -1;
  const interiorCandidates = unpricedCandidates
    .filter(candidate => candidate.lineIndex > firstPriced && candidate.lineIndex < lastPriced)
    .filter(candidate => !items.some(item => compactLine(item.itemName) === compactLine(candidate.name)))
    .sort((a, b) => b.score - a.score);

  const mayAttachRemainderToExistingOcrLine = plausibleRemainder
    && ((missingCount === 1 && interiorCandidates.length >= 1)
      || (missingCount === null && interiorCandidates.length === 1));

  if (mayAttachRemainderToExistingOcrLine) {
    const candidate = interiorCandidates[0];
    const inferredRepair = repairLikelyItemName(candidate.name);
    items.push({
      itemName: inferredRepair.name,
      ocrName: inferredRepair.original || candidate.name,
      nameRepaired: inferredRepair.repaired,
      printedAmount: remainder,
      paidAmount: remainder,
      taxRateHint: null,
      discountAmount: 0,
      inferred: true,
      correctionReason: 'OCR上の価格なし商品行に小計差額を仮設定',
    });
  }

  return { items, receiptLevelDiscount, zone: { start, end } };
}

export function parseReceiptText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  const dateResult = dateFromText(rawText);
  const purchaseDate = dateResult.date;
  let storeName = storeFromLines(lines);
  let storeInferred = false;
  const rawCompact = compactLine(rawText);
  if (/(aeon-kyushu|AEON|AESON|イオン九州|イブオン九州)/i.test(rawText) && !/イオン/.test(storeName)) {
    storeName = 'イオン（店舗名要確認）';
    storeInferred = true;
  }
  const numbers = findReceiptNumbers(lines);
  // OCRが「合計」の数字を1〜2桁に誤読することがある。
  // 小計が取れているのに合計が極端に小さい場合は、誤読した合計を採用しない。
  if (numbers.subtotal && numbers.total && numbers.total < numbers.subtotal * 0.6) {
    numbers.total = numbers.subtotal;
  }
  const { items, receiptLevelDiscount, zone } = parseItems(lines, numbers);
  const warnings = [];

  const itemSum = items.reduce((sum, item) => sum + item.printedAmount, 0) + receiptLevelDiscount;
  let subtotal = numbers.subtotal ?? itemSum;
  let total = numbers.total;
  const tax = numbers.tax;

  if (total === null) {
    if (subtotal > 0 && numbers.taxIncluded) {
      // マツキヨ等：小計530円の中に内税44円が含まれている。530+44にはしない。
      total = subtotal;
    } else if (subtotal > 0 && numbers.taxExcluded && tax > 0) {
      total = subtotal + tax;
    } else if (subtotal > 0 && items.length && Math.abs(itemSum - subtotal) <= Math.max(3, Math.round(subtotal * 0.02))) {
      // 商品明細が小計と一致する場合は、税込表示レシートの可能性を優先。
      total = subtotal;
    } else if (subtotal > 0 && tax > 0) {
      // 内外税が判別不能な場合、むやみに税を足さず小計を実支払候補にする。
      total = subtotal;
      warnings.push('消費税が内税か外税か確定できなかったため、小計を実支払額として採用しています。');
    } else {
      total = subtotal > 0 ? subtotal : itemSum;
    }
    warnings.push('合計金額を明確に読み取れなかったため、明細・小計から仮計算しています。');
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
    } else if (pricingMode === 'tax-excluded') {
      // 外税が明確なときだけ、税額分を商品へ按分して税込計上額を作る。
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
      } else {
        items.forEach(item => { item.paidAmount = item.printedAmount; });
        warnings.push('外税レシートですが、明細合計と実支払額の差が大きいため自動按分しませんでした。');
      }
    } else {
      // 内外税や合計の読取が曖昧な場合は、帳尻合わせをしない。
      items.forEach(item => { item.paidAmount = item.printedAmount; });
      if (Math.abs(itemSum - total) > tolerance) {
        warnings.push('明細合計とレシート合計が一致しません。自動で金額を作らず、そのまま表示しています。実支払額または商品金額を確認してください。');
      }
      reconciled = Math.abs(itemSum - total) <= tolerance;
    }
  }

  if (numbers.itemCountHint && numbers.itemCountHint === items.length && numbers.subtotal && Math.abs(itemSum - numbers.subtotal) > tolerance) {
    warnings.push(`小計は ${numbers.subtotal}円 と読めましたが、${items.length}商品の明細合計は ${itemSum}円 です。どちらかのOCR誤読の可能性があるため、自動で帳尻合わせしていません。`);
  }
  if (!purchaseDate) warnings.push('購入日を読み取れませんでした。日付を確認してください。');
  if (dateResult.repaired) warnings.push(`曜日との矛盾から購入日を ${dateResult.original} → ${purchaseDate} に補正しました。日付を確認してください。`);
  if (!storeName) warnings.push('店舗名を読み取れませんでした。店舗名を入力してください。');
  if (storeInferred) warnings.push('店舗ブランドのみ判定できました。店舗名を確認してください。');
  if (!items.length) warnings.push('商品明細を読み取れませんでした。商品を手動で追加してください。');
  if (items.some(item => item.inferred)) warnings.push('一部商品の価格を小計との差額から補完しました。ピンクの項目を確認してください。');
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
  // v1.3.4: 金額列を欠落させないことを最優先にする。
  // v1.3.3 の自動横トリミングは、湾曲したレシートで右端の価格列を
  // 紙外と誤判定して切り落とすケースがあったため、OCR入力は全幅を保持する。
  onProgress?.({ phase: 'prepare', progress: 0.03, message: '画像をOCR向けに準備しています…' });
  const image = await imageElementFromFile(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error('画像サイズを取得できませんでした。');

  // iPhoneでのメモリ使用量を抑えつつ、小さいレシート文字は潰さない。
  // 縦長写真は横幅1800px程度を上限にし、元画像が小さい場合は最大1.45倍まで拡大。
  const fitScale = Math.min(1800 / sourceWidth, 4200 / sourceHeight);
  const scale = Math.max(0.65, Math.min(1.45, fitScale));
  const width = Math.max(1, Math.round(sourceWidth * scale));
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
  if ('filter' in ctx) ctx.filter = 'grayscale(1) contrast(1.28) brightness(1.03)';
  ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('画像の変換に失敗しました。')), 'image/jpeg', 0.94);
  });

  canvas.width = 1;
  canvas.height = 1;
  onProgress?.({ phase: 'prepare', progress: 0.09, message: 'レシート全幅を保持して高コントラスト化しました' });
  return blob;
}


async function makeBinaryVariant(blob) {
  const file = blob instanceof File ? blob : new File([blob], 'receipt-prepared.jpg', { type: blob.type || 'image/jpeg' });
  const image = await imageElementFromFile(file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return blob;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Otsuの簡易実装。レシートの黒文字/白地を二値化し、影や木目を減らす。
  const hist = new Array(256).fill(0);
  let count = 0;
  for (let i = 0; i < data.length; i += 16) {
    const lum = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    hist[lum] += 1;
    count += 1;
  }
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let weightB = 0;
  let bestVariance = -1;
  let threshold = 185;
  for (let t = 0; t < 256; t += 1) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = count - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      threshold = t;
    }
  }
  threshold = clamp(threshold + 18, 145, 215);

  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const value = lum < threshold ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  const out = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('二値化画像の生成に失敗しました。')), 'image/png');
  });
  canvas.width = 1;
  canvas.height = 1;
  return out;
}

function collectLayoutLines(blocks) {
  if (!Array.isArray(blocks)) return [];
  const lines = [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        const text = normalizeLine(line?.text || '');
        const bbox = line?.bbox;
        if (!text || !bbox) continue;
        lines.push({ text, bbox: { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 } });
      }
    }
  }
  return lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

function collectNumericWords(blocks) {
  if (!Array.isArray(blocks)) return [];
  const words = [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        for (const word of line?.words || []) {
          const bbox = word?.bbox;
          const raw = String(word?.text || '').normalize('NFKC').replace(/[¥￥,\s]/g, '');
          const digits = raw.match(/\d{1,6}/)?.[0];
          if (!bbox || !digits) continue;
          const value = Number(digits);
          if (!Number.isFinite(value) || value <= 0 || value > 999999) continue;
          words.push({ value, text: word.text, bbox: { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 } });
        }
      }
    }
  }
  return words;
}

function buildPositionAugmentedText(layoutLines, numericWords) {
  if (!layoutLines.length || !numericWords.length) return '';
  const maxX = Math.max(
    ...layoutLines.map(line => line.bbox.x1 || 0),
    ...numericWords.map(word => word.bbox.x1 || 0),
    1,
  );
  const rightThreshold = maxX * 0.56;
  const used = new Set();
  const output = [];

  for (const line of layoutLines) {
    const centerY = (line.bbox.y0 + line.bbox.y1) / 2;
    const lineHeight = Math.max(10, line.bbox.y1 - line.bbox.y0);
    const matches = numericWords
      .map((word, index) => ({ word, index }))
      .filter(({ word, index }) => {
        if (used.has(index) || word.bbox.x0 < rightThreshold) return false;
        const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
        return Math.abs(wordCenterY - centerY) <= Math.max(18, lineHeight * 0.85);
      })
      .sort((a, b) => b.word.bbox.x1 - a.word.bbox.x1);

    if (!matches.length) {
      output.push(line.text);
      continue;
    }

    const chosen = matches[0];
    used.add(chosen.index);
    const existing = amountMatchAtEnd(line.text);
    let base = line.text;
    if (existing?.text) base = normalizeLine(base.slice(0, Math.max(0, base.length - existing.text.length)));
    output.push(`${base} ¥${chosen.word.value}`.trim());
  }
  return output.join('\n');
}

function textQualityScore(text) {
  const value = String(text || '');
  let score = 0;
  if (/20\d{2}.*\d{1,2}.*\d{1,2}/.test(value)) score += 8;
  if (/(領収証|領収書|お買上|お買い上げ)/.test(value)) score += 6;
  if (/小計/.test(value)) score += 8;
  if (/合計/.test(value)) score += 5;
  const moneyLike = value.match(/[¥￥]?\s*\d{2,6}\s*(?:円|※|\*|＊)?/g)?.length || 0;
  score += Math.min(24, moneyLike * 2);
  score += Math.min(18, (value.match(/[ぁ-んァ-ヶ一-龠]/g)?.length || 0) / 8);
  return score;
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
  const binary = await makeBinaryVariant(prepared);

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
        const mapped = /recognizing text/i.test(status) ? 0.22 + p * 0.34 : 0.12 + p * 0.09;
        onProgress?.({ phase: status, progress: clamp(mapped, 0.1, 0.56), message: progressMessage(status, p) });
      },
    });

    const runPass = async (imageBlob, psm, label, base, span, extraParameters = {}, wantBlocks = false) => {
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: String(psm),
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: '',
          ...extraParameters,
        });
      } catch { /* noop */ }
      onProgress?.({ phase: 'recognize', progress: base, message: `${label}で文字を読み取り中…` });
      const result = await worker.recognize(imageBlob, {}, wantBlocks ? { text: true, blocks: true } : { text: true });
      onProgress?.({ phase: 'recognize', progress: base + span, message: `${label}の読み取り完了` });
      return {
        text: result?.data?.text || '',
        confidence: Number(result?.data?.confidence || 0),
        blocks: result?.data?.blocks || null,
      };
    };

    // 1回目: 日本語+レイアウト。2回目: 二値化で文字補完。3回目: 数字だけを専用認識。
    const first = await runPass(prepared, 4, '1回目（文字・位置）', 0.20, 0.27, {}, true);
    const second = await runPass(binary, 6, '2回目（白黒補正）', 0.49, 0.25);
    const numeric = await runPass(prepared, 11, '3回目（金額列）', 0.76, 0.18, {
      tessedit_char_whitelist: '0123456789,¥￥%※*',
    }, true);

    const layoutLines = collectLayoutLines(first.blocks);
    const numericWords = collectNumericWords(numeric.blocks);
    const positionedText = buildPositionAugmentedText(layoutLines, numericWords);
    const positioned = positionedText ? {
      text: positionedText,
      confidence: Math.max(0, Math.min(100, (first.confidence + numeric.confidence) / 2)),
      source: 'position+numeric',
    } : null;

    const candidates = [
      { ...first, source: 'layout' },
      { ...second, source: 'binary' },
      ...(positioned ? [positioned] : []),
    ];
    candidates.sort((a, b) => (textQualityScore(b.text) + b.confidence * 0.12) - (textQualityScore(a.text) + a.confidence * 0.12));
    const best = candidates[0];

    onProgress?.({ phase: 'done', progress: 1, message: '文字・白黒・金額列の3通りを照合しました。内容を確認してください。' });
    return {
      text: best.text,
      confidence: best.confidence,
      candidates,
      diagnostics: { layoutLineCount: layoutLines.length, numericWordCount: numericWords.length },
    };
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch { /* noop */ }
    }
  }
}

