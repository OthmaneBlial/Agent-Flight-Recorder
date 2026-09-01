import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const screenshot = await readFile(resolve('docs/assets/replay-console.png'));
const screenshotUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'dark', deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
          body {
            position: relative;
            display: grid;
            grid-template-columns: 56% 44%;
            color: #f3f0e7;
            background:
              linear-gradient(rgba(255,255,255,.024) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,.024) 1px, transparent 1px),
              #090b0b;
            background-size: 30px 30px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          }
          body::before { content: ""; position: absolute; inset: 0 0 auto; height: 7px; background: #f6b73c; }
          .copy { position: relative; z-index: 2; display: flex; flex-direction: column; padding: 54px 20px 46px 58px; }
          .brand { display: flex; align-items: center; gap: 16px; color: #f6b73c; font-size: 16px; font-weight: 800; letter-spacing: .08em; }
          .mark { width: 58px; height: 46px; display: grid; place-items: center; border: 2px solid #f6b73c; font-size: 15px; }
          .kicker { margin: 70px 0 16px; color: #f6b73c; font-size: 14px; font-weight: 700; letter-spacing: .14em; }
          h1 { max-width: 630px; margin: 0; font-family: Inter, Arial, sans-serif; font-size: 61px; line-height: .97; letter-spacing: -.052em; }
          h1 em { display: block; color: #f6b73c; font-style: normal; }
          .lede { max-width: 585px; margin: 26px 0 0; color: #aeb3ad; font-size: 17px; line-height: 1.52; }
          .ledger { display: flex; gap: 12px; margin-top: auto; }
          .ledger span { padding: 9px 12px; border: 1px solid #3a403b; color: #a9afa9; font-size: 11px; font-weight: 700; letter-spacing: .07em; }
          .visual { position: relative; overflow: hidden; border-left: 1px solid #353b36; background: #0d100f; }
          .visual::before { content: "EVIDENCE / NOT NARRATIVE"; position: absolute; z-index: 3; top: 43px; right: 35px; color: #f6b73c; font-size: 10px; font-weight: 800; letter-spacing: .13em; }
          .console { position: absolute; top: 92px; left: 34px; width: 770px; max-width: none; border: 1px solid #525951; box-shadow: 0 30px 80px rgba(0,0,0,.65); }
          .route { position: absolute; z-index: 3; right: 34px; bottom: 35px; left: 34px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 13px; color: #8ddd72; font-size: 11px; font-weight: 700; letter-spacing: .08em; }
          .route i { height: 1px; background: linear-gradient(90deg, #f6b73c, #8ddd72); }
          .corner { position: absolute; right: 0; bottom: 0; width: 92px; height: 92px; border-top: 1px solid #f6b73c; border-left: 1px solid #f6b73c; opacity: .4; }
        </style>
      </head>
      <body>
        <main class="copy">
          <div class="brand"><span class="mark">AFR</span><span>AGENT FLIGHT RECORDER</span></div>
          <p class="kicker">THE LOCAL BLACK BOX</p>
          <h1>Debug AI agents.<em>Replay the proof.</em></h1>
          <p class="lede">Read-only forensic timelines for tools, tests, retries, permissions, failures, and exact code evolution.</p>
          <div class="ledger"><span>LOOPBACK ONLY</span><span>NO TELEMETRY</span><span>MIT</span></div>
        </main>
        <aside class="visual">
          <img class="console" src="${screenshotUrl}" alt="" />
          <div class="route"><span>PROMPT</span><i></i><span>PROOF</span></div>
          <div class="corner"></div>
        </aside>
      </body>
    </html>`);
  await page.screenshot({ path: resolve('site/assets/social-card.png') });
  await writeFile(resolve('docs/assets/social-card.png'), await readFile(resolve('site/assets/social-card.png')));
} finally {
  await browser.close();
}
