// data/campaigns.json の検証。クラウドの定期タスク(AI)が書き出すファイルなので、
// pushする前に形の崩れや存在しないカード/店舗名を弾く(アプリは店名とcardIdで突き合わせるため、
// 表記ゆれがあると黙って表示されなくなる)。
//
// 実行: node scripts/validate-campaigns.js
const path = require('path');

const root = path.join(__dirname, '..');
const data = require(path.join(root, 'data', 'campaigns.json'));
const cardIds = new Set(require(path.join(root, 'data', 'cards.json')).map((c) => c.id));
const storeNames = new Set(require(path.join(root, 'data', 'stores.json')).map((s) => s.name));

const errors = [];
const ids = new Set();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

if (!Array.isArray(data.campaigns)) errors.push('campaigns が配列ではありません');

(data.campaigns || []).forEach((c, i) => {
  const label = c.id || `${i + 1}件目`;
  if (!c.id) errors.push(`${label}: id がありません`);
  else if (ids.has(c.id)) errors.push(`${label}: id が重複しています`);
  ids.add(c.id);
  if (!cardIds.has(c.cardId)) errors.push(`${label}: cards.json に無い cardId "${c.cardId}"`);
  if (!c.title) errors.push(`${label}: title がありません`);
  if (!Array.isArray(c.stores)) errors.push(`${label}: stores が配列ではありません`);
  (c.stores || []).forEach((s) => {
    if (!storeNames.has(s)) errors.push(`${label}: stores.json に無い店名 "${s}"`);
  });
  if (!isDate(c.start) || !isDate(c.end)) errors.push(`${label}: start / end が YYYY-MM-DD ではありません`);
  else if (c.start > c.end) errors.push(`${label}: start が end より後です`);
  if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) errors.push(`${label}: url が http(s) ではありません`);
});

if (errors.length > 0) {
  console.error(`NG (${errors.length}件の問題)\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`OK ${data.campaigns.length}件`);
}
