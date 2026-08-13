const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto('http://localhost:8123', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 1. 検索結果画面(マクドナルドで検索しておすすめタグを見せる)
  await page.fill('#search-input', 'マクドナルド');
  await page.dispatchEvent('#search-input', 'input');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.claude/screenshots/01-search.png' });

  // 2. カード一覧画面
  await page.click('[data-tab="cards"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.claude/screenshots/02-cards.png' });

  // 3. カードをタップして店舗ランキング展開
  await page.click('.card-item-info');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.claude/screenshots/03-card-detail.png' });

  // 4. 店舗一覧画面
  await page.click('[data-tab="stores"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.claude/screenshots/04-stores.png' });

  // 5. ダークモード版の検索画面
  await context.close();
  const darkContext = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const darkPage = await darkContext.newPage();
  await darkPage.goto('http://localhost:8123', { waitUntil: 'networkidle' });
  await darkPage.waitForTimeout(500);
  await darkPage.fill('#search-input', 'マクドナルド');
  await darkPage.dispatchEvent('#search-input', 'input');
  await darkPage.waitForTimeout(300);
  await darkPage.screenshot({ path: '.claude/screenshots/05-search-dark.png' });

  await browser.close();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
