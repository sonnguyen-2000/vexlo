'use strict';
/* Browser test of the floating button using Playwright Chromium and a fake `browser` API.
 * Run: node test/e2e-content.js [screenshotDir]   (not part of `npm test`: needs Playwright) */
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const SHOT = process.argv[2] || null;
const CONTENT = path.join(__dirname, '..', 'extension', 'content.js');

const PAGE = `<!doctype html><html><body style="margin:0;background:#222;font-family:sans-serif">
<video id="big" width="640" height="360" controls style="position:absolute;left:40px;top:60px;background:#000"></video>
<video id="small" width="120" height="70" style="position:absolute;left:720px;top:60px;background:#000"></video>
</body></html>`;

async function setup(browser, { locale, media, floating = true, videoSrc }) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 560 }, locale });
  const page = await ctx.newPage();
  await page.route('http://test.local/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await page.addInitScript(() => {
    const orig = Element.prototype.attachShadow; // open the closed shadow root so the test can query it
    Element.prototype.attachShadow = function (init) { return orig.call(this, { ...init, mode: 'open' }); };
  });
  await page.addInitScript(({ media: m, floating: f }) => {
    window.__sent = [];
    window.browser = {
      runtime: {
        sendMessage: async (msg) => {
          window.__sent.push(msg);
          if (msg.type === 'getSettings') { return { floating: f }; }
          if (msg.type === 'getMedia') { return m; }
          return { ok: true };
        },
      },
    };
  }, { media, floating });
  await page.goto('http://test.local/');
  if (videoSrc) { await page.evaluate((s) => { document.getElementById('big').src = s; }, videoSrc); }
  await page.addScriptTag({ path: CONTENT });
  await page.waitForTimeout(150);
  return { ctx, page };
}

const hover = async (page, sel = '#big') => {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + 40, b.y + 40);
  await page.mouse.move(b.x + 60, b.y + 60);
  await page.waitForTimeout(250);
};

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); console.log('ok -', name); };

  await check('button appears at the top-right corner of a large video, hidden for small ones', async () => {
    const { ctx, page } = await setup(browser, { locale: 'vi-VN', media: [] });
    await hover(page, '#small');
    assert.equal(await page.locator('.btn').count(), 0, 'no button for a tiny video');
    await hover(page);
    const btn = page.locator('.btn');
    await btn.waitFor({ state: 'visible' });
    const bb = await btn.boundingBox();
    const vb = await page.locator('#big').boundingBox();
    assert.ok(bb.x + bb.width <= vb.x + vb.width && bb.x > vb.x + vb.width / 2, 'right half of the video');
    assert.ok(bb.y >= vb.y && bb.y < vb.y + 40, 'near the top edge');
    assert.match(await btn.innerText(), /Tải video này/);
    if (SHOT) { await page.screenshot({ path: path.join(SHOT, 'float-button.png') }); }
    await ctx.close();
  });

  await check('one captured item is sent immediately and a confirmation toast is shown', async () => {
    const { ctx, page } = await setup(browser, { locale: 'en-US', media: [{ id: 'k1', url: 'https://h/a.mp4', kind: 'file', ext: 'mp4', size: 1234567 }] });
    await hover(page);
    await page.locator('.btn').click();
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === 'send'));
    assert.deepEqual(sent, [{ type: 'send', id: 'k1' }]);
    assert.match(await page.locator('.toast').innerText(), /Added to Vexlo/);
    await ctx.close();
  });

  await check('several items open a chooser; clicking one sends that item', async () => {
    const media = [
      { id: 'hls1', url: 'https://cdn.x/p/master.m3u8', kind: 'hls', ext: 'm3u8', size: 0 },
      { id: 'f2', url: 'https://cdn.x/p/Phim%20Hay.mp4', kind: 'file', ext: 'mp4', size: 734003200 },
      { id: 'a3', url: 'https://cdn.x/p/nhac.mp3', kind: 'file', ext: 'mp3', size: 4200000, audioOnly: true },
    ];
    const { ctx, page } = await setup(browser, { locale: 'vi-VN', media });
    await hover(page);
    await page.locator('.btn').click();
    await page.locator('.panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.panel .it').count(), 3);
    assert.match(await page.locator('.panel').innerText(), /Phim Hay\.mp4/, 'decoded file name');
    assert.match(await page.locator('.panel').innerText(), /700\.0 MB/);
    if (SHOT) { await page.screenshot({ path: path.join(SHOT, 'float-panel.png') }); }
    await page.locator('.panel .it').nth(1).click();
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === 'send'));
    assert.deepEqual(sent, [{ type: 'send', id: 'f2' }]);
    assert.equal(await page.locator('.panel').isVisible(), false, 'panel closes after choosing');
    await ctx.close();
  });

  await check('nothing sniffed + plain http video src falls back to sendUrl', async () => {
    const { ctx, page } = await setup(browser, { locale: 'en-US', media: [], videoSrc: 'http://test.local/clip.mp4' });
    await hover(page);
    await page.locator('.btn').click();
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === 'sendUrl'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'http://test.local/clip.mp4');
    await ctx.close();
  });

  await check('nothing sniffed + blob: src shows a helpful message and sends nothing', async () => {
    const { ctx, page } = await setup(browser, { locale: 'en-US', media: [], videoSrc: 'blob:http://test.local/abc' });
    await hover(page);
    await page.locator('.btn').click();
    await page.waitForTimeout(200);
    assert.match(await page.locator('.toast').innerText(), /No media captured/);
    assert.equal((await page.evaluate(() => window.__sent.filter((m) => /^send/.test(m.type)))).length, 0);
    await ctx.close();
  });

  await check('app not running: error toast is shown', async () => {
    const { ctx, page } = await setup(browser, { locale: 'vi-VN', media: [{ id: 'k', url: 'https://h/a.mp4', kind: 'file', ext: 'mp4', size: 9e6 }] });
    await page.evaluate(() => { const o = window.browser.runtime.sendMessage; window.browser.runtime.sendMessage = async (m) => (m.type === 'send' ? { ok: false } : o(m)); });
    await hover(page);
    await page.locator('.btn').click();
    await page.waitForTimeout(200);
    assert.match(await page.locator('.toast').innerText(), /Không kết nối được Vexlo/);
    await ctx.close();
  });

  await check('floating button can be disabled from settings', async () => {
    const { ctx, page } = await setup(browser, { locale: 'en-US', media: [], floating: false });
    await hover(page);
    assert.equal(await page.locator('.btn').count(), 0);
    await ctx.close();
  });

  await browser.close();
  console.log(`\n${results.length} browser checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
