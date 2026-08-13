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

function addCoupon(storeName, discount, source) {
  state.coupons.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    storeName,
    discount,
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

function findCouponForStore(normalizedStoreName) {
  return state.coupons.find((c) => normalizeText(c.storeName) === normalizedStoreName) || null;
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
    li.innerHTML = `
      <div>
        <span class="item-name">${escapeHtml(coupon.storeName)}</span>
        <div class="item-note">${escapeHtml(coupon.discount)}${coupon.source ? ` ・ ${escapeHtml(coupon.source)}` : ''}</div>
      </div>
      <button type="button" class="coupon-delete-btn" data-id="${coupon.id}" aria-label="削除">×</button>
    `;
    li.querySelector('.coupon-delete-btn').addEventListener('click', () => deleteCoupon(coupon.id));
    list.appendChild(li);
  });
}

function initCouponForm() {
  const form = document.getElementById('coupon-add-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const storeInput = document.getElementById('coupon-store-input');
    const discountInput = document.getElementById('coupon-discount-input');
    const sourceInput = document.getElementById('coupon-source-input');

    const storeName = storeInput.value.trim();
    const discount = discountInput.value.trim();
    const source = sourceInput.value.trim();
    if (!storeName || !discount) return;

    addCoupon(storeName, discount, source);
    form.reset();
    storeInput.focus();
  });
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
      return { rate: card.baseRate, channel: 'store', note: null, matched: 'base' };
    }
    const note = sourceStore ? `${sourceStore}などの一部店舗が対象(店舗ごとに異なる場合があります)` : null;
    return { rate, channel: 'store', note, matched: 'category' };
  }
  return { rate: card.baseRate, channel: 'store', note: null, matched: 'base' };
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

  if (ownedCards.length === 0) {
    list.innerHTML = '<li class="empty-state">「カード一覧」で持っているカードを選んでください</li>';
    renderCategoryStores('');
    return;
  }

  if (!query) {
    list.innerHTML = '<li class="empty-state">店名やカテゴリを入力してください</li>';
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
    const couponLi = document.createElement('li');
    couponLi.className = 'coupon-banner';
    couponLi.innerHTML = `
      <span class="coupon-banner-icon" aria-hidden="true">🎫</span>
      <div>
        <div class="coupon-banner-title">${escapeHtml(coupon.discount)}</div>
        <div class="coupon-banner-note">${escapeHtml(coupon.storeName)}のクーポン${coupon.source ? `(${escapeHtml(coupon.source)})` : ''} ・ カード還元と併用できる場合があります</div>
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
  const filterQuery = document.getElementById('store-filter-input').value.trim();

  // 文字検索中はカテゴリ選択より全件横断検索を優先する
  if (filterQuery) {
    nav.innerHTML = '';
    return;
  }

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

function renderStoreList(filterQuery = '') {
  const list = document.getElementById('store-list');
  list.innerHTML = '';

  const normalizedFilter = normalizeText(filterQuery);
  let stores;
  if (normalizedFilter) {
    stores = state.stores.filter((s) => normalizeText(s.name).includes(normalizedFilter));
  } else if (state.storeCategoryFilter === null) {
    stores = []; // カテゴリ選択待ち(上のnavにカテゴリ一覧が出ている)
  } else {
    stores = state.stores.filter((s) => (s.category || '未分類') === state.storeCategoryFilter);
  }

  if (stores.length === 0) {
    if (!normalizedFilter && state.storeCategoryFilter === null) return;
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

function initStoreFilter() {
  const input = document.getElementById('store-filter-input');
  if (!input) return;
  input.addEventListener('input', () => {
    renderStoreCategoryNav();
    renderStoreList(input.value.trim());
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
  initStoreFilter();
  initCouponForm();
  populateSuggestions();
  computeCardOrder();
  renderCardList();
  renderStoreCategoryNav();
  renderStoreList();
  renderResults('');
  renderSearchHistory();
  renderCouponList();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

main();
