import {
  openDb,
  saveReceipt,
  findRule,
  listRules,
  listReceiptsByMonth,
  listItemsByMonth,
  deleteReceipt,
  deleteMonth,
  clearPurchaseData,
  clearRules,
} from './db.js?v=1.3.3';
import { buildXlsx, saveXlsxFile } from './xlsx-export.js?v=1.3.3';
import { recognizeReceiptImage, parseReceiptText } from './ocr.js?v=1.3.3';

const APP_VERSION = '1.3.3';
const AUTO_CATEGORIES = ['食費', 'お菓子・嗜好品', '果物', '野菜', '日用品'];
const ALL_CATEGORIES = [...AUTO_CATEGORIES, '母向け', 'その他'];

const SAMPLE = {
  // 公開リポジトリ用の完全なダミーデータです。実際のレシート情報ではありません。
  storeName: 'サンプルスーパー',
  subtotal: 1120,
  tax: 94,
  total: 1214,
  pricingMode: 'tax-excluded',
  items: [
    { itemName: '食パン', printedAmount: 180, paidAmount: 194, aiCategory: '食費', needsReview: false },
    { itemName: '牛乳', printedAmount: 220, paidAmount: 238, aiCategory: '食費', needsReview: false },
    { itemName: 'りんご', printedAmount: 240, paidAmount: 259, aiCategory: '果物', needsReview: false },
    { itemName: 'にんじん', printedAmount: 120, paidAmount: 130, aiCategory: '野菜', needsReview: false },
    { itemName: 'サンプル商品A', printedAmount: 160, paidAmount: 173, aiCategory: '食費', needsReview: true },
    { itemName: '台所用スポンジ', printedAmount: 200, paidAmount: 220, aiCategory: '日用品', needsReview: false },
  ],
};

let draft = null;
let ocrBusy = false;
let updateReloadRequested = false;

const els = {
  dbStatus: document.querySelector('#dbStatus'),
  tabs: [...document.querySelectorAll('.tab')],
  views: {
    entry: document.querySelector('#entryView'),
    monthly: document.querySelector('#monthlyView'),
    settings: document.querySelector('#settingsView'),
  },
  cameraBtn: document.querySelector('#cameraBtn'),
  photoBtn: document.querySelector('#photoBtn'),
  receiptCameraInput: document.querySelector('#receiptCameraInput'),
  receiptPhotoInput: document.querySelector('#receiptPhotoInput'),
  loadSampleBtn: document.querySelector('#loadSampleBtn'),
  clearDraftBtn: document.querySelector('#clearDraftBtn'),
  ocrPanel: document.querySelector('#ocrPanel'),
  ocrStatusText: document.querySelector('#ocrStatusText'),
  ocrPercent: document.querySelector('#ocrPercent'),
  ocrProgress: document.querySelector('#ocrProgress'),
  ocrWarningBox: document.querySelector('#ocrWarningBox'),
  ocrDebug: document.querySelector('#ocrDebug'),
  ocrRawText: document.querySelector('#ocrRawText'),
  receiptMeta: document.querySelector('#receiptMeta'),
  purchaseDate: document.querySelector('#purchaseDate'),
  storeName: document.querySelector('#storeName'),
  itemList: document.querySelector('#itemList'),
  addItemBtn: document.querySelector('#addItemBtn'),
  totalCard: document.querySelector('#totalCard'),
  receiptTotal: document.querySelector('#receiptTotal'),
  totalCheck: document.querySelector('#totalCheck'),
  registerBtn: document.querySelector('#registerBtn'),
  entryMessage: document.querySelector('#entryMessage'),
  monthPicker: document.querySelector('#monthPicker'),
  monthSummary: document.querySelector('#monthSummary'),
  monthTotal: document.querySelector('#monthTotal'),
  receiptCount: document.querySelector('#receiptCount'),
  receiptList: document.querySelector('#receiptList'),
  deleteMonthBtn: document.querySelector('#deleteMonthBtn'),
  monthlyMessage: document.querySelector('#monthlyMessage'),
  exportExcelBtn: document.querySelector('#exportExcelBtn'),
  appVersion: document.querySelector('#appVersion'),
  headerVersion: document.querySelector('#headerVersion'),
  quickUpdateBtn: document.querySelector('#quickUpdateBtn'),
  updateAppBtn: document.querySelector('#updateAppBtn'),
  updateStatus: document.querySelector('#updateStatus'),
  ruleCount: document.querySelector('#ruleCount'),
  clearPurchasesBtn: document.querySelector('#clearPurchasesBtn'),
  clearRulesBtn: document.querySelector('#clearRulesBtn'),
  settingsMessage: document.querySelector('#settingsMessage'),
};

