const state = {
  cards: [],
  stores: [],
  ownedCardIds: new Set(),
  seenCardIds: new Set(),
  lastQuery: '',
  expandedCardId: null,
  cardOrder: [],
  searchHistory: [],
  storeIndex: new Map(), // normalized name -> {name, category}
  categoryToStores: new Map(), // normalized category -> [store, ...]
  storeCategoryFilter: null, // 店舗一覧タブで選択中のカテゴリ(nullならカテゴリ選択画面)
  coupons: [], // ユーザーが手入力したクーポン {id, storeName, discount, source}
};

const TOP_STORES_LIMIT = 30;
const SEARCH_HISTORY_LIMIT = 8;
const OWNERSHIP_KEY = 'cardOwnership';
const LEGACY_OWNED_CARDS_KEY = 'ownedCardIds';
const SEARCH_HISTORY_KEY = 'searchHistory';
const COUPONS_KEY = 'coupons';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

// 全角/半角(英数字・カタカナ)や大文字/小文字の違いを吸収して比較できるようにする。
function normalizeText(s) {
  if (!s) return '';
  return s.normalize('NFKC').toLowerCase().trim();
}

async function loadData() {
  try {
    const [cardsRes, storesRes] = await Promise.all([
      fetch('data/cards.json'),
      fetch('data/stores.json'),
    ]);
    if (!cardsRes.ok || !storesRes.ok) return false;
    state.cards = await cardsRes.json();
    state.stores = await storesRes.json();
    return true;
  } catch {
    return false;
  }
}

// 検索を高速かつ安全に行うため、カードごとの店舗/カテゴリをMapに正規化しておく。
// (Mapを使うことで "constructor" のようなJSの予約語的なキーを店名検索しても
// プロトタイプ汚染で壊れない)
function buildIndexes() {
  state.storeIndex = new Map();
  state.categoryToStores = new Map();
  for (const store of state.stores) {
    state.storeIndex.set(normalizeText(store.name), store);
    if (!store.category || store.category === '未分類') continue;
    const normalizedCategory = normalizeText(store.category);
    if (!state.categoryToStores.has(normalizedCategory)) {
      state.categoryToStores.set(normalizedCategory, []);
    }
    state.categoryToStores.get(normalizedCategory).push(store);
  }

  for (const card of state.cards) {
    card.storeIndex = new Map();
    for (const [name, entry] of Object.entries(card.rates.stores)) {
      card.storeIndex.set(normalizeText(name), { name, rate: entry.rate, channel: entry.channel || 'store' });
    }

    // 手入力のcategories(飲食・コンビニ等)は一部のカードにしか設定されておらず、
    // 店舗単位のデータが充実したカード(三井住友・Oliveなど)ではカテゴリ検索が
    // 全く効かなくなっていた。そこで、そのカードが対象にしている店舗のうち
    // 該当カテゴリに属する店の最大還元率を動的に算出し、手入力のcategories(あれば)
    // と比べて高い方を採用する。どの店舗を根拠にした数字かも保持しておき、
    // 「そのカテゴリの全店で使えるわけではない」ことを検索結果で明示できるようにする。
    card.categoryIndex = new Map();
    for (const [name, rate] of Object.entries(card.rates.categories)) {
      card.categoryIndex.set(normalizeText(name), { rate, sourceStore: null });
    }
    for (const { name, rate } of card.storeIndex.values()) {
      const storeInfo = state.storeIndex.get(normalizeText(name));
      const category = storeInfo?.category;
      if (!category || category === '未分類') continue;
      const normalizedCategory = normalizeText(category);
      const current = card.categoryIndex.get(normalizedCategory);
      if (current === undefined || rate > current.rate) {
        card.categoryIndex.set(normalizedCategory, { rate, sourceStore: name });
      }
    }
  }
}

function loadOwnership() {
  let owned = new Set();
  let seen = new Set();
  try {
    const raw = localStorage.getItem(OWNERSHIP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      owned = new Set(parsed.ownedCardIds || []);
      seen = new Set(parsed.seenCardIds || []);
    } else {
      // 旧形式(所持IDの配列のみ)からの移行。
      // 旧UIでも全カードのトグルが見えていたので、その時点で存在した全カードを
      // 「確認済み」として扱う(そうしないと、明示的にOFFにしていたカードまで
      // 「未確認の新カード」と誤認されて所持済みに戻ってしまう)。
      const legacyRaw = localStorage.getItem(LEGACY_OWNED_CARDS_KEY);
      if (legacyRaw) {
        const legacyIds = JSON.parse(legacyRaw);
        owned = new Set(legacyIds);
        seen = new Set(state.cards.map((c) => c.id));
      }
    }
  } catch {
    // 壊れた値は無視して初期状態から始める
  }
  // 新しく追加されたカード(未確認)はデフォルトで所持している扱いにする
  for (const card of state.cards) {
    if (!seen.has(card.id)) {
      seen.add(card.id);
      owned.add(card.id);
    }
  }
  return { owned, seen };
}

function saveOwnership() {
  localStorage.setItem(
    OWNERSHIP_KEY,
    JSON.stringify({ ownedCardIds: [...state.ownedCardIds], seenCardIds: [...state.seenCardIds] })
  );
}

