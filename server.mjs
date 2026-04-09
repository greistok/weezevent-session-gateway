import express from 'express';
import puppeteer from 'puppeteer-core';

const app = express();

app.use(express.json({ limit: '256kb' }));

const DEFAULT_START_URL = process.env.WEEZEVENT_START_URL || 'https://admin.weezevent.com/ticket/O1145913/events';
const DEFAULT_TIMEOUT_MS = Number(process.env.WEEZEVENT_TIMEOUT_MS || 45000);
const WEEZEVENT_ACCOUNTS_URL = 'https://accounts.weezevent.com/';
const DEBUG_ATTEMPT_HISTORY = [];
const DEBUG_ATTEMPT_HISTORY_LIMIT = 20;

function buildBrowserWSEndpoint(timeoutMs) {
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

  if (!wsUrl.searchParams.has('timeout')) {
    wsUrl.searchParams.set('timeout', String(Math.max(timeoutMs + 30000, 120000)));
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

function createAttemptTrace(route, metadata) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    route,
    started_at: new Date().toISOString(),
    metadata,
    events: []
  };
}

function pushTraceEvent(trace, type, details) {
  if (!trace) {
    return;
  }

  trace.events.push({
    at: new Date().toISOString(),
    type,
    details
  });

  if (trace.events.length > 200) {
    trace.events.shift();
  }
}

function storeTrace(trace) {
  if (!trace) {
    return;
  }

  DEBUG_ATTEMPT_HISTORY.unshift(trace);
  while (DEBUG_ATTEMPT_HISTORY.length > DEBUG_ATTEMPT_HISTORY_LIMIT) {
    DEBUG_ATTEMPT_HISTORY.pop();
  }
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
  try {
    const labels = ['Accepter', 'Accept', 'Tout accepter'];
    const buttons = await page.$$('button');
    for (const button of buttons) {
      const text = await page.evaluate(el => (el.innerText || '').trim(), button).catch(() => '');
      if (labels.some(label => text.includes(label))) {
        await button.click().catch(() => {});
        return;
      }
    }
  } catch {
    // Ignore cookie-banner probing failures during auth redirects.
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stringifyUnknown(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isDetachedFrameError(error) {
  const message = stringifyUnknown(error?.message || error).toLowerCase();
  return message.includes('detached frame');
}

function isRetryableGatewayError(error) {
  const message = stringifyUnknown(error?.message || error).toLowerCase();
  return (
    message.includes('detached frame') ||
    message.includes('navigating frame was detached') ||
    message.includes('target closed') ||
    message.includes('session_not_found_before_timeout')
  );
}

function serializeError(error) {
  if (error instanceof Error) {
    const extra = {};
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
      extra[key] = error[key];
    }
    return {
      name: error.name,
      message: stringifyUnknown(error.message) || error.name || 'Unknown error',
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined,
      ...extra
    };
  }

  if (error && typeof error === 'object') {
    const ctorName = error.constructor && error.constructor.name ? error.constructor.name : 'Object';
    const plain = {};
    for (const key of Object.getOwnPropertyNames(error)) {
      plain[key] = error[key];
    }
    return {
      name: plain.name || ctorName,
      ...plain,
      message: stringifyUnknown(plain.message || error),
      object_keys: Object.keys(plain)
    };
  }

  return { message: stringifyUnknown(error) };
}

function summarizeConsoleMessage(message) {
  return {
    type: message.type(),
    text: message.text()
  };
}

function parseStoredOidcValue(storageName, storageKey, raw) {
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw);
  if (!parsed || !parsed.access_token) {
    return null;
  }

  return {
    storage: storageName,
    storage_key: storageKey,
    access_token: parsed.access_token || '',
    expires_at: parsed.expires_at || null,
    token_type: parsed.token_type || '',
    scope: parsed.scope || '',
    has_refresh_token: Boolean(parsed.refresh_token)
  };
}

function parseCapturedOidcConsoleMessage(text) {
  const marker = '__OIDC_CAPTURED__';
  if (!text || !text.startsWith(marker)) {
    return null;
  }

  const payload = JSON.parse(text.slice(marker.length));
  return parseStoredOidcValue(payload.storage, payload.key, payload.value);
}

async function capturePageState(page) {
  if (!page || page.isClosed()) {
    return { page_closed: true };
  }

  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
      return {
        title: document.title || '',
        url: location.href,
        has_login_form: Boolean(
          (document.querySelector('input[name="_username"]') || document.querySelector('input#username') || document.querySelector('input[name="username"]')) &&
          (document.querySelector('input[name="_password"]') || document.querySelector('input#password') || document.querySelector('input[name="password"]'))
        ),
        body_excerpt: text
      };
    });
  } catch (error) {
    return {
      state_capture_error: stringifyUnknown(error?.message || error)
    };
  }
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

  if (
    state.text.includes('your email or password was not correct') ||
    state.text.includes('email or password was not correct') ||
    state.text.includes('votre email ou mot de passe est incorrect') ||
    state.text.includes('identifiants incorrects')
  ) {
    return 'invalid_credentials';
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
        (document.querySelector('input[name="_username"]') || document.querySelector('input#username') || document.querySelector('input[name="username"]')) &&
        (document.querySelector('input[name="_password"]') || document.querySelector('input#password') || document.querySelector('input[name="password"]'))
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
    if (page.isClosed()) {
      return { ok: false, error: 'page_closed_while_waiting_session' };
    }

    const session = await readOidcSession(page).catch(error => {
      if (isDetachedFrameError(error)) {
        return null;
      }
      throw error;
    });
    if (session?.access_token) {
      return { ok: true, session };
    }

    const blocker = await detectBlockingStep(page).catch(error => {
      if (isDetachedFrameError(error)) {
        return '';
      }
      throw error;
    });
    if (blocker) {
      return { ok: false, error: blocker };
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { ok: false, error: 'session_not_found_before_timeout' };
}

async function waitForSessionWithRetry(page, timeoutMs, startUrl) {
  const firstPass = await waitForSession(page, timeoutMs);
  if (firstPass.ok || !startUrl) {
    return firstPass;
  }

  const currentUrl = page.isClosed() ? '' : page.url();
  if (!currentUrl.startsWith('https://admin.weezevent.com/ticket/')) {
    return firstPass;
  }

  const retryUrls = [WEEZEVENT_ACCOUNTS_URL, startUrl];
  for (const retryUrl of retryUrls) {
    try {
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 30000) });
    } catch {
      continue;
    }

    const retried = await waitForSession(page, Math.min(timeoutMs, 45000));
    if (retried.ok) {
      return retried;
    }
  }
  return firstPass;
}