function yen(value) {
  return `¥${Number(value || 0).toLocaleString('ja-JP')}`;
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function localDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeId(prefix) {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function showMessage(el, text, error = false) {
  el.textContent = text;
  el.classList.remove('hidden', 'error');
  if (error) el.classList.add('error');
}

function hideMessage(el) {
  el.textContent = '';
  el.classList.add('hidden');
  el.classList.remove('error');
}

function setDbStatus(text, kind = 'ready') {
  els.dbStatus.textContent = text;
  els.dbStatus.classList.remove('ready', 'error');
  if (kind) els.dbStatus.classList.add(kind);
}

function switchTab(name) {
  for (const [key, view] of Object.entries(els.views)) view.classList.toggle('hidden', key !== name);
  els.tabs.forEach(btn => btn.classList.toggle('is-active', btn.dataset.tab === name));
  if (name === 'monthly') refreshMonthly();
  if (name === 'settings') refreshSettings();
}

function categoryByKeywords(itemName) {
  const name = String(itemName || '').normalize('NFKC').toLowerCase();
  const compactName = name.replace(/\s+/g, '');
  const has = words => words.some(word => {
    const key = String(word).normalize('NFKC').toLowerCase();
    return name.includes(key) || compactName.includes(key.replace(/\s+/g, ''));
  });

  if (has(['バナナ', 'キウイ', 'りんご', 'リンゴ', 'みかん', 'オレンジ', 'ぶどう', '葡萄', 'いちご', '苺', 'なし', '梨', 'もも', '桃', '柿', 'メロン', 'すいか', 'スイカ', 'レモン', 'グレープフルーツ'])) {
    return { category: '果物', confident: true };
  }

  const processedTomato = has(['あらごし', 'ケチャップ', 'トマト缶', 'トマトソース', 'ピューレ']);
  if (!processedTomato && has(['キャベツ', 'にんじん', '人参', '玉ねぎ', 'たまねぎ', 'にんにく', '生姜', 'しょうが', 'トマト', 'きゅうり', '胡瓜', 'レタス', '白菜', '大根', 'ねぎ', 'ネギ', 'ほうれん草', '小松菜', 'じゃがいも', 'さつまいも', 'ピーマン', 'なす', '茄子', 'もやし', 'ブロッコリー'])) {
    return { category: '野菜', confident: true };
  }

  if (has(['チョコ', 'ハイチュウ', 'ハイチュ', 'キャンディ', 'あめ', '飴', 'クッキー', 'ビスケット', 'ポテトチップ', 'スナック', 'アイス', 'ガム', 'グミ', 'せんべい', '煎餅', 'ケーキ', 'ジュース', 'コーラ', '炭酸', 'ゼリー', 'プリン'])) {
    return { category: 'お菓子・嗜好品', confident: true };
  }

  if (has(['ティッシュ', 'トイレット', '洗剤', 'ハイター', '漂白', '柔軟剤', 'スポンジ', '電池', 'アルカリ', '単3', '単4', 'ラップ', 'ホイル', 'ゴミ袋', 'ごみ袋', '歯ブラシ', '歯磨', 'シャンプー', 'コンディショナー', '石鹸', 'せっけん', 'キッチンペーパー', '掃除', '除菌'])) {
    return { category: '日用品', confident: true };
  }

  if (has(['牛乳', 'ヨーグルト', 'チーズ', '卵', 'たまご', '食パン', 'パン', '米', 'ごはん', '肉', '豚', '牛', '鶏', '魚', '鮭', 'さけ', 'さば', '鯖', '豆腐', '納豆', 'こんにゃく', '蒟蒻', 'コーン天', 'ちくわ', 'かまぼこ', '味噌', 'みそ', '醤油', 'しょうゆ', '酢', '油', 'カレー', 'パスタ', '麺', 'そば', 'うどん', 'あらごしトマト'])) {
    return { category: '食費', confident: true };
  }

  return { category: '食費', confident: false };
}

async function enrichOcrItems(parsed) {
  const rows = [];
  for (const source of parsed.items) {
    const classification = categoryByKeywords(source.itemName);
    const rule = await findRule(source.itemName);
    rows.push({
      itemName: source.itemName,
      printedAmount: integer(source.printedAmount),
      paidAmount: integer(source.paidAmount),
      aiCategory: classification.category,
      category: rule?.category || classification.category,
      manualSpecial: null,
      reviewed: Boolean(rule) || (classification.confident && parsed.reconciled),
      ruleApplied: Boolean(rule),
      taxRateHint: source.taxRateHint || null,
    });
  }
  return rows;
}

async function loadSample() {
  hideMessage(els.entryMessage);
  const items = [];
  for (const source of SAMPLE.items) {
    const rule = await findRule(source.itemName);
    items.push({
      ...source,
      category: rule?.category || source.aiCategory,
      manualSpecial: null,
      reviewed: Boolean(rule) || !source.needsReview,
      ruleApplied: Boolean(rule),
    });
  }

  draft = {
    purchaseDate: localDateKey(),
    storeName: SAMPLE.storeName,
    subtotal: SAMPLE.subtotal,
    tax: SAMPLE.tax,
    total: SAMPLE.total,
    pricingMode: SAMPLE.pricingMode,
    items,
    warnings: [],
    rawText: '',
  };
  renderDraft();
}

function setOcrBusy(isBusy) {
  ocrBusy = isBusy;
  els.cameraBtn.disabled = isBusy;
  els.photoBtn.disabled = isBusy;
  els.loadSampleBtn.disabled = isBusy;
  els.clearDraftBtn.disabled = isBusy || !draft;
  if (isBusy) {
    els.ocrPanel.classList.remove('hidden');
    els.ocrProgress.value = 0;
    els.ocrPercent.textContent = '0%';
  }
}

function updateOcrProgress(event) {
  const progress = Math.min(1, Math.max(0, Number(event?.progress || 0)));
  els.ocrProgress.value = progress;
  els.ocrPercent.textContent = `${Math.round(progress * 100)}%`;
  els.ocrStatusText.textContent = event?.message || 'OCR処理中…';
}

async function processReceiptImage(file) {
  if (!file || ocrBusy) return;
  clearDraft();
  hideMessage(els.entryMessage);
  hideMessage(els.monthlyMessage);
  els.ocrWarningBox.classList.add('hidden');
  els.ocrDebug.classList.add('hidden');
  setOcrBusy(true);

  try {
    const recognition = await recognizeReceiptImage(file, updateOcrProgress);
    const parsed = parseReceiptText(recognition.text);
    if (recognition.confidence > 0 && recognition.confidence < 55) {
      parsed.warnings = [...(parsed.warnings || []), 'OCRの文字認識精度が低めです。商品名と金額を重点的に確認してください。'];
    }
    const items = await enrichOcrItems(parsed);
    draft = {
      purchaseDate: parsed.purchaseDate || localDateKey(),
      storeName: parsed.storeName || '',
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      total: parsed.total || items.reduce((sum, item) => sum + item.paidAmount, 0),
      pricingMode: parsed.pricingMode,
      items,
      warnings: parsed.warnings || [],
      rawText: recognition.text || '',
      ocrConfidence: recognition.confidence,
    };
    renderDraft();
    updateOcrProgress({ progress: 1, message: '読み取り完了。ピンクの項目と合計を確認してください。' });
  } catch (error) {
    const detail = String(error?.message || error || '不明なエラー');
    const engineError = /(OCRエンジン|Tesseract|createWorker|読み込めません|タイムアウト|初期化)/i.test(detail);
    const guidance = engineError
      ? '写真の内容ではなくOCRエンジン側のエラーです。通信状態を確認し、設定の「最新版を確認・更新」を押してから再度お試しください。'
      : '写真を明るく、レシート全体が入るように撮り直してください。';
    showMessage(els.entryMessage, `OCRに失敗しました: ${detail}\n${guidance}`, true);
    els.ocrStatusText.textContent = engineError ? 'OCRエンジンの起動に失敗しました' : 'OCRに失敗しました';
  } finally {
    setOcrBusy(false);
    els.receiptCameraInput.value = '';
    els.receiptPhotoInput.value = '';
  }
}

function clearDraft() {
  draft = null;
  els.receiptMeta.classList.add('hidden');
  els.itemList.innerHTML = '';
  els.addItemBtn.classList.add('hidden');
  els.totalCard.classList.add('hidden');
  els.registerBtn.classList.add('hidden');
  els.clearDraftBtn.disabled = true;
  els.ocrWarningBox.classList.add('hidden');
  els.ocrWarningBox.innerHTML = '';
  els.ocrDebug.classList.add('hidden');
  els.ocrRawText.textContent = '';
  hideMessage(els.entryMessage);
}

function priceModeNote(item) {
  if (!draft) return '';
  if (draft.pricingMode === 'tax-included') return `レシート記載 ${yen(item.printedAmount)}（税込）`;
  if (draft.pricingMode === 'tax-excluded') return `レシート記載 ${yen(item.printedAmount)}（税抜） → 税込計上 ${yen(item.paidAmount)}`;
  return `レシート記載 ${yen(item.printedAmount)} → 税込計上 ${yen(item.paidAmount)}`;
}

function renderWarnings() {
  if (!draft?.warnings?.length) {
    els.ocrWarningBox.classList.add('hidden');
    els.ocrWarningBox.innerHTML = '';
    return;
  }
  els.ocrWarningBox.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = '読み取り結果の注意';
  const list = document.createElement('ul');
  for (const warning of draft.warnings) {
    const li = document.createElement('li');
    li.textContent = warning;
    list.append(li);
  }
  els.ocrWarningBox.append(title, list);
  els.ocrWarningBox.classList.remove('hidden');
}

function updateTotalCheck() {
  if (!draft) return;
  const itemTotal = draft.items.reduce((sum, item) => sum + integer(item.paidAmount), 0);
  const difference = integer(draft.total) - itemTotal;
  els.totalCheck.classList.remove('ok', 'error');
  if (difference === 0) {
    els.totalCheck.classList.add('ok');
    els.totalCheck.textContent = `✓ 商品の税込合計 ${yen(itemTotal)} と一致しています`;
  } else {
    els.totalCheck.classList.add('error');
    els.totalCheck.textContent = `⚠ 商品合計 ${yen(itemTotal)} と ${yen(Math.abs(difference))} の差があります`;
  }
}

function removeItem(index) {
  if (!draft) return;
  draft.items.splice(index, 1);
  renderDraft();
}

function addBlankItem() {
  if (!draft) {
    draft = {
      purchaseDate: localDateKey(),
      storeName: '',
      subtotal: 0,
      tax: 0,
      total: 0,
      pricingMode: 'unknown',
      items: [],
      warnings: [],
      rawText: '',
    };
  }
  draft.items.push({
    itemName: '',
    printedAmount: 0,
    paidAmount: 0,
    aiCategory: '食費',
    category: '食費',
    manualSpecial: null,
    reviewed: false,
    ruleApplied: false,
  });
  renderDraft();
}

function renderDraft() {
  if (!draft) return clearDraft();

  els.receiptMeta.classList.remove('hidden');
  els.totalCard.classList.remove('hidden');
  els.registerBtn.classList.remove('hidden');
  els.addItemBtn.classList.remove('hidden');
  els.clearDraftBtn.disabled = ocrBusy;
  els.purchaseDate.value = draft.purchaseDate || localDateKey();
  els.storeName.value = draft.storeName || '';
  els.receiptTotal.value = integer(draft.total);
  els.itemList.innerHTML = '';
  renderWarnings();

  if (draft.rawText) {
    els.ocrRawText.textContent = draft.rawText;
    els.ocrDebug.classList.remove('hidden');
  } else {
    els.ocrDebug.classList.add('hidden');
    els.ocrRawText.textContent = '';
  }

  draft.items.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = `item-card${item.reviewed ? '' : ' needs-review'}`;

    const head = document.createElement('div');
    head.className = 'item-head';
    const state = document.createElement('span');
    if (item.reviewed) {
      state.className = 'item-state';
      state.textContent = item.ruleApplied ? '学習ルール適用' : '自動判定済み';
    } else {
      state.className = 'review-badge';
      state.textContent = '⚠ 要確認';
    }
    const price = document.createElement('strong');
    price.className = 'money item-price';
    price.textContent = yen(item.paidAmount);
    head.append(state, price);

    const nameField = document.createElement('label');
    nameField.className = 'field';
    nameField.innerHTML = '<span>商品名</span>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = item.itemName;
    nameInput.autocomplete = 'off';
    nameInput.addEventListener('input', () => {
      draft.items[index].itemName = nameInput.value;
    });
    nameField.append(nameInput);

    const categoryField = document.createElement('label');
    categoryField.className = 'field';
    categoryField.innerHTML = '<span>自動カテゴリ</span>';
    const select = document.createElement('select');
    select.disabled = Boolean(item.manualSpecial);
    AUTO_CATEGORIES.forEach(category => {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      option.selected = item.category === category;
      select.append(option);
    });
    select.addEventListener('change', () => {
      draft.items[index].category = select.value;
      draft.items[index].reviewed = true;
      draft.items[index].ruleApplied = false;
      renderDraft();
    });
    categoryField.append(select);

    const amountField = document.createElement('label');
    amountField.className = 'field amount-field';
    amountField.innerHTML = '<span>税込計上額</span>';
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0';
    amountInput.step = '1';
    amountInput.inputMode = 'numeric';
    amountInput.value = integer(item.paidAmount);
    amountInput.addEventListener('change', () => {
      draft.items[index].paidAmount = integer(amountInput.value);
      draft.items[index].reviewed = true;
      renderDraft();
    });
    amountField.append(amountInput);

    const manualLabel = document.createElement('span');
    manualLabel.className = 'manual-label';
    manualLabel.textContent = '手動指定';
    const manualButtons = document.createElement('div');
    manualButtons.className = 'manual-buttons';
    [
      { label: '通常', value: null },
      { label: '母向け', value: '母向け' },
      { label: 'その他', value: 'その他' },
    ].forEach(mode => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `manual-button${item.manualSpecial === mode.value ? ' is-active' : ''}`;
      btn.textContent = mode.label;
      btn.addEventListener('click', () => {
        draft.items[index].manualSpecial = mode.value;
        draft.items[index].reviewed = true;
        renderDraft();
      });
      manualButtons.append(btn);
    });

    const note = document.createElement('p');
    note.className = 'item-note';
    note.textContent = priceModeNote(item);

    const cardActions = document.createElement('div');
    cardActions.className = 'item-card-actions';
    if (!item.reviewed) {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'review-ok-button';
      approve.textContent = 'この内容でOK';
      approve.addEventListener('click', () => {
        draft.items[index].reviewed = true;
        renderDraft();
      });
      cardActions.append(approve);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'item-remove-button';
    remove.textContent = 'この商品を削除';
    remove.addEventListener('click', () => removeItem(index));
    cardActions.append(remove);

    card.append(head, nameField, categoryField, amountField, manualLabel, manualButtons, note, cardActions);
    els.itemList.append(card);
  });

  updateTotalCheck();
}

