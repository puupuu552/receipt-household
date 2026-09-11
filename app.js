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
} from './db.js';
import { buildXlsx, saveXlsxFile } from './xlsx-export.js';

const AUTO_CATEGORIES = ['食費', 'お菓子・嗜好品', '果物', '野菜', '日用品'];
const ALL_CATEGORIES = [...AUTO_CATEGORIES, '母向け', 'その他'];

const SAMPLE = {
  // 公開リポジトリ用の完全なダミーデータです。実際のレシート情報ではありません。
  storeName: 'サンプルスーパー',
  subtotal: 1120,
  tax: 94,
  total: 1214,
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

const els = {
  dbStatus: document.querySelector('#dbStatus'),
  tabs: [...document.querySelectorAll('.tab')],
  views: {
    entry: document.querySelector('#entryView'),
    monthly: document.querySelector('#monthlyView'),
    settings: document.querySelector('#settingsView'),
  },
  loadSampleBtn: document.querySelector('#loadSampleBtn'),
  clearDraftBtn: document.querySelector('#clearDraftBtn'),
  receiptMeta: document.querySelector('#receiptMeta'),
  purchaseDate: document.querySelector('#purchaseDate'),
  storeName: document.querySelector('#storeName'),
  itemList: document.querySelector('#itemList'),
  totalCard: document.querySelector('#totalCard'),
  receiptTotal: document.querySelector('#receiptTotal'),
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

async function loadSample() {
  hideMessage(els.entryMessage);
  const items = [];

  for (const source of SAMPLE.items) {
    const rule = await findRule(source.itemName);
    const category = rule?.category || source.aiCategory;
    items.push({
      ...source,
      itemName: source.itemName,
      category,
      manualSpecial: null,
      reviewed: Boolean(rule) || !source.needsReview,
    });
  }

  draft = {
    purchaseDate: localDateKey(),
    storeName: SAMPLE.storeName,
    subtotal: SAMPLE.subtotal,
    tax: SAMPLE.tax,
    total: SAMPLE.total,
    items,
  };

  renderDraft();
}

function clearDraft() {
  draft = null;
  els.receiptMeta.classList.add('hidden');
  els.itemList.innerHTML = '';
  els.totalCard.classList.add('hidden');
  els.registerBtn.classList.add('hidden');
  els.clearDraftBtn.disabled = true;
  hideMessage(els.entryMessage);
}

function renderDraft() {
  if (!draft) return clearDraft();

  els.receiptMeta.classList.remove('hidden');
  els.totalCard.classList.remove('hidden');
  els.registerBtn.classList.remove('hidden');
  els.clearDraftBtn.disabled = false;
  els.purchaseDate.value = draft.purchaseDate;
  els.storeName.value = draft.storeName;
  els.receiptTotal.textContent = yen(draft.total);
  els.itemList.innerHTML = '';

  draft.items.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = `item-card${item.reviewed ? '' : ' needs-review'}`;

    const head = document.createElement('div');
    head.className = 'item-head';

    const state = document.createElement('span');
    if (item.reviewed) {
      state.className = 'item-state';
      state.textContent = item.category !== item.aiCategory && !item.manualSpecial ? '学習ルール適用' : 'AI判定済み';
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
      renderDraft();
    });
    categoryField.append(select);

    const manualLabel = document.createElement('span');
    manualLabel.className = 'manual-label';
    manualLabel.textContent = '手動指定';

    const manualButtons = document.createElement('div');
    manualButtons.className = 'manual-buttons';
    const modes = [
      { label: '通常', value: null },
      { label: '母向け', value: '母向け' },
      { label: 'その他', value: 'その他' },
    ];

    modes.forEach(mode => {
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
    note.textContent = `レシート記載 ${yen(item.printedAmount)}（税抜） → 税込計上 ${yen(item.paidAmount)}`;

    card.append(head, nameField, categoryField, manualLabel, manualButtons, note);
    els.itemList.append(card);
  });
}

async function registerDraft() {
  if (!draft) return;
  hideMessage(els.entryMessage);

  draft.purchaseDate = els.purchaseDate.value;
  draft.storeName = els.storeName.value.trim();

  if (!draft.purchaseDate || !draft.storeName) {
    showMessage(els.entryMessage, '購入日と店舗名を入力してください。', true);
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

  const monthKey = draft.purchaseDate.slice(0, 7);
  const receiptId = makeId('receipt');
  const createdAt = new Date().toISOString();
  const receipt = {
    id: receiptId,
    purchaseDate: draft.purchaseDate,
    monthKey,
    storeName: draft.storeName,
    subtotal: draft.subtotal,
    tax: draft.tax,
    total: draft.total,
    createdAt,
  };

  const items = draft.items.map(item => ({
    id: makeId('item'),
    receiptId,
    monthKey,
    itemName: item.itemName.trim(),
    printedAmount: item.printedAmount,
    paidAmount: item.paidAmount,
    aiCategory: item.aiCategory,
    category: item.manualSpecial || item.category,
    manualSpecial: item.manualSpecial,
    wasReviewed: item.reviewed,
    createdAt,
  }));

  try {
    els.registerBtn.disabled = true;
    await saveReceipt(receipt, items);
    showMessage(els.entryMessage, 'iPhone内のデータベースに登録しました。ページを閉じても残ります。');
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
      ['購入日', '店舗', '商品名', 'カテゴリ', '税込金額', 'レシート記載額', 'AI初期分類', '手動指定'],
      ...items
        .map(item => {
          const receipt = receiptMap.get(item.receiptId);
          return [
            receipt?.purchaseDate || '',
            receipt?.storeName || '',
            item.itemName,
            item.category,
            item.paidAmount,
            item.printedAmount,
            item.aiCategory || '',
            item.manualSpecial || '',
          ];
        })
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])),
    ];

    const receiptRows = [
      ['購入日', '店舗', '小計', '税額', '税込合計', '登録日時'],
      ...[...receipts]
        .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.createdAt.localeCompare(b.createdAt))
        .map(receipt => [
          receipt.purchaseDate,
          receipt.storeName,
          receipt.subtotal,
          receipt.tax,
          receipt.total,
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
    if (error?.name === 'AbortError') {
      showMessage(els.monthlyMessage, 'Excel出力をキャンセルしました。');
    } else {
      showMessage(els.monthlyMessage, `Excel出力に失敗しました: ${error.message}`, true);
    }
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

function bindEvents() {
  els.tabs.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  els.loadSampleBtn.addEventListener('click', loadSample);
  els.clearDraftBtn.addEventListener('click', clearDraft);
  els.registerBtn.addEventListener('click', registerDraft);
  els.monthPicker.addEventListener('change', refreshMonthly);
  els.exportExcelBtn.addEventListener('click', exportSelectedMonth);
  els.deleteMonthBtn.addEventListener('click', deleteSelectedMonth);
  els.clearPurchasesBtn.addEventListener('click', clearAllPurchases);
  els.clearRulesBtn.addEventListener('click', clearAllRules);
}

async function init() {
  bindEvents();
  els.monthPicker.value = currentMonthKey();

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

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then(registration => registration.update())
        .catch(() => {});
    }
  } catch (error) {
    setDbStatus('DBエラー', 'error');
    showMessage(els.entryMessage, `データベースを開けませんでした: ${error.message}`, true);
  }
}

init();
