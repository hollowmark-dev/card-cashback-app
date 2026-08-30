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

// ライフカード: L-Mall (https://lmall.jp/shop_list/pointup/?page=1..)
// 旧世代のモールASP(エポス/JCB/オリコ/dカードとはHTML構造が異なる)。
// 倍率(.up + .up_text)がそのまま基本還元率0.5%への倍数。
// .pointTxt.pointFlat は「購入額に関わらずXポイント」という定額還元なので%に換算できず対象外。
const LIFE_CARD_BASE_RATE = 0.5;
const LIFE_CARD_MAX_PAGES = 10;

async function scrapeLifeCardMall() {
  const stores = {};
  for (let page = 1; page <= LIFE_CARD_MAX_PAGES; page++) {
    const url = `https://lmall.jp/shop_list/pointup/?page=${page}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const columns = $('.shopList .column');
    if (columns.length === 0) break;

    columns.each((_, el) => {
      const pointTxt = $(el).find('.pointTxt').first();
      if (pointTxt.hasClass('pointFlat')) return;

      const altName = $(el).find('.banner img').first().attr('alt')?.trim();
      const name = altName || $(el).find('.title a').first().text().trim();
      const rateText = pointTxt.find('.up').first().text().trim();
      const unitText = pointTxt.find('.up_text').first().text().trim();
      if (!name || !rateText || unitText !== '倍') return;

      const multiplier = Number(rateText);
      if (!Number.isFinite(multiplier)) return;

      stores[name] = { rate: Math.round(LIFE_CARD_BASE_RATE * multiplier * 100) / 100, channel: 'mall' };
    });

    await sleep(SLEEP_MS);
  }
  return stores;
}

// TS CUBICカード(トヨタファイナンス): TS3ポイントモール (https://www.ts3pum.com/shop_list/indexed/{letter}/)
// エポスと同系統のモールASPで、倍率(.up + 隣接テキスト"倍")が基本還元率0.5%への倍数。
const TS3_BASE_RATE = 0.5;

async function scrapeTs3Mall() {
  const stores = {};
  for (const letter of INDEX_LETTERS) {
    const url = `https://www.ts3pum.com/shop_list/indexed/${letter}/`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    $('a.box_opacity').each((_, el) => {
      const altName = $(el).find('.img img').first().attr('alt')?.trim();
      const name = altName || $(el).find('.shop_name').first().text().trim();
      const rateText = $(el).find('.point .up').first().text().trim();
      const unitText = $(el).find('.point .text').first().text().trim();
      if (!name || !rateText || unitText !== '倍') return;

      const multiplier = Number(rateText);
      if (!Number.isFinite(multiplier)) return;

      stores[name] = { rate: Math.round(TS3_BASE_RATE * multiplier * 100) / 100, channel: 'mall' };
    });

    await sleep(SLEEP_MS);
  }
  return stores;
}

// オリコカード: オリコモール (https://www.oricomall.com/shop_list/indexed/)
// エポス/JCBと違い五十音ページに分かれておらず、1ページに全店舗が掲載されている。
// 還元率も倍率ではなく最終的な%がそのまま書かれている。
const ORICO_URL = 'https://www.oricomall.com/shop_list/indexed/';

async function scrapeOrico() {
  const html = await fetchHtml(ORICO_URL);
  const $ = cheerio.load(html);
  const stores = {};

  $('.shopName').each((_, el) => {
    const container = $(el).parent();
    const name = $(el).find('a').first().text().trim();
    const rateText = container.find('.point_area .up').first().text().trim();
    const match = rateText.match(/([\d.]+)\s*%/);
    if (!name || !match) return;

    const rate = Number(match[1]);
    if (!Number.isFinite(rate)) return;

    stores[name] = { rate, channel: 'mall' };
  });

  return stores;
}

// dカード: dカード ポイントモール (https://pointmall.dcard.docomo.ne.jp/shop_list/indexed/{letter}/)
// エポス/JCBと同系統のモールASPだが、倍率ではなく最終的な%がそのまま書かれている(オリコと同じ形式)。
// dカードには手入力の実店舗データ(マクドナルド等)もあるので、mergeCardRatesはpreserveManualで呼ぶ。
async function scrapeDcardMall() {
  const stores = {};
  for (const letter of INDEX_LETTERS) {
    const url = `https://pointmall.dcard.docomo.ne.jp/shop_list/indexed/${letter}/`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    $('.shop-list-item').each((_, el) => {
      const altName = $(el).find('.shop-list-item-banner img').first().attr('alt')?.trim();
      const name = altName || $(el).find('.shop-list-item-name').first().text().trim();
      const rateText = $(el).find('.point-num').first().text().trim();
      const unitText = $(el).find('.point-unit').first().text().trim();
      if (!name || !rateText || (unitText !== '%' && unitText !== '％')) return;

      const rate = Number(rateText);
      if (!Number.isFinite(rate)) return;

      stores[name] = { rate, channel: 'mall' };
    });

    await sleep(SLEEP_MS);
  }
  return stores;
}