function setCardOwned(cardId, owned) {
  if (owned) state.ownedCardIds.add(cardId);
  else state.ownedCardIds.delete(cardId);
  saveOwnership();
  renderCardList();
  renderResults(state.lastQuery);
}

function loadSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore malformed value
  }
  return [];
}

function saveSearchHistory() {
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(state.searchHistory));
}

function addSearchHistory(query) {
  const normalized = normalizeText(query);
  state.searchHistory = state.searchHistory.filter((q) => normalizeText(q) !== normalized);
  state.searchHistory.unshift(query);
  state.searchHistory = state.searchHistory.slice(0, SEARCH_HISTORY_LIMIT);
  saveSearchHistory();
  renderSearchHistory();
}

function renderSearchHistory() {
  const container = document.getElementById('search-history');
  if (!container) return;
  if (state.searchHistory.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = state.searchHistory
    .map((q) => `<button type="button" class="chip" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
    .join('');
  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const query = chip.dataset.query;
      const input = document.getElementById('search-input');
      input.value = query;
      renderResults(query);
    });
  });
}

// クーポン(福利厚生サービス等)はログイン必須のサービスが多く自動取得できないため、
// ユーザー本人が知っているクーポンを手入力しておく機能。データは端末内のみに保存され、
// 登録した店舗を検索した時に還元率の結果と一緒に表示される(割引とカード還元は併用できる
// ことが多いため、両方見えるようにする)。
function loadCoupons() {
  try {
    const raw = localStorage.getItem(COUPONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore malformed value
  }
  return [];
}

function saveCoupons() {
  localStorage.setItem(COUPONS_KEY, JSON.stringify(state.coupons));
}

function addCoupon(storeName, discount, cardName, source) {
  state.coupons.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    storeName,
    discount,
    cardName: cardName || null,
    source: source || null,
  });
  saveCoupons();
  renderCouponList();
}

function deleteCoupon(id) {
  state.coupons = state.coupons.filter((c) => c.id !== id);
  saveCoupons();
  renderCouponList();
}

function updateCoupon(id, updates) {
  const coupon = state.coupons.find((c) => c.id === id);
  if (!coupon) return;
  Object.assign(coupon, updates);
  saveCoupons();
  renderCouponList();
}

// 文字数だけ比較する簡易編集距離(レーベンシュタイン距離)。OCR由来の店名は
// 1〜2文字だけ読み違えることがあるため、完全一致だけだと拾い漏れる。
function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// 完全一致するクーポンがあればそれを優先し、無ければあいまい一致(部分一致・数文字程度の
// 読み取りゆれ)で探す。OCRで登録した店名が検索語と1文字違うだけで見つからない、
// という事態を避けるための救済措置。
function findCouponForStore(normalizedStoreName) {
  if (!normalizedStoreName) return null;

  const exact = state.coupons.find((c) => normalizeText(c.storeName) === normalizedStoreName);
  if (exact) return exact;

  return (
    state.coupons.find((c) => {
      const n = normalizeText(c.storeName);
      if (!n) return false;
      if (n.includes(normalizedStoreName) || normalizedStoreName.includes(n)) return true;
      const maxLen = Math.max(n.length, normalizedStoreName.length);
      const allowedDistance = maxLen <= 4 ? 0 : maxLen <= 8 ? 1 : 2;
      return levenshteinDistance(n, normalizedStoreName) <= allowedDistance;
    }) || null
  );
}

function renderCouponList() {
  const list = document.getElementById('coupon-list');
  if (!list) return;
  list.innerHTML = '';

  if (state.coupons.length === 0) {
    list.innerHTML = '<li class="empty-state">登録済みのクーポンはまだありません</li>';
    return;
  }

  state.coupons.forEach((coupon) => {
    const li = document.createElement('li');
    li.className = 'result-item';
    renderCouponListItem(li, coupon);
    list.appendChild(li);
  });
}

function renderCouponListItem(li, coupon) {
  const meta = [coupon.cardName, coupon.source].filter(Boolean).join(' ・ ');
  li.innerHTML = `
    <div>
      <span class="item-name">${escapeHtml(coupon.storeName)}</span>
      <div class="item-note">${escapeHtml(coupon.discount)}${meta ? ` ・ ${escapeHtml(meta)}` : ''}</div>
    </div>
    <div class="coupon-item-actions">
      <button type="button" class="coupon-edit-btn" aria-label="編集">✎</button>
      <button type="button" class="coupon-delete-btn" aria-label="削除">×</button>
    </div>
  `;
  li.querySelector('.coupon-delete-btn').addEventListener('click', () => deleteCoupon(coupon.id));
  li.querySelector('.coupon-edit-btn').addEventListener('click', () => renderCouponEditForm(li, coupon));
}

function renderCouponEditForm(li, coupon) {
  li.innerHTML = `
    <div class="coupon-edit-form">
      <input type="text" class="coupon-edit-store" value="${escapeHtml(coupon.storeName)}" placeholder="店名" aria-label="店名">
      <input type="text" class="coupon-edit-discount" value="${escapeHtml(coupon.discount)}" placeholder="内容(例: 10%OFF)" aria-label="割引内容">
      <input type="text" class="coupon-edit-card" list="card-suggestions" value="${escapeHtml(coupon.cardName || '')}" placeholder="カード名(任意)" aria-label="カード名">
      <input type="text" class="coupon-edit-source" value="${escapeHtml(coupon.source || '')}" placeholder="入手元(任意)" aria-label="入手元">
      <div class="coupon-edit-actions">
        <button type="button" class="btn-primary coupon-edit-save">保存</button>
        <button type="button" class="btn-secondary coupon-edit-cancel">キャンセル</button>
      </div>
    </div>
  `;
  li.querySelector('.coupon-edit-save').addEventListener('click', () => {
    const storeName = li.querySelector('.coupon-edit-store').value.trim();
    const discount = li.querySelector('.coupon-edit-discount').value.trim();
    const cardName = li.querySelector('.coupon-edit-card').value.trim();
    const source = li.querySelector('.coupon-edit-source').value.trim();
    if (!storeName || !discount) return;
    updateCoupon(coupon.id, { storeName, discount, cardName: cardName || null, source: source || null });
  });
  li.querySelector('.coupon-edit-cancel').addEventListener('click', () => renderCouponListItem(li, coupon));
}

function initCouponForm() {
  const form = document.getElementById('coupon-add-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const storeInput = document.getElementById('coupon-store-input');
    const discountInput = document.getElementById('coupon-discount-input');
    const cardInput = document.getElementById('coupon-card-input');
    const sourceInput = document.getElementById('coupon-source-input');

    const storeName = storeInput.value.trim();
    const discount = discountInput.value.trim();
    const cardName = cardInput.value.trim();
    const source = sourceInput.value.trim();
    if (!storeName || !discount) return;

    addCoupon(storeName, discount, cardName, source);
    form.reset();
    storeInput.focus();
  });

  const imageInput = document.getElementById('coupon-image-input');
  if (imageInput) {
    imageInput.addEventListener('change', () => {
      const file = imageInput.files?.[0];
      if (file) runCouponOcr(file);
      imageInput.value = ''; // 同じ画像を選び直した時も change が発火するようにする
    });
  }
}

// Tesseract.js本体(~8MB)は初回のOCR利用時にだけ読み込む(通常利用では取得しない)。
// CDNではなく自前ホスト(vendor/tesseract/)のファイルだけを使うので、外部通信は発生しない。
let tesseractLoadPromise = null;
function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoadPromise) {
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/tesseract/tesseract.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Tesseractの読み込みに失敗しました'));
      document.head.appendChild(script);
    });
  }
  return tesseractLoadPromise;
}

// ベネフィット・ワン等のクーポン一覧画面は1枚のスクショに複数件並んでいることが多く、
// タブ名や並び替えメニュー・件数表示のようなUI装飾テキストも大量に混ざる。そのため
// 「1件だけ」前提ではなく、割引・還元率らしき行を全部拾い、それぞれの直前数行から
// 店名らしき行を探す方式にしている。カード名はアプリが知っているカード名がテキスト中に
// そのまま含まれていないかを画像全体から探す。
const OCR_CHROME_BLOCKLIST = [
  'マイクーポン', 'マイクーボン', 'デジタルチケット', 'デジタルクーポン', 'デジタルクーボン',
  '会員証クーポン', '取得日', '件中', '表示', '削除', '有効期限', 'メニューNo', 'メニュー No',
];

// スクショ圧縮の影響で「%」が「9」や「%%」等に化けても、OFF/オフの直前にある
// 主要な桁(通常1〜2桁)自体は読めていることが多い。そこで「数字+多少のノイズ+OFF等」
// という形から割引率を復元し、正規化した表記(例:「10%OFF」)を返す。
// 実例: 「1096OFF」「109%6OFF」「10%6OFF」「109%%OFF」→ すべて「10%OFF」に復元できる。
function extractDiscountValue(rawLine) {
  const line = rawLine.replace(/[,、\s]/g, '');

  let m = line.match(/([0-9]{1,2})[0-9%％]{0,3}\s*(?:%|％|OFF|0FF|OFI|OF|オフ)/i);
  if (m) return `${m[1]}%OFF`;

  m = line.match(/([0-9]{1,2})[0-9%％]{0,3}\s*引き/);
  if (m) return `${m[1]}%引き`;

  m = line.match(/([0-9,]{3,6})円\s*(?:引き|OFF|オフ)/i);
  if (m) return `${m[1].replace(/,/g, '')}円引き`;

  m = line.match(/([0-9]{1,3})[0-9%％]{0,2}\s*(還元|ポイント|倍)/);
  if (m) return `${m[1]}${m[2]}`;

  if (/無料/.test(line)) return '無料';

  return null;
}

function isOcrDiscountLine(line) {
  return extractDiscountValue(line) !== null;
}

// 画面全体のスクショには、スマホのステータスバー(時刻・電波・バッテリー等のアイコン)や
// ブラウザのURLバーが写り込むことが多い。これらは小さいアイコンの寄せ集めなので
// OCRが「11:47 の る NISS 5」のような意味不明な断片として1行にまとめて読み取ってしまい、
// 何も対策しないと店名候補として拾われてしまう(実際に発生した不具合)。
function isOcrChromeLine(line) {
  if (!line) return true;
  if (/^[\[【].*[\]】]$/.test(line)) return true; // [メニューNo.xxxx] のような行
  if (/^[0-9０-９]+$/.test(line)) return true; // 数字だけの行
  if (/^\d{1,2}[:：]\d{2}\b/.test(line)) return true; // 行頭が時刻(ステータスバー行)
  if (/https?:\/\/|www\.|\.(com|jp|inc|net|co)\b/i.test(line)) return true; // URLらしき行(アドレスバー)
  return OCR_CHROME_BLOCKLIST.some((w) => line.includes(w));
}

// 「メニューNo.」はクーポン1件ごとの見出しとして必ず現れるアンカーなので、これで
// 行を区切ってから各区画内で店名・割引を探す方が、割引行から数行遡って探すよりも
// レイアウト崩れに強い(店名の前に何行チラつくかを推測しなくて済む)。
function splitIntoCouponChunks(lines) {
  const anchorRegex = /メニュー\s*No/i;
  const chunks = [];
  let current = null;
  lines.forEach((line) => {
    if (anchorRegex.test(line)) {
      current = [];
      chunks.push(current);
      return;
    }
    if (current) current.push(line);
  });
  return chunks;
}

function guessCouponsFromChunks(lines, cardName) {
  const chunks = splitIntoCouponChunks(lines);
  const candidates = [];
  chunks.forEach((chunkLines) => {
    let storeName = '';
    let discount = null;
    chunkLines.forEach((line) => {
      const value = extractDiscountValue(line);
      if (value !== null) {
        if (discount === null) discount = value; // 小見出し+強調見出しの重複は最初の1件だけ採用
        return;
      }
      if (!storeName && !isOcrChromeLine(line)) storeName = line;
    });
    if (discount === null) return; // 割引が全く読めなければ登録候補にしない
    candidates.push({ storeName, discount, cardName });
  });
  return candidates;
}

// 「メニューNo.」のアンカーが見つからない場合(レイアウトが異なる/読み取れなかった場合)の
// フォールバック。割引らしき行から数行遡って店名らしき行を探す。
function guessCouponsByBackwardScan(lines, cardName) {
  const candidates = [];
  let lastStoreName = null;
  let lastStoreIdx = -Infinity;

  lines.forEach((line, idx) => {
    const value = extractDiscountValue(line);
    if (value === null) return;

    const prevLine = lines[idx - 1];
    if (prevLine && isOcrDiscountLine(prevLine) && candidates.length > 0) {
      return; // 直前行もすでに割引行として処理済み=同じクーポンの2回目の表示
    }

    let storeName = '';
    for (let back = 1; back <= 6; back++) {
      const candidate = lines[idx - back];
      if (!candidate) break;
      if (isOcrDiscountLine(candidate)) break; // 1つ前のクーポンの割引行に突き当たったら打ち切る
      if (!isOcrChromeLine(candidate)) {
        storeName = candidate;
        break;
      }
    }

    if (storeName === lastStoreName && idx - lastStoreIdx <= 4) return;
    lastStoreName = storeName;
    lastStoreIdx = idx;

    candidates.push({ storeName, discount: value, cardName });
  });

  return candidates;
}

function guessCouponsFromOcrText(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const normalizedFullText = normalizeText(text);
  const matchedCard = state.cards.find((c) => normalizedFullText.includes(normalizeText(c.name)));
  const cardName = matchedCard ? matchedCard.name : '';

  const chunkCandidates = guessCouponsFromChunks(lines, cardName);
  if (chunkCandidates.length > 0) return chunkCandidates;

  return guessCouponsByBackwardScan(lines, cardName);
}

function renderCouponOcrCandidates(candidates) {
  const container = document.getElementById('coupon-ocr-candidates');
  if (!container) return;

  if (candidates.length === 0) {
    container.innerHTML = '';
    return;
  }

  // 店名の自動判定は外れることがある(ステータスバーの誤読等)ため、チェックだけでなく
  // その場で書き換えられるようにしておく。間違っていてもチェックを外さず直せば済む。
  container.innerHTML = `
    <p class="hint">${candidates.length}件見つかりました。店名が違っていたら書き換えてから、登録したいものだけチェックしてください。</p>
    <ul class="ocr-candidate-list">
      ${candidates
        .map(
          (c, i) => `
            <li class="ocr-candidate-item">
              <div class="ocr-candidate-row">
                <input type="checkbox" checked data-index="${i}" class="ocr-candidate-check">
                <input type="text" value="${escapeHtml(c.storeName)}" placeholder="店名を入力" data-index="${i}" class="ocr-candidate-store-input" aria-label="店名">
              </div>
              <div class="ocr-candidate-row ocr-candidate-discount-row">
                <input type="text" value="${escapeHtml(c.discount)}" placeholder="例: 10%OFF" data-index="${i}" class="ocr-candidate-discount-input" aria-label="割引内容">
              </div>
              ${c.cardName ? `<div class="item-note">${escapeHtml(c.cardName)}</div>` : ''}
            </li>`
        )
        .join('')}
    </ul>
    <button type="button" id="coupon-ocr-add-selected" class="btn-primary">選んだものを追加</button>
  `;

  document.getElementById('coupon-ocr-add-selected').addEventListener('click', () => {
    const items = [...container.querySelectorAll('.ocr-candidate-item')];
    let addedCount = 0;
    items.forEach((li) => {
      const checkbox = li.querySelector('.ocr-candidate-check');
      if (!checkbox.checked) return;
      const storeInput = li.querySelector('.ocr-candidate-store-input');
      const storeName = storeInput.value.trim();
      const discountInput = li.querySelector('.ocr-candidate-discount-input');
      const discount = discountInput.value.trim();
      if (!storeName || !discount) return;
      const c = candidates[Number(checkbox.dataset.index)];
      addCoupon(storeName, discount, c.cardName, '');
      addedCount += 1;
    });
    container.innerHTML = '';
    document.getElementById('coupon-ocr-status').textContent = `${addedCount}件登録しました。`;
  });
}

// LINE等のアプリ経由で共有されたスクショは再圧縮されていることが多く、解像度が低いまま
// OCRにかけると「%」と「9」、「O」と「0/6」のような紛らわしい文字を誤読しやすい
// (実際に「10%OFF」が「1096OFF」と誤読される事例が発生)。認識前に画像を拡大し、
// グレースケール化とコントラスト強調をかけることで文字の輪郭をはっきりさせ、
// 誤読を減らす。
async function preprocessImageForOcr(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const targetWidth = Math.min(Math.max(bitmap.width * 2, 1600), 4500);
    const scale = targetWidth / bitmap.width;
    const targetHeight = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imageData.data;
    const contrast = 1.35;
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const adjusted = Math.min(255, Math.max(0, (gray - 128) * contrast + 128));
      data[i] = data[i + 1] = data[i + 2] = adjusted;
    }
    ctx.putImageData(imageData, 0, 0);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob || file;
  } catch (err) {
    return file; // 前処理に失敗しても元画像でOCRを続行する
  }
}

async function runCouponOcr(file) {
  const status = document.getElementById('coupon-ocr-status');
  const rawTextEl = document.getElementById('coupon-ocr-raw');
  const storeInput = document.getElementById('coupon-store-input');
  const discountInput = document.getElementById('coupon-discount-input');
  const cardInput = document.getElementById('coupon-card-input');
  document.getElementById('coupon-ocr-candidates').innerHTML = '';
  rawTextEl.innerHTML = '';

  status.textContent = 'OCRを準備中...';
  try {
    await loadTesseractScript();
    status.textContent = '画像を読み取り中...(初回は数十秒かかります)';

    // 高精度版(jpnbest)や明示的なPSM指定も試したが、実際にテスト画像で比較したところ
    // このアプリの前処理(拡大+コントラスト強調)との相性が悪く、文字間に不要な
    // スペースが入ったり軽量版より誤読が増える結果になったため、軽量版(jpn)のまま
    // にしている。DPI指定だけは(悪化は確認されず、理論的にも妥当なため)残す。
    const worker = await Tesseract.createWorker('jpn', 1, {
      workerPath: 'vendor/tesseract/worker.min.js',
      corePath: 'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: 'vendor/tesseract/',
      gzip: true,
    });
    await worker.setParameters({
      // canvasで生成したPNGはDPI情報を持たず低DPI相当に解釈されてしまうため、明示的に指定する。
      user_defined_dpi: '300',
    });
    const processedImage = await preprocessImageForOcr(file);
    const {
      data: { text },
    } = await worker.recognize(processedImage);
    await worker.terminate();

    // 自動判定(店名・割引・カード名の推測)が外れることは珍しくないので、
    // 判定結果に関わらず読み取った生テキストは常に見られるようにしておく
    // (自動入力が間違っていた時に、ここからコピーして手直しできる)。
    if (text.trim()) {
      rawTextEl.innerHTML = `<summary>読み取った文字を見る</summary><pre>${escapeHtml(text.trim())}</pre>`;
    }

    const candidates = guessCouponsFromOcrText(text);

    if (candidates.length === 0) {
      status.textContent = text.trim()
        ? '店名や割引を特定できませんでした。下の読み取り結果を参考に手入力してください。'
        : '文字を読み取れませんでした。手入力してください。';
    } else if (candidates.length === 1) {
      // 1件だけならそのままフォームに入れる
      const c = candidates[0];
      if (c.storeName && !storeInput.value) storeInput.value = c.storeName;
      if (c.discount && !discountInput.value) discountInput.value = c.discount;
      if (c.cardName && !cardInput.value) cardInput.value = c.cardName;
      if (c.storeName) {
        status.textContent = '読み取り結果を自動入力しました。違っていたら書き換えてください。';
      } else {
        // 割引は読めたが店名は読み取れなかった場合、入力欄にフォーカスして手入力を促す
        status.textContent = '割引だけ読み取れました。店名を入力してください。';
        storeInput.focus();
      }
    } else {
      // 1枚に複数のクーポンが写っている場合(クーポン一覧のスクショ等)は選んで一括登録できるようにする
      renderCouponOcrCandidates(candidates);
      status.textContent = `${candidates.length}件見つかりました。店名が違っていたら書き換えてください。`;
    }
  } catch (err) {
    status.textContent = `読み取りに失敗しました: ${err.message}`;
  }
}

function rateForCard(card, normalizedQuery, normalizedCategory, isSpecificStoreQuery) {
  const storeMatch = card.storeIndex.get(normalizedQuery);
  if (storeMatch) {
    return { rate: storeMatch.rate, channel: storeMatch.channel, note: card.notes[storeMatch.name] || null, matched: 'store' };
  }
  if (normalizedCategory && card.categoryIndex.has(normalizedCategory)) {
    const { rate, sourceStore } = card.categoryIndex.get(normalizedCategory);
    // sourceStoreがある場合、そのカードの「別の1店舗」の実績から逆算した推定値であって、
    // カテゴリ内の全店で使える保証はない。なので、検索語がまさにその「特定の店名」に
    // 一致していて、かつこのカードにその店の個別データが無い場合は、
    // (対象外の可能性が高いので)このカテゴリ推定値は使わずbaseRateへ進む。
    // 「コンビニ」のような曖昧なカテゴリ語で検索した時だけ、参考値として表示する。
    if (isSpecificStoreQuery && sourceStore !== null) {
      return { rate: card.baseRate, channel: 'store', note: card.baseNote || null, matched: 'base' };
    }
    const note = sourceStore ? `${sourceStore}などの一部店舗が対象(店舗ごとに異なる場合があります)` : null;
    return { rate, channel: 'store', note, matched: 'category' };
  }
  return { rate: card.baseRate, channel: 'store', note: card.baseNote || null, matched: 'base' };
}

function renderCategoryStores(normalizedCategory) {
  const container = document.getElementById('category-stores');
  if (!container) return;
  const stores = state.categoryToStores.get(normalizedCategory);
  if (!stores || stores.length === 0) {
    container.innerHTML = '';
    return;
  }
  const chips = stores
    .map((s) => `<button type="button" class="chip" data-query="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`)
    .join('');
  container.innerHTML = `
    <p class="hint category-stores-hint">この分類の店舗(タップで個別に検索)</p>
    <div class="chip-row">${chips}</div>
  `;
  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const storeName = chip.dataset.query;
      const input = document.getElementById('search-input');
      input.value = storeName;
      renderResults(storeName);
      addSearchHistory(storeName);
    });
  });
}

