import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const port = 4183;
const baseUrl = `http://127.0.0.1:${port}`;
const outputDirectory = resolve('docs/assets');
const server = spawn(process.execPath, ['build/server/cli.js', 'demo', '--reset', '--data-dir=.flight-recorder-screenshots', `--port=${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
server.stdout.on('data', (chunk) => {
  logs += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  logs += chunk.toString();
});

try {
  await waitForServer(`${baseUrl}/api/health`);
  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch();
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' });
    await desktop.goto(baseUrl);
    await desktop.locator('[data-app-ready="true"]').waitFor();
    await desktop.screenshot({ path: resolve(outputDirectory, 'replay-console.png') });

    await desktop.getByRole('button', { name: /Files/ }).click();
    await desktop.getByRole('button', { name: /Timeout settlement patched/ }).click();
    await desktop.locator('.diff-view').waitFor();
    await desktop.screenshot({ path: resolve(outputDirectory, 'code-evolution.png') });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await mobile.goto(baseUrl);
    await mobile.locator('[data-app-ready="true"]').waitFor();
    await mobile.screenshot({ path: resolve(outputDirectory, 'mobile-replay.png') });
  } finally {
    await browser.close();
  }
} catch (error) {
  if (logs.trim()) console.error(logs.trim());
  throw error;
} finally {
  server.kill('SIGTERM');
}

async function waitForServer(url) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