async function waitForPostSubmitState(page, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) {
      return { ok: false, error: 'page_closed_after_submit' };
    }

    const session = await readOidcSession(page).catch(() => null);
    if (session?.access_token) {
      return { ok: true, state: 'session_ready', session };
    }

    const blocker = await detectBlockingStep(page).catch(() => '');
    if (blocker) {
      return { ok: false, error: blocker };
    }

    const pageState = await capturePageState(page);
    const currentUrl = pageState.url || page.url();
    if (currentUrl.startsWith('https://admin.weezevent.com/ticket/')) {
      return {
        ok: true,
        state: 'admin_ready',
        page_state: pageState
      };
    }

    await sleep(750);
  }

  return { ok: false, error: 'post_submit_state_timeout' };
}

async function loginAndExtractToken({ email, password, startUrl, timeoutMs, trace, attempt }) {
  let stage = 'connect_browser';
  let lastUrl = '';
  let lastPageState = {};
  const consoleMessages = [];
  let lastCapturedSession = null;
  let browser;
  let browserWSEndpoint = '';

  function setStage(nextStage, extra) {
    stage = nextStage;
    pushTraceEvent(trace, 'stage', {
      attempt,
      stage: nextStage,
      url: lastUrl,
      ...extra
    });
  }

  try {
    browserWSEndpoint = buildBrowserWSEndpoint(timeoutMs);
    pushTraceEvent(trace, 'connect_browser', {
      attempt,
      browser_ws_endpoint_host: new URL(browserWSEndpoint).host,
      timeout_ms: timeoutMs
    });
    browser = await puppeteer.connect({
      browserWSEndpoint,
      protocolTimeout: timeoutMs
    });

    setStage('open_page');
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.evaluateOnNewDocument(() => {
      const marker = '__OIDC_CAPTURED__';

      function emit(storageName, key, value) {
        try {
          console.log(marker + JSON.stringify({
            storage: storageName,
            key: key,
            value: value
          }));
        } catch (_error) {
          // Ignore capture logging failures.
        }
      }

      function scanStorage(storageName, storage) {
        try {
          for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i);
            if (!key || !key.startsWith('oidc.user:')) continue;
            emit(storageName, key, storage.getItem(key));
          }
        } catch (_error) {
          // Ignore storage scan failures.
        }
      }

      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (typeof key === 'string' && key.startsWith('oidc.user:')) {
          const storageName = this === window.sessionStorage ? 'sessionStorage' : 'localStorage';
          emit(storageName, key, value);
        }
        return originalSetItem.apply(this, arguments);
      };

      scanStorage('sessionStorage', window.sessionStorage);
      scanStorage('localStorage', window.localStorage);
    });
    page.on('console', message => {
      const parsedSession = parseCapturedOidcConsoleMessage(message.text());
      if (parsedSession?.access_token) {
        lastCapturedSession = parsedSession;
        pushTraceEvent(trace, 'captured_session', {
          attempt,
          source: 'console_capture',
          storage: parsedSession.storage,
          storage_key: parsedSession.storage_key,
          expires_at: parsedSession.expires_at
        });
      }
      if (consoleMessages.length < 20) {
        consoleMessages.push(summarizeConsoleMessage(message));
      }
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        lastUrl = frame.url();
        pushTraceEvent(trace, 'navigate', {
          attempt,
          url: lastUrl
        });
      }
    });

    setStage('goto_start_url', { start_url: startUrl });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    lastUrl = page.url();
    await maybeDismissCookieBanner(page);
    lastPageState = await capturePageState(page);
    pushTraceEvent(trace, 'page_state', {
      attempt,
      stage,
      page_state: lastPageState
    });

    setStage('read_preexisting_session');
    const preSession = await readOidcSession(page).catch(() => null);
    if (preSession?.access_token) {
      pushTraceEvent(trace, 'session_found', {
        attempt,
        source: 'existing_session',
        storage: preSession.storage,
        storage_key: preSession.storage_key,
        expires_at: preSession.expires_at
      });
      return {
        ok: true,
        source: 'existing_session',
        ...preSession,
        final_url: page.url()
      };
    }

    setStage('wait_login_form_or_session');
    const loginStep = await waitForLoginFormOrSession(page, timeoutMs);
    lastUrl = page.url();
    lastPageState = await capturePageState(page);
    pushTraceEvent(trace, 'page_state', {
      attempt,
      stage,
      page_state: lastPageState
    });
    if (!loginStep.ok) {
      return {
        ok: false,
        error: loginStep.error,
        final_url: page.url()
      };
    }

    if (loginStep.session?.access_token) {
      pushTraceEvent(trace, 'session_found', {
        attempt,
        source: 'existing_session',
        storage: loginStep.session.storage,
        storage_key: loginStep.session.storage_key,
        expires_at: loginStep.session.expires_at
      });
      return {
        ok: true,
        source: 'existing_session',
        ...loginStep.session,
        final_url: page.url()
      };
    }

    setStage('type_credentials');
    const userSelector = (await page.$('input[name="_username"]')) ? 'input[name="_username"]' : 
                         (await page.$('input#username')) ? 'input#username' : 'input[name="username"]';
    const passSelector = (await page.$('input[name="_password"]')) ? 'input[name="_password"]' : 
                         (await page.$('input#password')) ? 'input#password' : 'input[name="password"]';
    
    await page.type(userSelector, email, { delay: 20 });
    await page.type(passSelector, password, { delay: 20 });
    lastPageState = await capturePageState(page);
    pushTraceEvent(trace, 'page_state', {
      attempt,
      stage,
      page_state: lastPageState
    });

    setStage('submit_login_form');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      (async () => {
        await page.focus(passSelector);
        await page.keyboard.press('Enter');
      })().catch(() => {}),
      page.click('button[type="submit"], button#kc-login, button[name="save"]').catch(() => {})
    ]);
    lastUrl = page.url();
    lastPageState = await capturePageState(page);
    pushTraceEvent(trace, 'page_state', {
      attempt,
      stage,
      page_state: lastPageState
    });

    setStage('wait_post_submit_state');
    const postSubmit = await waitForPostSubmitState(page, timeoutMs);
    lastUrl = page.url();
    lastPageState = await capturePageState(page);
    pushTraceEvent(trace, 'post_submit_state', {
      attempt,
      result: postSubmit,
      page_state: lastPageState
    });
    if (!postSubmit.ok) {
      return {
        ok: false,
        error: postSubmit.error,
        final_url: page.url()
      };
    }

    if (postSubmit.session?.access_token) {
      pushTraceEvent(trace, 'session_found', {
        attempt,
        source: 'fresh_login',
        storage: postSubmit.session.storage,
        storage_key: postSubmit.session.storage_key,
        expires_at: postSubmit.session.expires_at
      });
      return {
        ok: true,
        source: 'fresh_login',
        ...postSubmit.session,
        final_url: page.url()
      };
    }

    setStage('wait_session');
    const remainingTimeoutMs = Math.max(Math.min(timeoutMs, 60000), 30000);
    const result = await waitForSessionWithRetry(page, remainingTimeoutMs, startUrl);
    lastUrl = page.url();
    lastPageState = await capturePageState(page);
    pushTraceEvent(trace, 'wait_session_result', {
      attempt,
      result,
      page_state: lastPageState
    });
    if (!result.ok) {
      if (lastCapturedSession?.access_token) {
        pushTraceEvent(trace, 'session_found', {
          attempt,
          source: 'captured_during_redirect',
          storage: lastCapturedSession.storage,
          storage_key: lastCapturedSession.storage_key,
          expires_at: lastCapturedSession.expires_at
        });
        return {
          ok: true,
          source: 'captured_during_redirect',
          ...lastCapturedSession,
          final_url: page.url()
        };
      }
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
  } catch (error) {
    const details = serializeError(error);
    pushTraceEvent(trace, 'exception', {
      attempt,
      stage,
      error: details,
      final_url: lastUrl,
      page_state: lastPageState
    });
    throw Object.assign(new Error(details.message || 'login_failed'), {
      stage,
      final_url: lastUrl,
      browser_ws_endpoint_host: browserWSEndpoint ? new URL(browserWSEndpoint).host : '',
      page_state: lastPageState,
      console_messages: consoleMessages,
      original_error: details
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'weezevent-session-gateway',
    start_url: DEFAULT_START_URL
  });
});

