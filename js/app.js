const state = {
  cards: [],
  stores: [],
  ownedCardIds: new Set(),
  lastQuery: '',
  expandedCardId: null,
};

const TOP_STORES_LIMIT = 30;

const OWNED_CARDS_KEY = 'ownedCardIds';

async function loadData() {
  const [cardsRes, storesRes] = await Promise.all([
    fetch('data/cards.json'),
    fetch('data/stores.json'),
  ]);
  state.cards = await cardsRes.json();
  state.stores = await storesRes.json();
}

function loadOwnedCardIds() {
  try {
    const raw = localStorage.getItem(OWNED_CARDS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore malformed localStorage value
  }
  // 初回は全カードを所持している状態で開始する
  return new Set(state.cards.map((c) => c.id));
}

function saveOwnedCardIds() {
  localStorage.setItem(OWNED_CARDS_KEY, JSON.stringify([...state.ownedCardIds]));
}

function setCardOwned(cardId, owned) {
  if (owned) state.ownedCardIds.add(cardId);
  else state.ownedCardIds.delete(cardId);
  saveOwnedCardIds();
  renderCardList();
  renderResults(state.lastQuery);
}

function findStoreCategory(storeName) {
  const store = state.stores.find((s) => s.name === storeName);
  return store ? store.category : null;
}

function rateForCard(card, query, category) {
  if (card.rates.stores[query] !== undefined) {
    return { rate: card.rates.stores[query], note: card.notes[query] || null };
  }
  if (category && card.rates.categories[category] !== undefined) {
    return { rate: card.rates.categories[category], note: null };
  }
  return { rate: card.baseRate, note: null };
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

  const category = findStoreCategory(query) || query;

  const results = ownedCards
    .map((card) => ({ card, ...rateForCard(card, query, category) }))
    .sort((a, b) => b.rate - a.rate);

  const bestRate = results[0]?.rate;

  results.forEach(({ card, rate, note }) => {
    const li = document.createElement('li');
    li.className = 'result-item' + (rate === bestRate ? ' best' : '');
    li.innerHTML = `
      <div>
        <span class="card-swatch" style="background:${card.color}"></span>
        <span class="item-name">${card.name}</span>
        ${rate === bestRate ? '<span class="best-tag">おすすめ</span>' : ''}
        ${note ? `<div class="item-note">${note}</div>` : ''}
      </div>
      <div class="rate-badge">${rate.toFixed(1)}%</div>
    `;
    list.appendChild(li);
  });
}

function cardTopStores(card) {
  return Object.entries(card.rates.stores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_STORES_LIMIT);
}

function renderCardTopStoresHtml(card) {
  const entries = cardTopStores(card);
  if (entries.length === 0) {
    return '<div class="card-top-stores"><p class="empty-state">店舗別の優待データはまだありません</p></div>';
  }
  const rows = entries
    .map(
      ([name, rate]) => `
        <li class="card-top-store-item">
          <span class="item-name">${name}</span>
          <span class="rate-badge">${rate.toFixed(1)}%</span>
        </li>`
    )
    .join('');
  return `
    <div class="card-top-stores">
      <p class="card-top-stores-title">還元率が高い店(上位${entries.length}件)</p>
      <ul class="card-top-stores-list">${rows}</ul>
    </div>
  `;
}

function renderCardList() {
  const list = document.getElementById('card-list');
  list.innerHTML = '';

  // 持っている(ON)カードを上に表示する。グループ内の順序は元の並びを維持する。
  const sortedCards = [...state.cards].sort((a, b) => {
    const aOwned = state.ownedCardIds.has(a.id);
    const bOwned = state.ownedCardIds.has(b.id);
    if (aOwned === bOwned) return 0;
    return aOwned ? -1 : 1;
  });

  sortedCards.forEach((card) => {
    const owned = state.ownedCardIds.has(card.id);
    const expanded = state.expandedCardId === card.id;
    const li = document.createElement('li');
    li.className = 'card-item-wrap';
    li.innerHTML = `
      <div class="card-item${owned ? '' : ' not-owned'}">
        <button type="button" class="card-item-info" data-card-id="${card.id}" aria-expanded="${expanded}">
          <span class="card-swatch" style="background:${card.color}"></span>
          <span class="item-name">${card.name}</span>
          <div class="item-note">基本還元率 ${card.baseRate.toFixed(1)}%</div>
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

function renderStoreList() {
  const list = document.getElementById('store-list');
  list.innerHTML = '';
  state.stores.forEach((store) => {
    const li = document.createElement('li');
    li.className = 'store-item';
    li.innerHTML = `
      <div>
        <span class="item-name">${store.name}</span>
        <div class="item-note">${store.category}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      switchTab('search');
      const input = document.getElementById('search-input');
      input.value = store.name;
      renderResults(store.name);
    });
    list.appendChild(li);
  });
}

function populateSuggestions() {
  const datalist = document.getElementById('store-suggestions');
  datalist.innerHTML = state.stores
    .map((s) => `<option value="${s.name}">`)
    .join('');
}

function renderUpdatedAt() {
  const dates = state.cards.map((c) => c.updatedAt).filter(Boolean);
  if (dates.length === 0) return;
  const latest = dates.sort().at(-1);
  document.getElementById('data-updated').textContent = `データ更新日: ${latest}`;
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
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function initSearch() {
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => renderResults(input.value.trim()));
}

async function main() {
  await loadData();
  state.ownedCardIds = loadOwnedCardIds();
  initTabs();
  initSearch();
  populateSuggestions();
  renderCardList();
  renderStoreList();
  renderResults('');
  renderUpdatedAt();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

main();