function renderResults(query) {
  state.lastQuery = query;
  const list = document.getElementById('result-list');
  list.innerHTML = '';

  const ownedCards = state.cards.filter((card) => state.ownedCardIds.has(card.id));

  if (!query) {
    // 何も入力していない時は「店舗一覧」を吸収したカテゴリ絞り込みを見せる
    // (検索とカテゴリ閲覧は結局同じ「店を探す」機能なので、タブを分けずに1つにまとめてある)。
    renderCategoryStores('');
    renderStoreCategoryNav();
    renderStoreList();
    if (ownedCards.length === 0) {
      list.innerHTML = '<li class="empty-state">「カード一覧」で持っているカードを選んでください</li>';
    }
    return;
  }

  document.getElementById('store-category-nav').innerHTML = '';
  document.getElementById('store-list').innerHTML = '';

  if (ownedCards.length === 0) {
    list.innerHTML = '<li class="empty-state">「カード一覧」で持っているカードを選んでください</li>';
    renderCategoryStores('');
    return;
  }

  const normalizedQuery = normalizeText(query);
  const storeEntry = state.storeIndex.get(normalizedQuery);
  const normalizedCategory = normalizeText(storeEntry ? storeEntry.category : query);

  // 入力そのものが特定の店名に一致しなかった場合(=カテゴリ名として解釈された場合)のみ、
  // そのカテゴリに属する店舗一覧をチップで表示する。特定の店を検索した時は不要。
  renderCategoryStores(storeEntry ? '' : normalizedCategory);

  const coupon = findCouponForStore(normalizedQuery);
  if (coupon) {
    const metaText = [coupon.cardName, coupon.source].filter(Boolean).map(escapeHtml).join(' ・ ');
    const noteLine = coupon.cardName
      ? `${escapeHtml(coupon.storeName)}に登録したお得情報${metaText ? ` ・ ${metaText}` : ''}`
      : `${escapeHtml(coupon.storeName)}のクーポン${metaText ? `(${metaText})` : ''} ・ カード還元と併用できる場合があります`;
    const couponLi = document.createElement('li');
    couponLi.className = 'coupon-banner';
    couponLi.innerHTML = `
      <span class="coupon-banner-icon" aria-hidden="true">🎫</span>
      <div>
        <div class="coupon-banner-title">${escapeHtml(coupon.discount)}</div>
        <div class="coupon-banner-note">${noteLine}</div>
      </div>
    `;
    list.appendChild(couponLi);
  }

  const results = ownedCards.map((card) => ({ card, ...rateForCard(card, normalizedQuery, normalizedCategory, !!storeEntry) }));
  const hasRealMatch = results.some((r) => r.matched !== 'base');
  const bestRate = hasRealMatch
    ? Math.max(...results.filter((r) => r.matched !== 'base').map((r) => r.rate))
    : null;

  results.sort((a, b) => b.rate - a.rate);

  if (!hasRealMatch) {
    const notice = document.createElement('li');
    notice.className = 'empty-state notice-inline';
    notice.textContent = `「${query}」の店舗別データは見つかりませんでした。以下は各カードの基本還元率です。`;
    list.appendChild(notice);
  }

  results.forEach(({ card, rate, note, channel, matched }) => {
    const li = document.createElement('li');
    const isBest = matched !== 'base' && rate === bestRate;
    li.className = 'result-item' + (isBest ? ' best' : '');
    const tags = [];
    if (isBest) tags.push('<span class="best-tag">おすすめ</span>');
    if (channel === 'mall') tags.push('<span class="mall-tag">モール経由限定</span>');
    if (matched === 'base') tags.push('<span class="base-tag">基本還元率</span>');
    li.innerHTML = `
      <div>
        <span class="card-swatch" style="background:${card.color}"></span>
        <span class="item-name">${escapeHtml(card.name)}</span>
        ${tags.length ? `<div class="tag-row">${tags.join('')}</div>` : ''}
        ${note ? `<div class="item-note">${escapeHtml(note)}</div>` : ''}
      </div>
      <div class="rate-badge">${rate.toFixed(1)}%</div>
    `;
    list.appendChild(li);
  });
}

