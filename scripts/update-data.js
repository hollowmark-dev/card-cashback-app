// 各カード会社の公式ページから店舗別ポイント優待を取得し、
// data/cards.json (epos-card / paypay-card / jcb-card のみ) と data/stores.json を更新する。
// 対象は robots.txt でクロールが許可されている、ログイン不要の公開ページのみ。
//
// 実行: npm run update-data
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CARDS_PATH = path.join(__dirname, '..', 'data', 'cards.json');
const STORES_PATH = path.join(__dirname, '..', 'data', 'stores.json');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SLEEP_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COMMON_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

const INDEX_LETTERS = ['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa'];

// エポスカード(たまるマーケット)とJCBカード(J-POINTモール)は同系統のポイントモールASPで
// 運営されており、店舗名+倍率を五十音インデックスページ(shop_list/indexed/{letter}/)で
// 一覧取得できる点が共通している。セレクタだけ差し替えて共通ロジックで処理する。
// これらはすべて「先にモールを経由してからその店で買い物する」ことが条件のオンライン優待なので、
// channel: 'mall' を付けて、実店舗でカードを提示するだけの優待(channel: 'store')と区別する。
async function scrapeShopMall({ baseUrl, baseRate, cardSelector, nameSelector, bannerImgSelector, rateSelector, unitSelector }) {
  const stores = {};
  for (const letter of INDEX_LETTERS) {
    const url = `${baseUrl}${letter}/`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    $(cardSelector).each((_, el) => {
      // 店舗名がサーバー側で省略記号(...)付きに切り詰められることがあるため、
      // 切り詰められていない正式名称を持つ banner 画像の alt を優先する。
      const altName = $(el).find(bannerImgSelector).first().attr('alt')?.trim();
      const name = altName || $(el).find(nameSelector).first().text().trim();
      const rateText = $(el).find(rateSelector).first().text().trim();
      const unitText = $(el).find(unitSelector).first().text().trim();
      if (!name || !rateText || unitText !== '倍') return;

      const multiplier = Number(rateText);
      if (!Number.isFinite(multiplier)) return;

      stores[name] = { rate: Math.round(baseRate * multiplier * 100) / 100, channel: 'mall' };
    });

    await sleep(SLEEP_MS);
  }
  return stores;
}

// エポスカード: エポスポイントUPサイト (https://tamaru.eposcard.co.jp/shop_list/indexed/{letter}/)
// 基本還元率0.5%に対する倍率(X倍)が店舗ごとに掲載されている。
const EPOS_BASE_RATE = 0.5;

async function scrapeEpos() {
  return scrapeShopMall({
    baseUrl: 'https://tamaru.eposcard.co.jp/shop_list/indexed/',
    baseRate: EPOS_BASE_RATE,
    cardSelector: '.shopCard',
    nameSelector: '.shopCard-name',
    bannerImgSelector: '.shopCard-banner img',
    rateSelector: '.point-area-vertical .rate',
    unitSelector: '.point-area-vertical .unit',
  });
}

// JCBカード: J-POINTモール (https://j-pointmall.jcb.co.jp/shop_list/indexed/{letter}/)
// 基本還元率0.5%に対する倍率(X倍)が店舗ごとに掲載されている。
const JCB_BASE_RATE = 0.5;

async function scrapeJcb() {
  return scrapeShopMall({
    baseUrl: 'https://j-pointmall.jcb.co.jp/shop_list/indexed/',
    baseRate: JCB_BASE_RATE,
    cardSelector: '.shop-card-common',
    nameSelector: '.shop-card-name',
    bannerImgSelector: '.shop-card-banner img',
    rateSelector: '.num1',
    unitSelector: '.unit',
  });
}

// PayPayカード: PayPayポイントアップ店 (https://paypay.ne.jp/guide/point-up/)
// 通常還元率への上乗せ(+X%)が店舗ごとに掲載されている。モール経由不要(直接支払うだけ)なのでchannel: 'store'。
const PAYPAY_URL = 'https://paypay.ne.jp/guide/point-up/';
const PAYPAY_BASE_RATE = 1.0;