async function registerDraft() {
  if (!draft) return;
  hideMessage(els.entryMessage);

  draft.purchaseDate = els.purchaseDate.value;
  draft.storeName = els.storeName.value.trim();
  draft.total = integer(els.receiptTotal.value);

  if (!draft.purchaseDate || !draft.storeName) {
    showMessage(els.entryMessage, '購入日と店舗名を入力してください。', true);
    return;
  }
  if (!draft.items.length) {
    showMessage(els.entryMessage, '商品がありません。「商品を追加」から明細を入力してください。', true);
    return;
  }
  if (draft.items.some(item => !item.itemName.trim())) {
    showMessage(els.entryMessage, '商品名が空欄の商品があります。', true);
    return;
  }

  const pending = draft.items.filter(item => !item.reviewed);
  if (pending.length) {
    showMessage(els.entryMessage, `要確認の商品が${pending.length}件あります。ピンクのカードを確認してください。`, true);
    return;
  }

  const itemTotal = draft.items.reduce((sum, item) => sum + integer(item.paidAmount), 0);
  if (itemTotal !== draft.total) {
    showMessage(els.entryMessage, `商品合計 ${yen(itemTotal)} と実支払額 ${yen(draft.total)} が一致していません。金額を修正してください。`, true);
    return;
  }

  const monthKey = draft.purchaseDate.slice(0, 7);
  const receiptId = makeId('receipt');
  const createdAt = new Date().toISOString();
  const receipt = {
    id: receiptId,
    purchaseDate: draft.purchaseDate,
    monthKey,
    storeName: draft.storeName,
    subtotal: integer(draft.subtotal),
    tax: integer(draft.tax),
    total: integer(draft.total),
    createdAt,
  };

  const items = draft.items.map(item => ({
    id: makeId('item'),
    receiptId,
    monthKey,
    itemName: item.itemName.trim(),
    printedAmount: integer(item.printedAmount),
    paidAmount: integer(item.paidAmount),
    aiCategory: item.aiCategory,
    category: item.manualSpecial || item.category,
    manualSpecial: item.manualSpecial,
    wasReviewed: item.reviewed,
    createdAt,
  }));

  try {
    els.registerBtn.disabled = true;
    await saveReceipt(receipt, items);
    showMessage(els.entryMessage, 'iPhone内のデータベースに登録しました。画像は保存していません。');
    els.monthPicker.value = monthKey;
    await refreshMonthly();
    await refreshSettings();
  } catch (error) {
    showMessage(els.entryMessage, `保存に失敗しました: ${error.message}`, true);
  } finally {
    els.registerBtn.disabled = false;
  }
}