function cardTopStores(card) {
  return Object.entries(card.rates.stores)
    .map(([name, entry]) => ({ name, rate: entry.rate, channel: entry.channel || 'store' }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, TOP_STORES_LIMIT);
}

function renderCardTopStoresHtml(card) {
  const entries = cardTopStores(card);
  if (entries.length === 0) {
    return '<div class="card-top-stores"><p class="empty-state">店舗別の優待データはまだありません</p></div>';
  }
  const hasMall = entries.some((e) => e.channel === 'mall');
  const rows = entries
    .map(
      ({ name, rate, channel }) => `
        <li class="card-top-store-item">
          <span class="item-name">${escapeHtml(name)}${channel === 'mall' ? '<span class="mall-tag">モール</span>' : ''}</span>
          <span class="rate-badge">${rate.toFixed(1)}%</span>
        </li>`
    )
    .join('');
  return `
    <div class="card-top-stores">
      <p class="card-top-stores-title">還元率が高い店(上位${entries.length}件)</p>
      ${hasMall ? '<p class="card-top-stores-note">※「モール」は先にポイントモール経由でアクセスしないと対象外です</p>' : ''}
      <ul class="card-top-stores-list">${rows}</ul>
    </div>
  `;
}

// 持っている(ON)カードが上に来る表示順を計算する。カード一覧タブを開いた時だけ再計算し、
// トグル操作のたびには並び替えない(指の下でカードが移動してしまうのを防ぐため)。
const CARD_TYPE_LABELS = { credit: 'クレジットカード', barcode: 'バーコード決済' };
const CARD_TYPE_ORDER = ['credit', 'barcode'];

function computeCardOrder() {
  state.cardOrder = [...state.cards]
    .sort((a, b) => {
      if (a.type !== b.type) return CARD_TYPE_ORDER.indexOf(a.type) - CARD_TYPE_ORDER.indexOf(b.type);
      const aOwned = state.ownedCardIds.has(a.id);
      const bOwned = state.ownedCardIds.has(b.id);
      if (aOwned === bOwned) return 0;
      return aOwned ? -1 : 1;
    })
    .map((c) => c.id);
}

function renderCardList() {
  const list = document.getElementById('card-list');
  list.innerHTML = '';

  const cardsById = new Map(state.cards.map((c) => [c.id, c]));
  const orderedCards = state.cardOrder.map((id) => cardsById.get(id)).filter(Boolean);

  let lastType = null;
  orderedCards.forEach((card) => {
    if (card.type !== lastType) {
      lastType = card.type;
      const header = document.createElement('li');
      header.className = 'card-list-section-header';
      header.textContent = CARD_TYPE_LABELS[card.type] || card.type;
      list.appendChild(header);
    }

    const owned = state.ownedCardIds.has(card.id);
    const expanded = state.expandedCardId === card.id;
    const sourceLabel = card.source === 'auto' ? '自動更新' : '手動登録';
    const li = document.createElement('li');
    li.className = 'card-item-wrap';
    li.innerHTML = `
      <div class="card-item${owned ? '' : ' not-owned'}">
        <button type="button" class="card-item-info" data-card-id="${card.id}" aria-expanded="${expanded}">
          <span class="card-swatch" style="background:${card.color}"></span>
          <span class="item-name">${escapeHtml(card.name)}</span>
          <div class="item-note">基本還元率 ${card.baseRate.toFixed(1)}% ・ ${escapeHtml(card.updatedAt || '')}更新(${sourceLabel})</div>
          ${card.baseNote ? `<div class="item-note card-base-note">${escapeHtml(card.baseNote)}</div>` : ''}
        </button>
        <label class="owned-switch">
          <input type="checkbox" data-card-id="${card.id}" ${owned ? 'checked' : ''}>
          <span class="owned-switch-track"><span class="owned-switch-thumb"></span></span>
        </label>
      </div>
      ${expanded ? renderCardTopStoresHtml(card) : ''}
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', (e) => {
      setCardOwned(e.target.dataset.cardId, e.target.checked);
    });
  });

  list.querySelectorAll('.card-item-info').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const cardId = e.currentTarget.dataset.cardId;
      state.expandedCardId = state.expandedCardId === cardId ? null : cardId;
      renderCardList();
    });
  });
}

// 604件を一度に並べても目当ての店が探しにくいため、初期表示はカテゴリ選択にし、
// 選んだカテゴリ内(または検索文字列に一致するもの)だけを一覧表示する。
function getCategoryCounts() {
  const counts = new Map();
  for (const store of state.stores) {
    const category = store.category || '未分類';
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return counts;
}

function renderStoreCategoryNav() {
  const nav = document.getElementById('store-category-nav');
  if (!nav) return;

  if (state.storeCategoryFilter === null) {
    const sorted = [...getCategoryCounts().entries()].sort((a, b) => b[1] - a[1]);
    nav.innerHTML = `
      <p class="hint">カテゴリから選ぶ(または上の欄で店名を検索)</p>
      <div class="category-grid">
        ${sorted
          .map(
            ([category, count]) => `
              <button type="button" class="category-tile" data-category="${escapeHtml(category)}">
                <span class="category-tile-name">${escapeHtml(category)}</span>
                <span class="category-tile-count">${count}件</span>
              </button>`
          )
          .join('')}
      </div>
    `;
    nav.querySelectorAll('.category-tile').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.storeCategoryFilter = btn.dataset.category;
        renderStoreCategoryNav();
        renderStoreList();
      });
    });
  } else {
    nav.innerHTML = `<button type="button" id="store-category-back" class="back-link">← カテゴリ一覧に戻る</button>`;
    document.getElementById('store-category-back').addEventListener('click', () => {
      state.storeCategoryFilter = null;
      renderStoreCategoryNav();
      renderStoreList();
    });
  }
}

function renderStoreList() {
  const list = document.getElementById('store-list');
  list.innerHTML = '';

  if (state.storeCategoryFilter === null) return; // カテゴリ選択待ち(上のnavにカテゴリ一覧が出ている)
  const stores = state.stores.filter((s) => (s.category || '未分類') === state.storeCategoryFilter);

  if (stores.length === 0) {
    list.innerHTML = '<li class="empty-state">該当する店舗がありません</li>';
    return;
  }

  stores.forEach((store) => {
    const li = document.createElement('li');
    li.className = 'store-item';
    li.innerHTML = `
      <div>
        <span class="item-name">${escapeHtml(store.name)}</span>
        <div class="item-note">${escapeHtml(store.category)}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      switchTab('search');
      const input = document.getElementById('search-input');
      input.value = store.name;
      renderResults(store.name);
      addSearchHistory(store.name);
    });
    list.appendChild(li);
  });
}

