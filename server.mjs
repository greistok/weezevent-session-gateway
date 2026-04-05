import express from 'express';
import puppeteer from 'puppeteer-core';

const app = express();

app.use(express.json({ limit: '256kb' }));

const DEFAULT_START_URL = process.env.WEEZEVENT_START_URL || 'https://admin.weezevent.com/ticket/O1145913/events';
const DEFAULT_TIMEOUT_MS = Number(process.env.WEEZEVENT_TIMEOUT_MS || 45000);

function buildBrowserWSEndpoint() {
  const browserlessUrl = process.env.BROWSERLESS_URL || '';
  if (!browserlessUrl) {
    throw new Error('BROWSERLESS_URL is missing');
  }

  const token = process.env.BROWSERLESS_TOKEN || '';
  const wsUrl = new URL(browserlessUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  if (token && !wsUrl.searchParams.has('token')) {
    wsUrl.searchParams.set('token', token);
  }

  return wsUrl.toString();
}

function requireSharedSecret(req, res, next) {
  const expected = process.env.SERVICE_SHARED_SECRET || '';
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'service_shared_secret_missing' });
  }

  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerSecret = req.get('x-shared-secret') || '';
  const provided = bearer || headerSecret;

  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  return next();
}

async function readOidcSession(page) {
  return page.evaluate(() => {
    function scan(storageName, storage) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key || !key.startsWith('oidc.user:')) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        return {
          storage: storageName,
          storage_key: key,
          access_token: parsed.access_token || '',
          expires_at: parsed.expires_at || null,
          token_type: parsed.token_type || '',
          scope: parsed.scope || '',
          has_refresh_token: Boolean(parsed.refresh_token)
        };
      }
      return null;
    }

    return scan('sessionStorage', sessionStorage) || scan('localStorage', localStorage);
  });
}

async function maybeDismissCookieBanner(page) {
  const labels = ['Accepter', 'Accept', 'Tout accepter'];
  const buttons = await page.$$('button');
  for (const button of buttons) {
    const text = await page.evaluate(el => (el.innerText || '').trim(), button);
    if (labels.some(label => text.includes(label))) {
      await button.click().catch(() => {});
      return;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined
    };
  }

  if (error && typeof error === 'object') {
    return JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)));
  }

  return { message: String(error) };
}

async function detectBlockingStep(page) {
  const state = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return {
      url: location.href,
      text
    };
  });

  if (state.text.includes('validation en deux') || state.text.includes('2-step verification')) {
    return 'two_factor_required';
  }

  if (state.text.includes('captcha') || state.text.includes('recaptcha') || state.text.includes('robot')) {
    return 'captcha_or_bot_check';
  }

  return '';
}

async function waitForLoginFormOrSession(page, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const session = await readOidcSession(page).catch(() => null);
    if (session?.access_token) {
      return { ok: true, session };
    }

    const blocker = await detectBlockingStep(page).catch(() => '');
    if (blocker) {
      return { ok: false, error: blocker };
    }

    const hasLoginForm = await page.evaluate(() => {
      return Boolean(
        document.querySelector('input[name="_username"]') &&
        document.querySelector('input[name="_password"]')
      );
    }).catch(() => false);

    if (hasLoginForm) {
      return { ok: true, loginFormReady: true };
    }

    await sleep(1000);
  }

  return { ok: false, error: 'login_form_not_found_before_timeout' };
}

async function waitForSession(page, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const session = await readOidcSession(page);
    if (session?.access_token) {
      return { ok: true, session };
    }

    const blocker = await detectBlockingStep(page);
    if (blocker) {
      return { ok: false, error: blocker };
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { ok: false, error: 'session_not_found_before_timeout' };
}

async function loginAndExtractToken({ email, password, startUrl, timeoutMs }) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: buildBrowserWSEndpoint(),
    protocolTimeout: timeoutMs
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await maybeDismissCookieBanner(page);

    const preSession = await readOidcSession(page).catch(() => null);
    if (preSession?.access_token) {
      return {
        ok: true,
        source: 'existing_session',
        ...preSession,
        final_url: page.url()
      };
    }

    const loginStep = await waitForLoginFormOrSession(page, timeoutMs);
    if (!loginStep.ok) {
      return {
        ok: false,
        error: loginStep.error,
        final_url: page.url()
      };
    }

    if (loginStep.session?.access_token) {
      return {
        ok: true,
        source: 'existing_session',
        ...loginStep.session,
        final_url: page.url()
      };
    }

    await page.type('input[name="_username"]', email, { delay: 20 });
    await page.type('input[name="_password"]', password, { delay: 20 });

    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.click('button[type="submit"], button[name="save"]')
    ]);

    const result = await waitForSession(page, timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        final_url: page.url()
      };
    }

    return {
      ok: true,
      source: 'fresh_login',
      ...result.session,
      final_url: page.url()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'weezevent-session-gateway',
    start_url: DEFAULT_START_URL
  });
});

app.post('/weezevent/session-token', requireSharedSecret, async (req, res) => {
  const email = req.body?.email || process.env.WEEZEVENT_EMAIL || '';
  const password = req.body?.password || process.env.WEEZEVENT_PASSWORD || '';
  const startUrl = req.body?.start_url || DEFAULT_START_URL;
  const timeoutMs = Number(req.body?.timeout_ms || DEFAULT_TIMEOUT_MS);

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'missing_credentials' });
  }

  try {
    const result = await loginAndExtractToken({ email, password, startUrl, timeoutMs });
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    const details = serializeError(error);
    return res.status(500).json({
      ok: false,
      error: 'gateway_failure',
      message: details.message || String(error),
      details
    });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`weezevent-session-gateway listening on :${port}`);
});