function renderSummary(items) {
  const sums = Object.fromEntries(ALL_CATEGORIES.map(category => [category, 0]));
  for (const item of items) sums[item.category] = (sums[item.category] || 0) + item.paidAmount;

  els.monthSummary.innerHTML = '';
  ALL_CATEGORIES.forEach(category => {
    const card = document.createElement('div');
    card.className = 'summary-card';
    const label = document.createElement('span');
    label.textContent = category;
    const amount = document.createElement('strong');
    amount.className = 'money';
    amount.textContent = yen(sums[category]);
    card.append(label, amount);
    els.monthSummary.append(card);
  });
  els.monthTotal.textContent = yen(items.reduce((sum, item) => sum + item.paidAmount, 0));
}

async function refreshMonthly() {
  const monthKey = els.monthPicker.value || currentMonthKey();
  els.monthPicker.value = monthKey;
  hideMessage(els.monthlyMessage);

  try {
    const [receipts, items] = await Promise.all([
      listReceiptsByMonth(monthKey),
      listItemsByMonth(monthKey),
    ]);

    renderSummary(items);
    els.receiptCount.textContent = `${receipts.length}件`;
    els.deleteMonthBtn.disabled = receipts.length === 0;
    els.exportExcelBtn.disabled = receipts.length === 0;
    els.receiptList.innerHTML = '';

    if (!receipts.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'この月の購入データはありません。';
      els.receiptList.append(empty);
      return;
    }

    receipts.forEach(receipt => {
      const row = document.createElement('article');
      row.className = 'receipt-row';
      const main = document.createElement('div');
      main.className = 'receipt-main';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = receipt.storeName;
      const meta = document.createElement('div');
      meta.className = 'receipt-meta-line';
      meta.textContent = receipt.purchaseDate.replaceAll('-', '/');
      info.append(title, meta);
      const amount = document.createElement('strong');
      amount.className = 'money';
      amount.textContent = yen(receipt.total);
      main.append(info, amount);

      const actions = document.createElement('div');
      actions.className = 'receipt-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'receipt-delete';
      remove.textContent = 'このレシートを削除';
      remove.addEventListener('click', async () => {
        if (!confirm(`${receipt.storeName} ${yen(receipt.total)} を削除しますか？`)) return;
        await deleteReceipt(receipt.id);
        await refreshMonthly();
        await refreshSettings();
        showMessage(els.monthlyMessage, 'レシートを削除しました。分類ルールは残っています。');
      });
      actions.append(remove);
      row.append(main, actions);
      els.receiptList.append(row);
    });
  } catch (error) {
    showMessage(els.monthlyMessage, `読み込みに失敗しました: ${error.message}`, true);
  }
}

