// ベネフィット・ワンのクーポン自動同期(PC側)。
//
// ベネフィット・ワンはログイン必須で、アプリにはバックエンドも無いため、PC上の定期実行タスク
// (Claudeデスクトップアプリのスケジュールタスク)がログイン済みのChromeでマイクーポンを読み、
// このスクリプトで暗号化して data/coupons.enc.json としてリポジトリにpushする。
// リポジトリとGitHub Pagesは公開されているので、置くのは暗号文だけにして、
// 鍵はこのPC(.local/、gitignore済み)とスマホのlocalStorageにだけ持たせる。
//
// 使い方:
//   node scripts/coupon-sync.js init          鍵を作り(既にあれば再利用)、スマホ用のQRコードを表示する
//   node scripts/coupon-sync.js status        同期が必要か判定する(DUE / NOT_DUE を出力)
//   node scripts/coupon-sync.js encrypt FILE  取得したクーポンJSONを暗号化して data/coupons.enc.json に書く
//   node scripts/coupon-sync.js mark-synced   push成功後に呼び、最終同期日時を記録する
const fs = require('fs');
const path = require('path');
const { webcrypto, randomBytes } = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOCAL_DIR = path.join(ROOT, '.local');
const KEY_PATH = path.join(LOCAL_DIR, 'coupon-sync-key');
const STATE_PATH = path.join(LOCAL_DIR, 'coupon-sync-state.json');
const QR_PATH = path.join(LOCAL_DIR, 'coupon-sync-qr.png');
const OUTPUT_PATH = path.join(ROOT, 'data', 'coupons.enc.json');
const APP_URL = 'https://hollowmark-dev.github.io/card-cashback-app/';
const SOURCE_NAME = 'ベネフィット・ワン';

// 週1回の同期が目安。定期タスクは毎日起動し、ここで「まだ不要」なら何もせず終わる。
// PCを数日起動しなかった場合も、次に起動した日に追いつける。
// ちょうど7日にすると実行時刻のずれで1日遅れることがあるので、少し短めにしている。
const SYNC_INTERVAL_DAYS = 6;

function readKey() {
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error('同期キーがありません。先に `node scripts/coupon-sync.js init` を実行してください。');
  }
  return fs.readFileSync(KEY_PATH, 'utf8').trim();
}

async function init() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const rotate = process.argv.includes('--rotate');
  if (!fs.existsSync(KEY_PATH) || rotate) {
    fs.writeFileSync(KEY_PATH, randomBytes(32).toString('base64url'));
    console.log(rotate ? '同期キーを作り直しました。' : '同期キーを作成しました。');
  } else {
    console.log('既存の同期キーを使います(作り直すときは --rotate)。');
  }

  // 鍵はURLの#以降に入れる(#以降はブラウザからサーバーに送信されない)。
  // 鍵をコンソールに出すとログ等に残るので、QRコード画像にだけ書き出して開く。
  const QRCode = require('qrcode');
  await QRCode.toFile(QR_PATH, `${APP_URL}#sync-key=${readKey()}`, { width: 480, margin: 2 });
  console.log(`スマホでこのQRコードを読み取ってアプリを開いてください: ${QR_PATH}`);
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    execFileSync('cmd', ['/c', 'start', '', QR_PATH]);
  }
}

function status() {
  let last = null;
  try {
    last = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).lastSuccessAt;
  } catch {
    // 一度も同期していない
  }
  if (!last) {
    console.log('DUE (never synced)');
    return;
  }
  const days = (Date.now() - new Date(last).getTime()) / 86400000;
  console.log(days >= SYNC_INTERVAL_DAYS ? `DUE (last=${last})` : `NOT_DUE (last=${last})`);
}

// 入力は {"coupons": [{"storeName", "discount", "expiresAt"?}]} または配列そのもの。
// 定期タスク(AI)が書き出すJSONなので、形が崩れていたら暗号化前に止める
// (壊れたデータをスマホに配って、正しいクーポンまで消してしまわないため)。
function validateCoupons(input) {
  const coupons = Array.isArray(input) ? input : input.coupons;
  if (!Array.isArray(coupons)) throw new Error('coupons 配列がありません');
  return coupons.map((c, i) => {
    const storeName = typeof c.storeName === 'string' ? c.storeName.trim() : '';
    const discount = typeof c.discount === 'string' ? c.discount.trim() : '';
    if (!storeName || !discount) throw new Error(`${i + 1}件目に storeName / discount がありません`);
    const expiresAt = c.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(c.expiresAt) ? c.expiresAt : null;
    return { storeName, discount, expiresAt };
  });
}

async function encrypt(file) {
  if (!file) throw new Error('暗号化するJSONファイルを指定してください');
  const coupons = validateCoupons(JSON.parse(fs.readFileSync(file, 'utf8')));
  const plain = JSON.stringify({ syncedAt: new Date().toISOString(), source: SOURCE_NAME, coupons });

  const key = await webcrypto.subtle.importKey('raw', Buffer.from(readKey(), 'base64url'), 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(plain));

  const payload = { v: 1, iv: iv.toString('base64url'), ct: Buffer.from(ct).toString('base64url') };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload) + '\n');
  console.log(`${coupons.length}件を暗号化して ${path.relative(ROOT, OUTPUT_PATH)} に書き出しました。`);
}

function markSynced() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ lastSuccessAt: new Date().toISOString() }) + '\n');
  console.log('最終同期日時を記録しました。');
}

const commands = { init, status, encrypt: () => encrypt(process.argv[3]), 'mark-synced': markSynced };
const command = commands[process.argv[2]];
if (!command) {
  console.error('使い方: node scripts/coupon-sync.js <init|status|encrypt FILE|mark-synced>');
  process.exitCode = 1;
} else {
  Promise.resolve()
    .then(command)
    .catch((err) => {
      console.error(`エラー: ${err.message}`);
      process.exitCode = 1;
    });
}
