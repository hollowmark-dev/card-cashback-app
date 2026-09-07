const state = {
  cards: [],
  stores: [],
  ownedCardIds: new Set(),
  lastQuery: '',
  expandedCardId: null,
  cardOrder: [],
  searchCounts: new Map(), // normalized store名 -> {name, count} (「よく使う店」の算出に使う)
  storeIndex: new Map(), // normalized name -> {name, category}
  categoryToStores: new Map(), // normalized category -> [store, ...]
  coupons: [], // ユーザーが手入力したクーポン {id, storeName, discount, source}
};

const TOP_STORES_LIMIT = 30;
const FAVORITE_STORES_LIMIT = 5; // 「よく使う店」チップに出す件数
const SEARCH_COUNTS_STORAGE_CAP = 50; // 検索回数の記録を際限なく増やさないための上限
const OWNERSHIP_KEY = 'cardOwnership';
const LEGACY_OWNED_CARDS_KEY = 'ownedCardIds';
const SEARCH_HISTORY_KEY = 'searchHistory'; // 中身は「直近の検索語配列」→「検索回数」に形式変更済み(下記loadSearchCountsで移行)
const COUPONS_KEY = 'coupons';
// レジ前でよく使う実店舗のカテゴリを優先表示する順序。ここに無いカテゴリ
// (「ネット通販」等)は店舗数が多い順に後ろへ回す。
const CATEGORY_DISPLAY_PRIORITY = ['コンビニ', '飲食', 'スーパー', '家電量販店', 'ドラッグストア', 'ガソリンスタンド', '娯楽'];

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
  }
}

// data/stores.jsonの大半(645店中475店)はポイントモール経由のスクレイピングで
// 集めたネット通販店で、レジ前の判断には使えない。sourceが'auto'でない
// (=作者が手入力した)51店だけが実店舗として意味を持つデータなので、
// 初期画面のチップやdatalist候補はここから作る。
function getRealStores() {
  return state.stores.filter((store) => store.source !== 'auto');
}

// 作者は自分の持ちカードを把握しているので、新しく追加されたカードもデフォルトはOFF
// (未所持)にする。既に明示的にON/OFFを選んだカードの状態はここでは一切触らない。
function loadOwnership() {
  let owned = new Set();
  try {
    const raw = localStorage.getItem(OWNERSHIP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      owned = new Set(parsed.ownedCardIds || []);
    } else {
      // 旧形式(所持IDの配列のみ)からの移行。
      const legacyRaw = localStorage.getItem(LEGACY_OWNED_CARDS_KEY);
      if (legacyRaw) owned = new Set(JSON.parse(legacyRaw));
    }
  } catch {
    // 壊れた値は無視して初期状態から始める
  }
  return owned;
}

function saveOwnership() {
  localStorage.setItem(OWNERSHIP_KEY, JSON.stringify({ ownedCardIds: [...state.ownedCardIds] }));
}

function setCardOwned(cardId, owned) {
  if (owned) state.ownedCardIds.add(cardId);
  else state.ownedCardIds.delete(cardId);
  saveOwnership();
  renderCardList();
  renderResults(state.lastQuery);
}

// 「よく使う店」は検索回数で決める。以前は直近8件の履歴配列だったが、
// レジ前で毎回同じ数店しか使わない使い方だと「最近たまたま検索した店」より
// 「いつも検索する店」の方が有用なため、回数を積み上げる方式に変更した。
// 旧形式(検索語の配列)が残っていた場合は、各語を1回の検索として取り込む。
function loadSearchCounts() {
  const counts = new Map();
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 旧形式(直近の検索語を並べた配列)からの移行
        parsed.forEach((q) => {
          const key = normalizeText(q);
          if (key && !counts.has(key)) counts.set(key, { name: q, count: 1 });
        });
      } else if (parsed && typeof parsed === 'object') {
        Object.entries(parsed).forEach(([key, entry]) => {
          if (entry && typeof entry.name === 'string' && typeof entry.count === 'number') {
            counts.set(key, { name: entry.name, count: entry.count });
          }
        });
      }
    }
  } catch {
    // 壊れた値は無視して初期状態から始める
  }
  return counts;
}

function saveSearchCounts() {
  // 際限なく増え続けないよう、回数の多い上位だけ保持する
  const top = [...state.searchCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, SEARCH_COUNTS_STORAGE_CAP);
  state.searchCounts = new Map(top);
  const obj = {};
  state.searchCounts.forEach((entry, key) => { obj[key] = entry; });
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(obj));
}