async function exportSelectedMonth() {
  const monthKey = els.monthPicker.value;
  if (!monthKey) return;
  hideMessage(els.monthlyMessage);
  els.exportExcelBtn.disabled = true;

  try {
    const [receipts, items] = await Promise.all([
      listReceiptsByMonth(monthKey),
      listItemsByMonth(monthKey),
    ]);
    if (!receipts.length) {
      showMessage(els.monthlyMessage, 'この月には出力する購入データがありません。', true);
      return;
    }

    const receiptMap = new Map(receipts.map(receipt => [receipt.id, receipt]));
    const sums = Object.fromEntries(ALL_CATEGORIES.map(category => [category, 0]));
    for (const item of items) sums[item.category] = (sums[item.category] || 0) + item.paidAmount;
    const total = items.reduce((sum, item) => sum + item.paidAmount, 0);

    const summaryRows = [
      ['カテゴリ', '税込金額'],
      ...ALL_CATEGORIES.map(category => [category, sums[category] || 0]),
      ['合計', total],
    ];
    const detailRows = [
      ['購入日', '店舗', '商品名', 'カテゴリ', '税込金額', 'レシート記載額', '自動初期分類', '手動指定'],
      ...items.map(item => {
        const receipt = receiptMap.get(item.receiptId);
        return [
          receipt?.purchaseDate || '', receipt?.storeName || '', item.itemName, item.category,
          item.paidAmount, item.printedAmount, item.aiCategory || '', item.manualSpecial || '',
        ];
      }).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])),
    ];
    const receiptRows = [
      ['購入日', '店舗', '小計', '税額', '税込合計', '登録日時'],
      ...[...receipts]
        .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.createdAt.localeCompare(b.createdAt))
        .map(receipt => [
          receipt.purchaseDate, receipt.storeName, receipt.subtotal, receipt.tax, receipt.total,
          receipt.createdAt ? new Date(receipt.createdAt).toLocaleString('ja-JP') : '',
        ]),
    ];

    const bytes = buildXlsx([
      { name: '月次集計', rows: summaryRows, widths: [22, 16], currencyColumns: [1], boldLastRow: true },
      { name: '購入明細', rows: detailRows, widths: [13, 22, 28, 16, 14, 16, 16, 14], currencyColumns: [4, 5] },
      { name: 'レシート一覧', rows: receiptRows, widths: [13, 22, 14, 12, 14, 22], currencyColumns: [2, 3, 4] },
    ]);

    const filename = `生活費レシート_${monthKey}.xlsx`;
    const result = await saveXlsxFile(bytes, filename);
    showMessage(
      els.monthlyMessage,
      result === 'shared'
        ? 'Excelを作成しました。共有メニューから「ファイルに保存」を選べます。'
        : 'Excelファイルを出力しました。'
    );
  } catch (error) {
    if (error?.name === 'AbortError') showMessage(els.monthlyMessage, 'Excel出力をキャンセルしました。');
    else showMessage(els.monthlyMessage, `Excel出力に失敗しました: ${error.message}`, true);
  } finally {
    try {
      const receipts = await listReceiptsByMonth(monthKey);
      els.exportExcelBtn.disabled = receipts.length === 0;
    } catch {
      els.exportExcelBtn.disabled = false;
    }
  }
}

