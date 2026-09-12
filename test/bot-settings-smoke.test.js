const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const settingsJs = fs.readFileSync(path.join(root, 'public/js/settings.js'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');
const mobileCss = fs.readFileSync(path.join(root, 'public/css/styles-mobile.css'), 'utf8');

test('Settings is removed as a navigation destination', () => {
  assert.doesNotMatch(html, /data-tab=["']tab-settings["']/);
  assert.doesNotMatch(html, /id=["']tab-settings["']/);
  assert.doesNotMatch(html, /settings-redirect/);
  assert.doesNotMatch(appJs, /tab-settings|loadConfig|saveSettings/);
});

test('bot settings expose three accessible disclosures and retain field mappings', () => {
  assert.equal((html.match(/<details class="bsp-section/g) || []).length, 5);
  assert.equal((html.match(/<summary class="bsp-section-header">/g) || []).length, 5);
  assert.match(html, /<details class="bsp-section bsp-virtual-section" open>/);
  assert.match(html, /<details class="bsp-section bsp-required" open>/);
  assert.match(html, /<details class="bsp-section bsp-strategy-section">/);
  for (const id of [
    'cfg-bot-virtual-enabled',
    'cfg-bot-virtual-loss-threshold',
    'cfg-bot-virtual-return-mode',
    'cfg-bot-tp',
    'cfg-bot-sl',
    'cfg-bot-max-runs',
    'cfg-bot-zone',
    'cfg-bot-dominance'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(settingsJs, /OFF lets every qualifying signal place a real trade immediately/);
  assert.match(settingsJs, /Real win only returns to paper mode/);
  assert.match(settingsJs, /Real loss only returns to paper mode/);
});

test('desktop bot layout uses available width and mobile layout stacks', () => {
  assert.match(desktopCss, /\.bots-screen[\s\S]*?width: 100%;[\s\S]*?max-width: none;/);
  assert.match(desktopCss, /@media \(min-width: 769px\)[\s\S]*?grid-template-columns: minmax\(240px, 0\.72fr\) minmax\(0, 1\.28fr\)/);
  assert.match(desktopCss, /@media \(min-width: 769px\)[\s\S]*?\.bot-settings-panel[\s\S]*?grid-column: 2/);
  assert.match(mobileCss, /\.bot-settings-panel[\s\S]*?border-left: 0/);
});

const DEFAULT_CONFIG = {
  BOT_DURATION: 5,
  BOT_DURATION_UNIT: 't',
  BOT_BASE_STAKE: 0.35,
  BOT_TAKE_PROFIT: null,
  BOT_STOP_LOSS: null,
  BOT_MAX_RUNS: null,
  BOT_COOLDOWN: 5,
  BOT_RSI_OVERSOLD: 30,
  BOT_RSI_OVERBOUGHT: 70,
  SNIPER_ZONE_PCT: 20,
  SNIPER_TICKS: 2,
  SNIPER_DOMINANCE: 50,
  SNIPER_BREAKOUT_BUFFER: 0.5,
  SNIPER_MAX_AUTOCORRELATION: -0.05,
  BOT_VIRTUAL_FILTER_ENABLED: true,
  BOT_VIRTUAL_LOSS_THRESHOLD: 4,
  BOT_VIRTUAL_RETURN_MODE: 'any'
};

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function createBrowserSmokeServer() {
  let config = { ...DEFAULT_CONFIG };
  const configPosts = [];

  const json = (res, payload, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');

    if (requestUrl.pathname === '/stream') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === '/api/config' && req.method === 'GET') {
      json(res, config);
      return;
    }

    if (requestUrl.pathname === '/api/config' && req.method === 'POST') {
      const body = await readRequestBody(req);
      configPosts.push(body);
      config = { ...config, ...body };
      json(res, { success: true });
      return;
    }

    if (requestUrl.pathname === '/api/config/reset' && req.method === 'POST') {
      config = {
        ...DEFAULT_CONFIG,
        BOT_TAKE_PROFIT: config.BOT_TAKE_PROFIT,
        BOT_STOP_LOSS: config.BOT_STOP_LOSS,
        BOT_MAX_RUNS: config.BOT_MAX_RUNS,
        BOT_VIRTUAL_FILTER_ENABLED: config.BOT_VIRTUAL_FILTER_ENABLED,
        BOT_VIRTUAL_LOSS_THRESHOLD: config.BOT_VIRTUAL_LOSS_THRESHOLD,
        BOT_VIRTUAL_RETURN_MODE: config.BOT_VIRTUAL_RETURN_MODE
      };
      json(res, {
        success: true,
        config,
        message: 'Strategy defaults restored. Risk and virtual-filter safety controls preserved.'
      });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      json(res, { equityData: [], assetContributions: [] });
      return;
    }

    const relativePath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const filePath = path.resolve(root, 'public', `.${relativePath}`);
    if (!filePath.startsWith(path.resolve(root, 'public') + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }

    try {
      const contents = fs.readFileSync(filePath);
      const contentTypes = {
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.html': 'text/html'
      };
      res.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream'
      });
      res.end(contents);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return {
    server,
    configPosts,
    reset() {
      config = { ...DEFAULT_CONFIG };
      configPosts.length = 0;
    },
    listen() {
      return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    }
  };
}

function requestJson(port, method, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: payload ? { 'Content-Type': 'application/json' } : {}
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({
            statusCode: response.statusCode,
            body: body ? JSON.parse(body) : null
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (payload) request.write(JSON.stringify(payload));
    request.end();
  });
}

async function startRealServer(configPath) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, BOT_CONFIG_PATH: configPath, FAKE_CLOUD_PATH: configPath + '.cloud', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const onData = chunk => {
      output += chunk;
      const match = output.match(/Server listening on port (\d+)/);
      if (match) {
        child.stdout.off('data', onData);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`server exited before listening (code ${code}): ${output}`));
    });
  });
  const port = await ready;
  return {
    child,
    port,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  };
}

async function waitForConfigPost(page, configPosts, previousCount) {
  await page.waitForTimeout(750);
  assert.ok(configPosts.length > previousCount, 'expected a debounced config save');
  return configPosts.at(-1);
}

async function openBotsScreen(page, viewportWidth) {
  if (viewportWidth <= 768) {
    await page.locator('#mobileProfileBtn').click();
    await page.locator('#navDrawer .drawer-nav-item[data-tab="tab-bots"]').click();
  } else {
    await page.locator('.header-tabs .nav-tab[data-tab="tab-bots"]').click();
  }
  await assert.doesNotReject(() => page.locator('#tab-bots.active').waitFor());
}

async function assertKeyboardDisclosures(page) {
  const sections = page.locator('.bot-settings-panel details');
  assert.equal(await sections.count(), 5);

  for (let index = 0; index < await sections.count(); index += 1) {
    const section = sections.nth(index);
    const summary = section.locator('summary');
    const startsOpen = await section.getAttribute('open') !== null;

    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await section.getAttribute('open') !== null,
      !startsOpen,
      `disclosure ${index + 1} should toggle closed/open from the keyboard`
    );

    await page.keyboard.press('Enter');
    assert.equal(
      await section.getAttribute('open') !== null,
      startsOpen,
      `disclosure ${index + 1} should toggle back from the keyboard`
    );
  }
}

async function assertVirtualFilterSave(page, configPosts) {
  const initialPosts = configPosts.length;
  await page.locator('#cfg-bot-virtual-enabled').evaluate(input => input.click());
  assert.match(
    await page.locator('#bot-virtual-summary').textContent(),
    /OFF:.*no virtual-loss guard applies/
  );
  await page.locator('#cfg-bot-virtual-loss-threshold').fill('7');
  await page.locator('#cfg-bot-virtual-return-mode').selectOption('loss');
  await page.locator('#cfg-bot-virtual-enabled').evaluate(input => input.click());

  await assert.match(
    await page.locator('#bot-virtual-summary').textContent(),
    /ON:.*7 consecutive virtual losses.*real loss only/
  );

  const payload = await waitForConfigPost(page, configPosts, initialPosts);
  assert.equal(payload.BOT_VIRTUAL_FILTER_ENABLED, true);
  assert.equal(payload.BOT_VIRTUAL_LOSS_THRESHOLD, 7);
  assert.equal(payload.BOT_VIRTUAL_RETURN_MODE, 'loss');
}

async function assertRequiredValidation(page, configPosts) {
  assert.equal(await page.locator('#bot-start-btn').isDisabled(), true);

  for (const missingField of ['#cfg-bot-tp', '#cfg-bot-sl', '#cfg-bot-max-runs']) {
    const completeConfigPostCount = configPosts.length;
    await page.locator('#cfg-bot-tp').fill('12.50');
    await page.locator('#cfg-bot-sl').fill('5.00');
    await page.locator('#cfg-bot-max-runs').fill('20');
    await waitForConfigPost(page, configPosts, completeConfigPostCount);

    const incompleteConfigPostCount = configPosts.length;
    await page.locator(missingField).fill('');
    await waitForConfigPost(page, configPosts, incompleteConfigPostCount);
    assert.equal(
      await page.locator('#bot-start-btn').isDisabled(),
      true,
      `${missingField} should keep Start Bot disabled`
    );
  }
}

async function assertStrategyResetPreservesSafety(page, configPosts) {
  const strategySection = page.locator('details.bsp-strategy-section');
  if (await strategySection.getAttribute('open') === null) {
    await strategySection.locator('summary').focus();
    await page.keyboard.press('Enter');
  }
  assert.equal(await strategySection.getAttribute('open') !== null, true);

  const configuredPostCount = configPosts.length;
  await page.locator('#cfg-bot-tp').fill('18.75');
  await page.locator('#cfg-bot-sl').fill('6.25');
  await page.locator('#cfg-bot-max-runs').fill('42');
  await page.locator('#cfg-bot-virtual-enabled').evaluate(input => {
    if (!input.checked) input.click();
  });
  await page.locator('#cfg-bot-virtual-loss-threshold').fill('9');
  await page.locator('#cfg-bot-virtual-return-mode').selectOption('win');
  await page.locator('#cfg-bot-zone').evaluate(element => {
    element.value = '33';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#cfg-bot-dominance').evaluate(element => {
    element.value = '85';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForConfigPost(page, configPosts, configuredPostCount);

  const safetyBeforeReset = await page.evaluate(() => ({
    takeProfit: document.querySelector('#cfg-bot-tp').value,
    stopLoss: document.querySelector('#cfg-bot-sl').value,
    maxRuns: document.querySelector('#cfg-bot-max-runs').value,
    virtualEnabled: document.querySelector('#cfg-bot-virtual-enabled').checked,
    threshold: document.querySelector('#cfg-bot-virtual-loss-threshold').value,
    returnMode: document.querySelector('#cfg-bot-virtual-return-mode').value
  }));

  await page.locator('.bsp-reset-btn').click();
  await page.waitForFunction(() => document.querySelector('#bot-save-status').textContent.startsWith('↩'));

  const safetyAfterReset = await page.evaluate(() => ({
    takeProfit: document.querySelector('#cfg-bot-tp').value,
    stopLoss: document.querySelector('#cfg-bot-sl').value,
    maxRuns: document.querySelector('#cfg-bot-max-runs').value,
    virtualEnabled: document.querySelector('#cfg-bot-virtual-enabled').checked,
    threshold: document.querySelector('#cfg-bot-virtual-loss-threshold').value,
    returnMode: document.querySelector('#cfg-bot-virtual-return-mode').value
  }));

  assert.deepEqual(safetyAfterReset, safetyBeforeReset);
  assert.equal(await page.locator('#cfg-bot-zone').inputValue(), '20');
  assert.equal(await page.locator('#cfg-bot-dominance').inputValue(), '50');
}

test('browser smoke covers bot settings at desktop and mobile sizes', async t => {
  const smokeServer = createBrowserSmokeServer();
  const port = await smokeServer.listen();
  let browser;
  try {
    const chromePath = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
    browser = await chromium.launch({
      headless: true,
      executablePath: require('node:fs').existsSync(chromePath) ? chromePath : undefined
    });
  } catch (error) {
    await smokeServer.close();
    throw error;
  }

  t.after(async () => {
    await browser.close();
    await smokeServer.close();
  });

  for (const viewportWidth of [1280, 390]) {
    await t.test(`${viewportWidth}px`, async () => {
      smokeServer.reset();
      const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 } });
      try {
        await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.abort());
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

        await openBotsScreen(page, viewportWidth);
        const dimensions = await page.evaluate(() => ({
          viewport: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth
        }));
        assert.ok(
          dimensions.documentWidth <= dimensions.viewport + 1,
          `${viewportWidth}px Bots screen should not overflow horizontally`
        );

        await assertKeyboardDisclosures(page);
        await assertVirtualFilterSave(page, smokeServer.configPosts);
        await assertRequiredValidation(page, smokeServer.configPosts);
        await assertStrategyResetPreservesSafety(page, smokeServer.configPosts);
      } finally {
        await page.close();
      }
    });
  }
});

test('bot safety settings persist across a real server restart', async t => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'over3-bot-config-'));
  const configPath = path.join(tempDirectory, 'bot_config.json');
  const configuredSafety = {
    BOT_TAKE_PROFIT: 18.75,
    BOT_STOP_LOSS: 6.25,
    BOT_MAX_RUNS: 42,
    BOT_MARTINGALE_ENABLED: false,
    BOT_MARTINGALE_MULTIPLIER: 2,
    BOT_MARTINGALE_MAX_STEPS: 4,
    BOT_SYMBOLS: [],
    BOT_VIRTUAL_FILTER_ENABLED: false,
    BOT_VIRTUAL_LOSS_THRESHOLD: 9,
    BOT_VIRTUAL_RETURN_MODE: 'loss'
  };
  let firstServer;
  let secondServer;

  t.after(async () => {
    await firstServer?.stop();
    await secondServer?.stop();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  firstServer = await startRealServer(configPath);
  const saveResponse = await requestJson(firstServer.port, 'POST', '/api/config', configuredSafety);
  assert.equal(saveResponse.statusCode, 200);
  await firstServer.stop();
  firstServer = undefined;

  secondServer = await startRealServer(configPath);
  const configResponse = await requestJson(secondServer.port, 'GET', '/api/config');
  assert.equal(configResponse.statusCode, 200);
  assert.deepEqual(
    Object.fromEntries(Object.keys(configuredSafety).map(key => [key, configResponse.body[key]])),
    configuredSafety
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    ...DEFAULT_CONFIG,
    ...configuredSafety
  });
});