function addSearchHistory(query) {
  const key = normalizeText(query);
  if (!key) return;
  const existing = state.searchCounts.get(key);
  if (existing) existing.count += 1;
  else state.searchCounts.set(key, { name: query, count: 1 });
  saveSearchCounts();
}

// 検索回数が多い順に上位N件を「よく使う店」として返す。
function getFavoriteStoreNames() {
  return [...state.searchCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, FAVORITE_STORES_LIMIT)
    .map((entry) => entry.name);
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

function makeCouponId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function addCoupon(storeName, discount, cardName, source) {
  state.coupons.push({
    id: makeCouponId(),
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

// 完全一致するクーポンがあればそれを優先し、無ければ部分一致で探す。
// テキスト貼り付けで登録するため店名は正確な表記が入る前提で、あいまい一致
// (編集距離による救済)は不要になった。
function findCouponForStore(normalizedStoreName) {
  if (!normalizedStoreName) return null;

  const exact = state.coupons.find((c) => normalizeText(c.storeName) === normalizedStoreName);
  if (exact) return exact;

  return (
    state.coupons.find((c) => {
      const n = normalizeText(c.storeName);
      return n !== '' && (n.includes(normalizedStoreName) || normalizedStoreName.includes(n));
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
}

// ベネフィット・ワン等のクーポン一覧はログイン必須でアプリから自動取得できないため、
// PCブラウザ等でコピーしたテキストを貼り付けて一括登録する方式にしている
// (以前はスクショのOCR読み取りを試みたが、店名の漢字がスマホスクショの圧縮画質で
// 崩れて誤読が直らず、結局毎回手直しが必要だったため廃止した)。
// 区切り文字は貼り付け元によって表記が揺れる(| , タブ 全角スペース)ため、
// その行に含まれている区切り文字を優先順位付きで判定して使う。
const COUPON_IMPORT_DELIMITERS = ['|', '\t', '　', ','];

function splitCouponImportLine(line) {
  const delimiter = COUPON_IMPORT_DELIMITERS.find((d) => line.includes(d));
  if (!delimiter) return [line];
  return line.split(delimiter);
}

// 1行1件、「店名 | 内容 | 入手元 | カード名」の書式を想定してパースする。
// 店名・内容の2列に満たない行(区切りが無い/1列しか無い行)は判定できないためスキップし、
// 何件取り込めて何件スキップしたかを呼び出し元で表示できるようにしておく。
function parseCouponImportText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  let skipped = 0;

  lines.forEach((line) => {
    const cols = splitCouponImportLine(line).map((c) => c.trim());
    const storeName = cols[0] || '';
    const discount = cols[1] || '';
    if (!storeName || !discount) {
      skipped += 1;
      return;
    }
    items.push({
      storeName,
      discount,
      source: cols[2] || null,
      cardName: cols[3] || null,
    });
  });

  return { items, skipped };
}

function importCoupons(items, mode) {
  if (mode === 'replace') state.coupons = [];
  items.forEach((item) => {
    state.coupons.push({
      id: makeCouponId(),
      storeName: item.storeName,
      discount: item.discount,
      cardName: item.cardName || null,
      source: item.source || null,
    });
  });
  saveCoupons();
  renderCouponList();
}

function initCouponImport() {
  const textarea = document.getElementById('coupon-import-textarea');
  const btn = document.getElementById('coupon-import-btn');
  const status = document.getElementById('coupon-import-status');
  if (!textarea || !btn) return;

  btn.addEventListener('click', () => {
    const { items, skipped } = parseCouponImportText(textarea.value);
    if (items.length === 0) {
      status.textContent = skipped > 0
        ? `取り込める行がありませんでした(${skipped}行スキップ)。書式を確認してください。`
        : 'テキストを貼り付けてください。';
      return;
    }

    const modeInput = document.querySelector('input[name="coupon-import-mode"]:checked');
    const mode = modeInput ? modeInput.value : 'append';
    importCoupons(items, mode);

    status.textContent = `${items.length}件取り込みました${skipped > 0 ? `(${skipped}行スキップ)` : ''}。`;
    textarea.value = '';
  });
}

// レジ前で意味があるのは「実際にその店で使える還元率」だけなので、モール経由限定
// (channel: 'mall')の優待は「おすすめ」の根拠にしない。モール一致しかない場合は
// 基本還元率(matched: 'base')として扱いつつ、モール側の数字も別途返しておき、
// 「ネットで買うなら」セクションで参考表示できるようにする(情報自体は捨てない)。
// なお、店舗ごとのカテゴリからの還元率推定(旧categoryIndex)は、根拠がモール店舗の
// 数字であることが多く店頭の判断材料にならないため廃止した。
function rateForCard(card, normalizedQuery) {
  const storeMatch = card.storeIndex.get(normalizedQuery);
  if (storeMatch) {
    if (storeMatch.channel === 'mall') {
      return {
        rate: card.baseRate,
        note: card.baseNote || null,
        matched: 'base',
        mallRate: storeMatch.rate,
        mallNote: card.notes[storeMatch.name] || null,
      };
    }
    return { rate: storeMatch.rate, note: card.notes[storeMatch.name] || null, matched: 'store' };
  }
  return { rate: card.baseRate, note: card.baseNote || null, matched: 'base' };
}

function renderCategoryStores(normalizedCategory) {
  const container = document.getElementById('category-stores');
  if (!container) return;
  const stores = state.categoryToStores.get(normalizedCategory);
  if (!stores || stores.length === 0) {
    container.innerHTML = '';
    return;
  }
  // 実店舗(手入力データ)を優先して先頭に出し、その後にモール等の自動収集分を続ける。
  const sorted = [...stores].sort((a, b) => {
    const aReal = a.source !== 'auto';
    const bReal = b.source !== 'auto';
    if (aReal === bReal) return 0;
    return aReal ? -1 : 1;
  });
  const chips = sorted
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

// 検索欄が空の時のトップ画面。ネット通販中心のデータに埋もれてしまわないよう、
// 実店舗(51件)だけをカテゴリ見出し付きのチップで並べる。「よく使う店」(検索回数上位)と、
// 登録済みクーポンの店(stores.jsonに無い店も含む)は特に見つけやすいよう優先的に出す。
function renderStoreChips() {
  const container = document.getElementById('store-chips');
  if (!container) return;

  const couponStoreNames = [...new Set(state.coupons.map((c) => c.storeName))];
  const couponKeySet = new Set(couponStoreNames.map((n) => normalizeText(n)));
  const shownKeys = new Set();

  const groups = [];

  const favoriteNames = getFavoriteStoreNames();
  if (favoriteNames.length > 0) {
    groups.push({
      label: 'よく使う店',
      items: favoriteNames.map((name) => ({ name, hasCoupon: couponKeySet.has(normalizeText(name)) })),
    });
    favoriteNames.forEach((name) => shownKeys.add(normalizeText(name)));
  }

  const byCategory = new Map();
  getRealStores().forEach((store) => {
    const category = store.category || '未分類';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(store);
  });
  const categoryNames = [...byCategory.keys()].sort((a, b) => {
    const ai = CATEGORY_DISPLAY_PRIORITY.indexOf(a);
    const bi = CATEGORY_DISPLAY_PRIORITY.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return byCategory.get(b).length - byCategory.get(a).length;
  });
  categoryNames.forEach((category) => {
    const items = byCategory.get(category).map((s) => ({ name: s.name, hasCoupon: couponKeySet.has(normalizeText(s.name)) }));
    items.forEach((it) => shownKeys.add(normalizeText(it.name)));
    groups.push({ label: category, items });
  });

  // ベネフィット・ワン等のクーポン登録店はstores.jsonに存在しないことが多く、
  // 上のセクションに出てこないまま忘れられがちなので、拾い漏れを最後に補う。
  const orphanCoupons = couponStoreNames.filter((name) => !shownKeys.has(normalizeText(name)));
  if (orphanCoupons.length > 0) {
    groups.push({ label: 'クーポン登録店', items: orphanCoupons.map((name) => ({ name, hasCoupon: true })) });
  }

  if (groups.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = groups
    .map(
      (g) => `
        <div class="chip-group">
          <p class="chip-group-label">${escapeHtml(g.label)}</p>
          <div class="chip-row">
            ${g.items
              .map(
                (it) => `<button type="button" class="chip${it.hasCoupon ? ' chip-coupon' : ''}" data-query="${escapeHtml(it.name)}">${it.hasCoupon ? '🎫 ' : ''}${escapeHtml(it.name)}</button>`
              )
              .join('')}
          </div>
        </div>`
    )
    .join('');

  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const query = chip.dataset.query;
      const input = document.getElementById('search-input');
      input.value = query;
      renderResults(query);
      addSearchHistory(query);
    });
  });
}

// 1件の結果行(「他のカード」「基本還元率のみ」「ネットで買うなら」の一覧で使う簡易表示)
function renderResultRowHtml({ card, rate, note }) {
  return `
    <li class="result-item">
      <div>
        <span class="card-swatch" style="background:${card.color}"></span>
        <span class="item-name">${escapeHtml(card.name)}</span>
        ${note ? `<div class="item-note">${escapeHtml(note)}</div>` : ''}
      </div>
      <div class="rate-badge">${rate.toFixed(1)}%</div>
    </li>
  `;
}

// レジ前で欲しいのは「結局どれを出せばいいか」という1つの答えなので、
// 還元率が最も高いカード(同率なら上位2枚まで)を大きく1枚として表示する。
// 条件note・登録済みクーポンも「答えの一部」としてこの中に同居させる
// (以前は別々のバナーに分かれていて視線が2回動いてしまっていた)。
function renderAnswerCardHtml({ card, rate, note, matched }, coupon) {
  const noteHtml = note ? `<div class="answer-card-note">${escapeHtml(note)}</div>` : '';
  const baseTagHtml = matched === 'base' ? '<div class="tag-row"><span class="base-tag">基本還元率</span></div>' : '';
  let couponHtml = '';
  if (coupon) {
    const meta = [coupon.source, coupon.cardName].filter(Boolean).join('・');
    couponHtml = `<div class="answer-card-coupon">🎫 ${escapeHtml(coupon.discount)}${meta ? `(${escapeHtml(meta)})` : ''}</div>`;
  }
  return `
    <div class="answer-card">
      <div class="answer-card-main">
        <span class="card-swatch" style="background:${card.color}"></span>
        <span class="answer-card-name">${escapeHtml(card.name)}</span>
        <span class="answer-card-rate">${rate.toFixed(1)}%</span>
      </div>
      ${baseTagHtml}
      ${noteHtml}
      ${couponHtml}
    </div>
  `;
}

function renderAnswerBlock(query, shown, coupon) {
  const wrap = document.createElement('div');
  wrap.className = 'answer-block';
  wrap.innerHTML = `
    <p class="answer-store-name">${escapeHtml(query)}</p>
    <div class="answer-cards">${shown.map((r) => renderAnswerCardHtml(r, coupon)).join('')}</div>
  `;
  return wrap;
}

// 答えとして表示しなかった残りのカード。matched === 'base'(基本還元率止まり)の
// カードはさらに一段畳み、「答え」に次いで見る価値が低い情報ほど深く隠す。
function renderOtherCardsDetails(rest) {
  const normalResults = rest.filter((r) => r.matched !== 'base');
  const baseResults = rest.filter((r) => r.matched === 'base');
  const details = document.createElement('details');
  details.className = 'other-cards';
  const baseHtml = baseResults.length > 0
    ? `
      <details class="base-cards">
        <summary>基本還元率のみ (${baseResults.length}枚)</summary>
        <ul class="result-list">${baseResults.map((r) => renderResultRowHtml(r)).join('')}</ul>
      </details>`
    : '';
  details.innerHTML = `
    <summary>他のカード (${rest.length}枚) ▸</summary>
    <ul class="result-list">${normalResults.map((r) => renderResultRowHtml(r)).join('')}</ul>
    ${baseHtml}
  `;
  return details;
}

// モール経由限定の還元率は、既定では隠して「ネットで買うなら」を開いた時だけ見せる。
function renderMallDetails(mallResults) {
  const details = document.createElement('details');
  details.className = 'mall-details';
  const rows = mallResults
    .map(
      ({ card, mallRate, mallNote }) => `
        <li class="result-item">
          <div>
            <span class="card-swatch" style="background:${card.color}"></span>
            <span class="item-name">${escapeHtml(card.name)}</span>
            <div class="tag-row"><span class="mall-tag">モール経由限定</span></div>
            ${mallNote ? `<div class="item-note">${escapeHtml(mallNote)}</div>` : ''}
          </div>
          <div class="rate-badge">${mallRate.toFixed(1)}%</div>
        </li>`
    )
    .join('');
  details.innerHTML = `
    <summary>ネットで買うなら ▸</summary>
    <p class="hint mall-details-hint">先にポイントモール経由でアクセスした場合のみの還元率です</p>
    <ul class="result-list">${rows}</ul>
  `;
  return details;
}

function renderResults(query) {
  state.lastQuery = query;
  const list = document.getElementById('result-list');
  list.innerHTML = '';

  const ownedCards = state.cards.filter((card) => state.ownedCardIds.has(card.id));

  if (!query) {
    // 何も入力していない時は、レジ前でよく使う実店舗をチップで出す
    // (検索とカテゴリ閲覧は結局同じ「店を探す」機能なので、タブを分けずに1つにまとめてある)。
    renderCategoryStores('');
    renderStoreChips();
    if (ownedCards.length === 0) {
      list.innerHTML = '<p class="empty-state">「カード一覧」で持っているカードを選んでください</p>';
    }
    return;
  }

  document.getElementById('store-chips').innerHTML = '';

  if (ownedCards.length === 0) {
    list.innerHTML = '<p class="empty-state">「カード一覧」で持っているカードを選んでください</p>';
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

  const results = ownedCards.map((card) => ({ card, ...rateForCard(card, normalizedQuery) }));
  const storeMatches = results.filter((r) => r.matched === 'store');
  const hasRealMatch = storeMatches.length > 0;
  // 実店舗の還元率が1件でもあればそれだけを「答え」の候補にする(モール限定や
  // 基本還元率が数字上たまたま高くても、店頭で使えない以上は答えにしない)。
  // 1件も無ければ、基本還元率が最も高いカードを答えとして示す。
  const candidatePool = hasRealMatch ? storeMatches : results;
  const bestRate = Math.max(...candidatePool.map((r) => r.rate));
  const bestResults = candidatePool.filter((r) => r.rate === bestRate);

  results.sort((a, b) => b.rate - a.rate);

  // 同率首位が3枚以上なら上位2枚だけを大きく見せ、残りは「他のカード」へ回す。
  const shown = bestResults.slice(0, 2);
  const shownIds = new Set(shown.map((r) => r.card.id));
  const rest = results.filter((r) => !shownIds.has(r.card.id));

  list.appendChild(renderAnswerBlock(query, shown, coupon));

  if (rest.length > 0) {
    list.appendChild(renderOtherCardsDetails(rest));
  }

  const mallResults = results.filter((r) => r.mallRate != null).sort((a, b) => b.mallRate - a.mallRate);
  if (mallResults.length > 0) {
    list.appendChild(renderMallDetails(mallResults));
  }
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
    const li = document.createElement('li');
    li.className = 'card-item-wrap';
    li.innerHTML = `
      <div class="card-item${owned ? '' : ' not-owned'}">
        <button type="button" class="card-item-info" data-card-id="${card.id}" aria-expanded="${expanded}">
          <span class="card-swatch" style="background:${card.color}"></span>
          <span class="item-name">${escapeHtml(card.name)}</span>
          <div class="item-note">基本還元率 ${card.baseRate.toFixed(1)}%</div>
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

// datalistの候補は実店舗(51件)だけに絞る。ネット通販店を含む645件全部を出すと、
// 店頭で店名を打っている時にモール店名の候補ばかり出てきて邪魔になるため。
function populateSuggestions() {
  const datalist = document.getElementById('store-suggestions');
  datalist.innerHTML = getRealStores().map((s) => `<option value="${escapeHtml(s.name)}">`).join('');

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
    // blur()すると値が変わっていればchangeイベントが発火し、下のハンドラで
    // 検索回数がカウントされる。ここで直接addSearchHistoryも呼ぶと
    // 1回のEnterで2重にカウントされてしまうため呼ばない。
    if (e.key === 'Enter') input.blur();
  });
  // datalist(店舗候補)から選んだ時、またはEnterで確定(blur)した時に発火する
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

  state.ownedCardIds = loadOwnership();
  saveOwnership();

  state.searchCounts = loadSearchCounts();
  saveSearchCounts();
  state.coupons = loadCoupons();

  initTabs();
  initSearch();
  initCouponForm();
  initCouponImport();
  populateSuggestions();
  computeCardOrder();
  renderCardList();
  renderResults('');
  renderCouponList();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

main();
