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
};

const TOP_STORES_LIMIT = 30;
const SEARCH_HISTORY_LIMIT = 8;
const OWNERSHIP_KEY = 'cardOwnership';
const LEGACY_OWNED_CARDS_KEY = 'ownedCardIds';
const SEARCH_HISTORY_KEY = 'searchHistory';

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
  for (const card of state.cards) {
    card.storeIndex = new Map();
    for (const [name, entry] of Object.entries(card.rates.stores)) {
      card.storeIndex.set(normalizeText(name), { name, rate: entry.rate, channel: entry.channel || 'store' });
    }
    card.categoryIndex = new Map();
    for (const [name, rate] of Object.entries(card.rates.categories)) {
      card.categoryIndex.set(normalizeText(name), rate);
    }
  }
  state.storeIndex = new Map();
  for (const store of state.stores) {
    state.storeIndex.set(normalizeText(store.name), store);
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

function rateForCard(card, normalizedQuery, normalizedCategory) {
  const storeMatch = card.storeIndex.get(normalizedQuery);
  if (storeMatch) {
    return { rate: storeMatch.rate, channel: storeMatch.channel, note: card.notes[storeMatch.name] || null, matched: 'store' };
  }
  if (normalizedCategory && card.categoryIndex.has(normalizedCategory)) {
    return { rate: card.categoryIndex.get(normalizedCategory), channel: 'store', note: null, matched: 'category' };
  }
  return { rate: card.baseRate, channel: 'store', note: null, matched: 'base' };
}

function renderResults(query) {
  state.lastQuery = query;
  const list = document.getElementById('result-list');
  list.innerHTML = '';

  const ownedCards = state.cards.filter((card) => state.ownedCardIds.has(card.id));

  if (ownedCards.length === 0) {
    list.innerHTML = '<li class="empty-state">「カード一覧」で持っているカードを選んでください</li>';
    return;
  }

  if (!query) {
    list.innerHTML = '<li class="empty-state">店名やカテゴリを入力してください</li>';
    return;
  }

  const normalizedQuery = normalizeText(query);
  const storeEntry = state.storeIndex.get(normalizedQuery);
  const normalizedCategory = normalizeText(storeEntry ? storeEntry.category : query);

  const results = ownedCards.map((card) => ({ card, ...rateForCard(card, normalizedQuery, normalizedCategory) }));
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
        ${tags.join('')}
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
function computeCardOrder() {
  state.cardOrder = [...state.cards]
    .sort((a, b) => {
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

  orderedCards.forEach((card) => {
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

function renderStoreList(filterQuery = '') {
  const list = document.getElementById('store-list');
  list.innerHTML = '';

  const normalizedFilter = normalizeText(filterQuery);
  const stores = normalizedFilter
    ? state.stores.filter((s) => normalizeText(s.name).includes(normalizedFilter))
    : state.stores;

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
  input.addEventListener('input', () => renderStoreList(input.value.trim()));
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

  const { owned, seen } = loadOwnership();
  state.ownedCardIds = owned;
  state.seenCardIds = seen;
  saveOwnership();

  state.searchHistory = loadSearchHistory();

  initTabs();
  initSearch();
  initStoreFilter();
  populateSuggestions();
  computeCardOrder();
  renderCardList();
  renderStoreList();
  renderResults('');
  renderSearchHistory();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

main();