async function deleteSelectedMonth() {
  const monthKey = els.monthPicker.value;
  if (!monthKey) return;
  if (!confirm(`${monthKey.replace('-', '年')}月の購入データをすべて削除しますか？\n分類ルールは残ります。`)) return;
  try {
    await deleteMonth(monthKey);
    await refreshMonthly();
    await refreshSettings();
    showMessage(els.monthlyMessage, 'この月の購入データを削除しました。分類ルールは残っています。');
  } catch (error) {
    showMessage(els.monthlyMessage, `削除に失敗しました: ${error.message}`, true);
  }
}

async function refreshSettings() {
  els.appVersion.textContent = `v${APP_VERSION}`;
  els.headerVersion.textContent = `v${APP_VERSION}`;
  try {
    const rules = await listRules();
    els.ruleCount.textContent = String(rules.length);
  } catch (error) {
    showMessage(els.settingsMessage, `設定の読み込みに失敗しました: ${error.message}`, true);
  }
}

async function clearAllPurchases() {
  if (!confirm('すべての購入データを削除しますか？\n分類ルールは残ります。')) return;
  await clearPurchaseData();
  await refreshMonthly();
  showMessage(els.settingsMessage, 'すべての購入データを削除しました。分類ルールは残っています。');
}

async function clearAllRules() {
  if (!confirm('学習した分類ルールをすべてリセットしますか？')) return;
  await clearRules();
  await refreshSettings();
  showMessage(els.settingsMessage, '分類ルールをリセットしました。');
}