async function scrapePayPay() {
  const html = await fetchHtml(PAYPAY_URL);
  const $ = cheerio.load(html);
  const stores = {};
  const notes = {};

  $('.store__item').each((_, el) => {
    const name = $(el).find('.store__name').first().text().trim();
    const balloonHtml = $(el).find('.store__balloon').first().html() || '';
    const balloonLines = balloonHtml.split(/<br\s*\/?>/i).map((s) => cheerio.load(s).text().trim()).filter(Boolean);
    const bonusLine = balloonLines[balloonLines.length - 1] || '';
    const conditionLine = balloonLines.length > 1 ? balloonLines[0] : null;
    const noteText = $(el).find('.store__notes .notes__text').first().text().trim() || null;

    const match = bonusLine.match(/([\d.]+)\s*[％%]/);
    if (!name || !match) return;

    const bonus = Number(match[1]);
    if (!Number.isFinite(bonus)) return;

    stores[name] = { rate: Math.round((PAYPAY_BASE_RATE + bonus) * 100) / 100, channel: 'store' };
    const note = [conditionLine, noteText].filter(Boolean).join(' / ');
    if (note) notes[name] = note;
  });

  return { stores, notes };
}

function mergeCardRates(cards, cardId, storesRates, notes = {}) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);
  card.rates.stores = storesRates;
  card.notes = notes;
  card.updatedAt = new Date().toISOString().slice(0, 10);
  card.source = 'auto';
}

// 自動取得した店舗はほとんどが「未分類」のままだと店舗一覧のカテゴリ検索が効かないため、
// 店名のキーワードから大まかなカテゴリを推定する。完全ではないベストエフォートの分類。
const CATEGORY_RULES = [
  [/オンライン|ネットショップ|ドットコム|\.com|web ?store|online ?shop|ストア$|ショップ$/i, 'ネット通販'],
  [/ホテル|トラベル|航空|ツアー|エクスペディア|エアトリ|じゃらん|agoda|expedia|travel|hotel/i, '旅行'],
  [/アプリペイストア|ミニアプリ/i, 'アプリ'],
  [/コスメ|化粧品|beauty|cosme|オーガニック/i, '美容'],
  [/ゲーム|game/i, 'ゲーム'],
];

function guessCategory(name) {
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(name)) return category;
  }
  return '未分類';
}

// stores.json は手動登録の店舗と、自動取得で見つかった店舗が混在する。
// 1ソースの取得が失敗しても他のソースの結果を失わないよう、既存の自動取得店舗を
// 丸ごと入れ替えるのではなく「まだ無いものだけ追加する」方式にしている
// (取り下げられた店舗がstores.jsonに残り続ける可能性はあるが、実害は小さい)。
function mergeDiscoveredStores(stores, newStoreNames) {
  const existingNames = new Set(stores.map((s) => s.name));
  const additions = [...new Set(newStoreNames)]
    .filter((name) => !existingNames.has(name))
    .map((name) => ({ name, category: guessCategory(name), source: 'auto' }));
  return [...stores, ...additions];
}

// 取得元ごとの設定。1つのソースが失敗しても他のソースの更新は失われないよう、
// それぞれ独立してtry/catchする。
const SOURCES = [
  { name: 'エポスカード', cardId: 'epos-card', scrape: scrapeEpos },
  { name: 'PayPayカード', cardId: 'paypay-card', scrape: scrapePayPay },
  { name: 'JCBカード', cardId: 'jcb-card', scrape: scrapeJcb },
];

async function main() {
  const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
  const stores = JSON.parse(fs.readFileSync(STORES_PATH, 'utf8'));

  const allNewStoreNames = [];
  const failures = [];

  for (const source of SOURCES) {
    console.log(`${source.name}のデータを取得中...`);
    try {
      const result = await source.scrape();
      const storesRates = result.stores || result;
      const notes = result.notes || {};
      console.log(`  -> ${Object.keys(storesRates).length}件取得`);
      mergeCardRates(cards, source.cardId, storesRates, notes);
      allNewStoreNames.push(...Object.keys(storesRates));
    } catch (err) {
      console.error(`  ! ${source.name}の取得に失敗しました: ${err.message}`);
      failures.push(source.name);
    }
  }

  const updatedStores = mergeDiscoveredStores(stores, allNewStoreNames);

  fs.writeFileSync(CARDS_PATH, JSON.stringify(cards, null, 2) + '\n');
  fs.writeFileSync(STORES_PATH, JSON.stringify(updatedStores, null, 2) + '\n');

  if (failures.length > 0) {
    console.error(`一部のソースで取得に失敗しました(他のソースは正常に更新済み): ${failures.join(', ')}`);
  } else {
    console.log('data/cards.json と data/stores.json をすべて正常に更新しました。');
  }

  // 1つでも取得できたソースがあれば、その分だけでも必ずコミットされてほしいので
  // exitCodeは正常終了にする(GitHub ActionsはStepが失敗すると後続のgit commit/push
  // ステップごとスキップしてしまうため、部分的な失敗でジョブ全体を落とさない)。
  // 全ソースが失敗した場合のみ異常終了として扱い、CI上で赤く分かるようにする。
  if (failures.length === SOURCES.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('update-data failed:', err);
  process.exitCode = 1;
});