function populateSuggestions() {
  const datalist = document.getElementById('store-suggestions');
  datalist.innerHTML = state.stores.map((s) => `<option value="${escapeHtml(s.name)}">`).join('');

  const cardDatalist = document.getElementById('card-suggestions');
  if (cardDatalist) {
    cardDatalist.innerHTML = state.cards.map((c) => `<option value="${escapeHtml(c.name)}">`).join('');
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
      if (btn.dataset.tab === 'cards') {
        computeCardOrder();
        renderCardList();
      }
    });
  });
}

function initSearch() {
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => renderResults(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const query = input.value.trim();
      if (query) addSearchHistory(query);
      input.blur();
    }
  });
  // datalist(店舗候補)から選んだ時は change イベントが発火する
  input.addEventListener('change', () => {
    const query = input.value.trim();
    if (query) addSearchHistory(query);
  });
}

function showLoadError() {
  const main = document.querySelector('main');
  main.innerHTML = `
    <div class="empty-state">
      <p>データの読み込みに失敗しました。通信環境を確認してもう一度お試しください。</p>
      <button id="retry-btn" type="button" class="retry-btn">再読み込み</button>
    </div>
  `;
  document.getElementById('retry-btn').addEventListener('click', () => location.reload());
}

async function main() {
  const ok = await loadData();
  if (!ok) {
    showLoadError();
    return;
  }

  buildIndexes();
  document.querySelector('main').classList.remove('is-loading');

  const { owned, seen } = loadOwnership();
  state.ownedCardIds = owned;
  state.seenCardIds = seen;
  saveOwnership();

  state.searchHistory = loadSearchHistory();
  state.coupons = loadCoupons();

  initTabs();
  initSearch();
  initCouponForm();
  populateSuggestions();
  computeCardOrder();
  renderCardList();
  renderResults('');
  renderSearchHistory();
  renderCouponList();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

main();