// au PAY: au PAY Pontaアップ店 (https://aupay.auone.jp/contents/lp/pontaup/)
// コード払いの基本還元率0.5%(200円ごとに1P)に対して、対象店舗では「通常の2〜3倍」の
// Pontaポイントが付くと案内されているが、店舗ごとの正確な倍率は公開されていない
// (エポス/JCB等のモール型ASPと違い、店名一覧のみで数値までは出ていない)。
// そのため控えめな2倍を採用し、実際の倍率が変動する旨をnoteで案内する。
// 対象店舗はページ内で5カテゴリ(飲食/ドラッグストア/家電・スーパー/暮らし/エンタメ)に
// 分類されているので、店舗一覧側のカテゴリもここから引き継ぐ(guessCategoryの
// キーワード推定より正確なため)。
//
// このアプリの利用者はau PAY残高をau PAYゴールドカードのオートチャージで補充しており、
// ポイントアップリワードの全条件(auじぶん銀行口座・auでんき・家族カード・ETCカード年1回)を
// 満たしているため、チャージ側で最大5%のPontaポイントが別途付与される
// (月間1,000ポイント=充当2万円分が上限、公式: kddi-fs.com/function/point_up/)。
// これは「どの店で払うか」に関係ない定額ボーナスなので、店舗別の2〜3倍は
// 支払い時還元率(0.5%)側にだけ掛けて、チャージ分はどの店でも一律で加算する。
// 個人利用前提のアプリなので、この値は汎用スクレイパーというより利用者本人の
// カード構成に合わせた設定値として直接埋め込んでいる。
const AU_PAY_URL = 'https://aupay.auone.jp/contents/lp/pontaup/';
const AU_PAY_PAYMENT_BASE_RATE = 0.5;
const AU_PAY_BOOST_MULTIPLIER = 2;
const AU_PAY_CHARGE_BONUS = 5.0;
const AU_PAY_CHARGE_NOTE = 'au PAYゴールドカードのオートチャージ(条件達成で最大5%)+利用時0.5%の合算。月間1,000ポイント(充当2万円分)が上限で、それ以降は還元率が下がります';
const AU_PAY_STORE_NOTE = `${AU_PAY_CHARGE_NOTE} / この店はさらにPontaアップ対象(通常の2〜3倍相当。正確な倍率は店舗により異なります)`;

function guessAuPayCategory(sectionLabel, name) {
  if (sectionLabel === '家電・スーパー') return /スーパー/.test(name) ? 'スーパー' : '家電量販店';
  if (sectionLabel === 'エンタメ') return '娯楽';
  return sectionLabel; // 飲食・ドラッグストア・暮らし はそのまま流用
}

async function scrapeAuPayPontaUp() {
  const html = await fetchHtml(AU_PAY_URL);
  const $ = cheerio.load(html);
  const stores = {};
  const notes = {};
  const categoryHints = {};

  $('ul.category li[data-category]').each((_, el) => {
    const sectionLabel = $(el).attr('data-category');
    const name = $(el).find('img').first().attr('alt')?.trim();
    if (!name || !sectionLabel) return;

    const rate = AU_PAY_CHARGE_BONUS + AU_PAY_PAYMENT_BASE_RATE * AU_PAY_BOOST_MULTIPLIER;
    stores[name] = { rate: Math.round(rate * 100) / 100, channel: 'store' };
    notes[name] = AU_PAY_STORE_NOTE;
    categoryHints[name] = guessAuPayCategory(sectionLabel, name);
  });

  return { stores, notes, categoryHints };
}

function mergeCardRates(cards, cardId, storesRates, notes = {}, { preserveManual = false } = {}) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);
  if (preserveManual) {
    // このカードは手入力の実店舗データ(channel: 'store')とモールのスクレイピング結果が
    // 混在する。モール由来(channel: 'mall')の分だけ入れ替え、手入力分は保持する。
    const manualStores = Object.fromEntries(
      Object.entries(card.rates.stores).filter(([, entry]) => entry.channel !== 'mall')
    );
    card.rates.stores = { ...manualStores, ...storesRates };
    card.notes = { ...card.notes, ...notes };
  } else {
    card.rates.stores = storesRates;
    card.notes = notes;
  }
  card.updatedAt = new Date().toISOString().slice(0, 10);
  card.source = 'auto';
}

