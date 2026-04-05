# Weezevent Session Gateway

Service HTTP destine a etre appele par `Apps Script` pour obtenir un token de session `Weezevent` depuis un vrai navigateur.

## Architecture retenue

Le service ne lance plus Chromium localement dans son propre conteneur.

Le flux final est:

1. `Apps Script` appelle le gateway HTTP
2. le gateway se connecte en websocket a `Browserless`
3. `Browserless` heberge la session Chromium reelle
4. le gateway pilote la connexion `Weezevent`
5. il lit `sessionStorage` (`oidc.user:*`)
6. il renvoie le `access_token`

Services Render retenus:

- Browserless:
  - nom: `browserless-poc-render`
  - service id: `srv-d7925j5m5p6s739qt1n0`
  - URL: `https://browserless-poc-render.onrender.com`
- Gateway:
  - nom: `weezevent-session-gateway-render`
  - service id: `srv-d792qi1r0fns73e8mirg`
  - URL: `https://weezevent-session-gateway-render.onrender.com`

Verification reelle validee le `2026-04-05`:

- `POST /weezevent/session-token` retourne `HTTP 200`
- le JSON contient:
  - `ok: true`
  - `source: fresh_login`
  - `storage: sessionStorage`
  - `storage_key: oidc.user:...`
  - `access_token`
  - `expires_at`
  - `final_url: https://admin.weezevent.com/ticket/O1145913/events`

## Endpoint

`POST /weezevent/session-token`

Headers:

- `Authorization: Bearer <SERVICE_SHARED_SECRET>`

Body JSON minimal:

```json
{
  "timeout_ms": 240000
}
```

Body JSON complet possible:

```json
{
  "start_url": "https://admin.weezevent.com/ticket/O1145913/events",
  "timeout_ms": 240000
}
```

Reponse OK:

```json
{
  "ok": true,
  "source": "fresh_login",
  "storage": "sessionStorage",
  "storage_key": "oidc.user:https://accounts.weezevent.com:...",
  "access_token": "...",
  "expires_at": 1775379111,
  "token_type": "bearer",
  "scope": "openid",
  "has_refresh_token": true,
  "final_url": "https://admin.weezevent.com/ticket/O1145913/events"
}
```

Reponses de blocage typiques:

- `two_factor_required`
- `captcha_or_bot_check`
- `session_not_found_before_timeout`

En cas de `500 gateway_failure`, la reponse JSON inclut maintenant des diagnostics exploitables:

- `details.stage`
- `details.final_url`
- `details.page_state`
- `details.console_messages`
- `details.original_error`

Le but est d'eviter les erreurs opaques du type `[object Object]` et d'identifier rapidement si l'echec vient:

- du login `Weezevent`
- d'une redirection OIDC
- d'un `detached Frame`
- d'un blocage navigateur/captcha/2FA

## Variables d'environnement

- `SERVICE_SHARED_SECRET`
- `WEEZEVENT_EMAIL`
- `WEEZEVENT_PASSWORD`
- `WEEZEVENT_START_URL`
- `WEEZEVENT_TIMEOUT_MS`
- `BROWSERLESS_URL`
- `BROWSERLESS_TOKEN`

## Docker

Le conteneur du gateway est construit sur `node:20-bookworm-slim`.

Il ne contient pas Chromium.

Il suppose un Browserless externe joignable.

Build local:

```bash
docker build -t weezevent-session-gateway .
```

Run local:

```bash
docker run --rm -p 3000:3000 \
  -e SERVICE_SHARED_SECRET=change-me \
  -e BROWSERLESS_URL=https://browserless-poc-render.onrender.com \
  -e BROWSERLESS_TOKEN=change-me-too \
  -e WEEZEVENT_EMAIL=estivalesdevolley.avb@gmail.com \
  -e WEEZEVENT_PASSWORD='...' \
  weezevent-session-gateway
```

Test:

```bash
curl -X POST http://localhost:3000/weezevent/session-token \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer change-me' \
  -d '{"timeout_ms":240000}'
```

## Exemple Apps Script

```javascript
function fetchWeezeventSessionToken_() {
  var props = PropertiesService.getScriptProperties();
  var gatewayUrl = props.getProperty('WEEZEVENT_GATEWAY_URL');
  var gatewaySecret = props.getProperty('WEEZEVENT_GATEWAY_SECRET');
  var email = props.getProperty('WEEZEVENT_EMAIL');
  var password = props.getProperty('WEEZEVENT_PASSWORD');

  var response = UrlFetchApp.fetch(gatewayUrl + '/weezevent/session-token', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + gatewaySecret
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      email: email,
      password: password
    })
  });

  var json = JSON.parse(response.getContentText());
  if (!json.ok || !json.access_token) {
    throw new Error('Gateway Weezevent KO: ' + response.getResponseCode() + ' ' + response.getContentText());
  }

  props.setProperty('WEEZEVENT_SESSION_TOKEN', json.access_token);
  props.setProperty('WEEZEVENT_SESSION_EXPIRES_AT', String(json.expires_at || ''));
  return json;
}
```

## Note de doctrine

- `Apps Script` doit appeler ce service HTTP.
- `Apps Script` ne doit pas tenter en priorite de parser lui-meme le login HTML `Weezevent`.
- le gateway doit etre considere comme l'orchestrateur de login
- le service Browserless brut doit etre considere comme une dependance technique du gateway, pas comme l'interface que `Apps Script` appelle directement
- Si ce service renvoie `two_factor_required` ou `captcha_or_bot_check`, il faut traiter le probleme comme un blocage navigateur, pas comme un simple bug HTTP.