async function clearAppCaches() {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(key => key.startsWith('receipt-pwa-'))
      .map(key => caches.delete(key))
  );
}

function setUpdateUi(message, busy = false) {
  els.updateAppBtn.disabled = busy;
  els.quickUpdateBtn.disabled = busy;
  els.updateStatus.textContent = message;
  els.quickUpdateBtn.textContent = busy ? '確認中…' : '更新';
}

async function checkAndUpdateApp() {
  setUpdateUi('最新版を確認しています…', true);
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('バージョン情報を取得できませんでした。');
    const { version: latest } = await response.json();
    if (!latest) throw new Error('バージョン情報が不正です。');

    if (latest === APP_VERSION) {
      // 同じバージョンでもService Workerに更新確認をかける。
      const registration = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration()
        : null;
      if (registration) await registration.update().catch(() => {});
      setUpdateUi(`v${APP_VERSION} が最新版です。`);
      els.quickUpdateBtn.textContent = '最新';
      setTimeout(() => { els.quickUpdateBtn.textContent = '更新'; }, 1800);
      return;
    }

    setUpdateUi(`v${latest} を検出しました。更新しています…`, true);
    updateReloadRequested = true;

    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update().catch(() => {});
        const waiting = registration.waiting;
        if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    }

    // 古いapp.js / ocr.jsが残らないよう、アプリ用Cache Storageだけ破棄する。
    // IndexedDB（家計データ）は削除しない。
    await clearAppCaches();

    const next = new URL('./', location.href);
    next.searchParams.set('v', latest);
    next.searchParams.set('t', String(Date.now()));
    location.replace(next.href);
  } catch (error) {
    setUpdateUi(`更新確認に失敗しました: ${error.message}`);
  }
}

