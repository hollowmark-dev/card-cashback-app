// 各カード会社の公式ページから店舗別ポイント優待を取得し、
// data/cards.json (epos-card / paypay-card のみ) と data/stores.json を更新する。
// 対象は robots.txt でクロールが許可されている、ログイン不要の公開ページのみ。
//
// 実行: npm run update-data
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CARDS_PATH = path.join(__dirname, '..', 'data', 'cards.json');
const STORES_PATH = path.join(__dirname, '..', 'data', 'stores.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; personal-card-cashback-app/1.0)';
const SLEEP_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

const INDEX_LETTERS = ['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa'];

// エポスカード(たまるマーケット)とJCBカード(J-POINTモール)は同系統のポイントモールASPで
// 運営されており、店舗名+倍率を五十音インデックスページ(shop_list/indexed/{letter}/)で
// 一覧取得できる点が共通している。セレクタだけ差し替えて共通ロジックで処理する。
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

      stores[name] = Math.round(baseRate * multiplier * 100) / 100;
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
// 通常還元率への上乗せ(+X%)が店舗ごとに掲載されている。
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

    stores[name] = Math.round((PAYPAY_BASE_RATE + bonus) * 100) / 100;
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

// stores.json は手動登録の店舗(コンビニ等)と、自動取得で見つかった店舗が混在する。
// 自動取得分(source: "auto")は毎回まるごと入れ替える。手動登録分はそのまま残す。
function mergeDiscoveredStores(stores, newStoreNames) {
  const manual = stores.filter((s) => s.source !== 'auto');
  const manualNames = new Set(manual.map((s) => s.name));
  const auto = [...new Set(newStoreNames)]
    .filter((name) => !manualNames.has(name))
    .map((name) => ({ name, category: '未分類', source: 'auto' }));
  return [...manual, ...auto];
}

async function main() {
  const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
  const stores = JSON.parse(fs.readFileSync(STORES_PATH, 'utf8'));

  console.log('エポスカードのデータを取得中...');
  const eposStores = await scrapeEpos();
  console.log(`  -> ${Object.keys(eposStores).length}件取得`);

  console.log('PayPayカードのデータを取得中...');
  const { stores: paypayStores, notes: paypayNotes } = await scrapePayPay();
  console.log(`  -> ${Object.keys(paypayStores).length}件取得`);

  console.log('JCBカードのデータを取得中...');
  const jcbStores = await scrapeJcb();
  console.log(`  -> ${Object.keys(jcbStores).length}件取得`);

  mergeCardRates(cards, 'epos-card', eposStores);
  mergeCardRates(cards, 'paypay-card', paypayStores, paypayNotes);
  mergeCardRates(cards, 'jcb-card', jcbStores);

  const updatedStores = mergeDiscoveredStores(
    stores,
    [...Object.keys(eposStores), ...Object.keys(paypayStores), ...Object.keys(jcbStores)]
  );

  fs.writeFileSync(CARDS_PATH, JSON.stringify(cards, null, 2) + '\n');
  fs.writeFileSync(STORES_PATH, JSON.stringify(updatedStores, null, 2) + '\n');
  console.log('data/cards.json と data/stores.json を更新しました。');
}

main().catch((err) => {
  console.error('update-data failed:', err);
  process.exitCode = 1;
});