app.get('/debug/last-attempt', requireSharedSecret, (_req, res) => {
  res.json({
    ok: true,
    attempts: DEBUG_ATTEMPT_HISTORY.slice(0, 5)
  });
});

app.post('/weezevent/session-token', requireSharedSecret, async (req, res) => {
  const email = req.body?.email || process.env.WEEZEVENT_EMAIL || '';
  const password = req.body?.password || process.env.WEEZEVENT_PASSWORD || '';
  const startUrl = req.body?.start_url || DEFAULT_START_URL;
  const timeoutMs = Number(req.body?.timeout_ms || DEFAULT_TIMEOUT_MS);
  const trace = createAttemptTrace('/weezevent/session-token', {
    start_url: startUrl,
    timeout_ms: timeoutMs,
    browserless_host: (() => {
      try {
        return new URL(buildBrowserWSEndpoint(timeoutMs)).host;
      } catch {
        return '';
      }
    })()
  });

  if (!email || !password) {
    pushTraceEvent(trace, 'request_rejected', { reason: 'missing_credentials' });
    storeTrace(trace);
    return res.status(400).json({ ok: false, error: 'missing_credentials' });
  }

  try {
    let result = null;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        pushTraceEvent(trace, 'attempt_start', { attempt: attempt + 1 });
        result = await loginAndExtractToken({ email, password, startUrl, timeoutMs, trace, attempt: attempt + 1 });
        pushTraceEvent(trace, 'attempt_result', { attempt: attempt + 1, result });
        if (result.ok || result.error !== 'session_not_found_before_timeout') {
          break;
        }
      } catch (error) {
        lastError = error;
        pushTraceEvent(trace, 'attempt_error', {
          attempt: attempt + 1,
          error: serializeError(error)
        });
        if (!isRetryableGatewayError(error) || attempt === 1) {
          throw error;
        }
        continue;
      }
    }

    if (!result && lastError) {
      throw lastError;
    }

    trace.finished_at = new Date().toISOString();
    trace.outcome = result.ok ? 'success' : 'conflict';
    storeTrace(trace);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    const details = serializeError(error);
    trace.finished_at = new Date().toISOString();
    trace.outcome = 'error';
    pushTraceEvent(trace, 'request_error', { error: details });
    storeTrace(trace);
    console.error('weezevent/session-token failed', JSON.stringify(details));
    return res.status(500).json({
      ok: false,
      error: 'gateway_failure',
      message: details.message || String(error),
      details
    });
  }
});

const port = Number(process.env.PORT || 3000);
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AVB Weezevent Gateway</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: linear-gradient(135deg, #dbeafe, #f8fafc 55%, #e5e7eb);
        color: #111827;
      }
      main {
        max-width: 720px;
        margin: 48px auto;
        padding: 32px;
        background: rgba(255, 255, 255, 0.88);
        border: 1px solid #d1d5db;
        border-radius: 20px;
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.08);
      }
      h1 { margin-top: 0; font-size: 2rem; }
      code {
        padding: 0.15rem 0.4rem;
        border-radius: 6px;
        background: #e5e7eb;
      }
      ul { padding-left: 1.2rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>AVB Weezevent Gateway</h1>
      <p>This Space hosts the HTTP gateway used by Apps Script to retrieve a Weezevent session token through an external Browserless service.</p>
      <ul>
        <li>Health check: <code>GET /healthz</code></li>
        <li>Token endpoint: <code>POST /weezevent/session-token</code></li>
      </ul>
    </main>
  </body>
</html>`);
});
app.listen(port, () => {
  console.log(`weezevent-session-gateway listening on :${port}`);
});