function bindEvents() {
  els.tabs.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  els.cameraBtn.addEventListener('click', () => els.receiptCameraInput.click());
  els.photoBtn.addEventListener('click', () => els.receiptPhotoInput.click());
  els.receiptCameraInput.addEventListener('change', () => processReceiptImage(els.receiptCameraInput.files?.[0]));
  els.receiptPhotoInput.addEventListener('change', () => processReceiptImage(els.receiptPhotoInput.files?.[0]));
  els.loadSampleBtn.addEventListener('click', loadSample);
  els.clearDraftBtn.addEventListener('click', clearDraft);
  els.addItemBtn.addEventListener('click', addBlankItem);
  els.registerBtn.addEventListener('click', registerDraft);
  els.receiptTotal.addEventListener('input', () => {
    if (!draft) return;
    draft.total = integer(els.receiptTotal.value);
    updateTotalCheck();
  });
  els.monthPicker.addEventListener('change', refreshMonthly);
  els.exportExcelBtn.addEventListener('click', exportSelectedMonth);
  els.deleteMonthBtn.addEventListener('click', deleteSelectedMonth);
  els.updateAppBtn.addEventListener('click', checkAndUpdateApp);
  els.quickUpdateBtn.addEventListener('click', checkAndUpdateApp);
  els.clearPurchasesBtn.addEventListener('click', clearAllPurchases);
  els.clearRulesBtn.addEventListener('click', clearAllRules);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateReloadRequested) location.reload();
  });
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    registration.update().catch(() => {});
  } catch {
    // PWA update support is optional; the app can still use IndexedDB.
  }
}

async function init() {
  bindEvents();
  els.monthPicker.value = currentMonthKey();
  els.appVersion.textContent = `v${APP_VERSION}`;
  els.headerVersion.textContent = `v${APP_VERSION}`;

  if (!('indexedDB' in window)) {
    setDbStatus('保存不可', 'error');
    showMessage(els.entryMessage, 'このブラウザではIndexedDBを利用できません。', true);
    return;
  }

  try {
    await openDb();
    setDbStatus('端末内DB 接続済み');
    await refreshSettings();
    await refreshMonthly();
    await registerServiceWorker();
  } catch (error) {
    setDbStatus('DBエラー', 'error');
    showMessage(els.entryMessage, `データベースを開けませんでした: ${error.message}`, true);
  }
}

init();