// 自動取得した店舗はほとんどが「未分類」のままだと店舗一覧のカテゴリ検索が効かないため、
// 店名のキーワードから大まかなカテゴリを推定する。完全ではないベストエフォートの分類。
// 自動取得店舗(エポス/JCB/オリコ/dカード/ライフカード/TS3)は、そもそも全て
// 「ポイントモールに掲載されているネットショップ」なので、他の特定カテゴリに
// 当てはまらなければ「ネット通販」をデフォルトにする(=「未分類」をほぼ無くす)。
// 旅行・美容・ゲーム等、明確に判定できるものだけ個別カテゴリに振り分ける。
const CATEGORY_RULES = [
  [/ホテル|トラベル|航空|ツアー|エクスペディア|エアトリ|じゃらん|agoda|expedia|travel|hotel|JTB|スカイチケット|skyticket|skyscanner|レンタカー|近畿日本ツーリスト/i, '旅行'],
  [/アプリペイストア|ミニアプリ/i, 'アプリ'],
  [/コスメ|化粧品|beauty|cosme|オーガニック|ボーテ|ネイル/i, '美容'],
  [/ゲーム|game|SQUARE ENIX/i, 'ゲーム'],
  [/チケット|ぴあ/i, 'チケット'],
];

function guessCategory(name) {
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(name)) return category;
  }
  return 'ネット通販';
}

// stores.json は手動登録の店舗と、自動取得で見つかった店舗が混在する。
// 1ソースの取得が失敗しても他のソースの結果を失わないよう、既存の自動取得店舗を
// 丸ごと入れ替えるのではなく「まだ無いものだけ追加する」方式にしている
// (取り下げられた店舗がstores.jsonに残り続ける可能性はあるが、実害は小さい)。
// カテゴリだけは、ルールを改善した時に既存分にも反映されるよう毎回再計算する。
function mergeDiscoveredStores(stores, newStoreNames, categoryHints = {}) {
  const recategorized = stores.map((s) =>
    s.source === 'auto' ? { ...s, category: categoryHints[s.name] || guessCategory(s.name) } : s
  );
  const existingNames = new Set(recategorized.map((s) => s.name));
  const additions = [...new Set(newStoreNames)]
    .filter((name) => !existingNames.has(name))
    .map((name) => ({ name, category: categoryHints[name] || guessCategory(name), source: 'auto' }));
  return [...recategorized, ...additions];
}

// 取得元ごとの設定。1つのソースが失敗しても他のソースの更新は失われないよう、
// それぞれ独立してtry/catchする。
const SOURCES = [
  { name: 'エポスカード', cardId: 'epos-card', scrape: scrapeEpos },
  { name: 'PayPayカード', cardId: 'paypay-card', scrape: scrapePayPay },
  { name: 'JCBカード', cardId: 'jcb-card', scrape: scrapeJcb },
  { name: 'オリコカード', cardId: 'orico-card', scrape: scrapeOrico },
  { name: 'dカードモール', cardId: 'd-card', scrape: scrapeDcardMall, preserveManual: true },
  { name: 'ライフカード', cardId: 'life-card', scrape: scrapeLifeCardMall },
  { name: 'TS CUBICカード', cardId: 'ts3-card', scrape: scrapeTs3Mall },
  { name: 'au PAY', cardId: 'au-pay', scrape: scrapeAuPayPontaUp },
];

// JCB CARD Wは通常のJCBカードと同じJ-POINTモールを使うが、基本還元率が0.5%ではなく
// 1.0%(2倍)なので、モールの還元率もすべて2倍になる。jcb-cardの取得結果からそのまま
// 導出できるので、別途スクレイピングはしない。
function deriveJcbCardW(cards, jcbStoresRates) {
  const stores = {};
  for (const [name, entry] of Object.entries(jcbStoresRates)) {
    stores[name] = { rate: Math.round(entry.rate * 2 * 100) / 100, channel: entry.channel };
  }
  mergeCardRates(cards, 'jcb-card-w', stores, {});
}

async function main() {
  const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
  const stores = JSON.parse(fs.readFileSync(STORES_PATH, 'utf8'));

  const allNewStoreNames = [];
  const allCategoryHints = {};
  const failures = [];
  let jcbStoresRates = null;

  for (const source of SOURCES) {
    console.log(`${source.name}のデータを取得中...`);
    try {
      const result = await source.scrape();
      const storesRates = result.stores || result;
      const notes = result.notes || {};
      console.log(`  -> ${Object.keys(storesRates).length}件取得`);
      mergeCardRates(cards, source.cardId, storesRates, notes, { preserveManual: source.preserveManual });
      allNewStoreNames.push(...Object.keys(storesRates));
      Object.assign(allCategoryHints, result.categoryHints || {});
      if (source.cardId === 'jcb-card') jcbStoresRates = storesRates;
    } catch (err) {
      console.error(`  ! ${source.name}の取得に失敗しました: ${err.message}`);
      failures.push(source.name);
    }
  }

  if (jcbStoresRates) {
    deriveJcbCardW(cards, jcbStoresRates);
    console.log('JCB CARD W: jcb-cardの結果から2倍換算で更新しました。');
  }

  const updatedStores = mergeDiscoveredStores(stores, allNewStoreNames, allCategoryHints);

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
