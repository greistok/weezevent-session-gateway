# Weezevent Session Gateway

Petit service HTTP destine a etre appele par `Apps Script` pour obtenir un token de session `Weezevent` depuis un vrai navigateur.

## But

`Apps Script` sait faire du HTTP, mais pas un vrai login navigateur avec:

- redirections OIDC
- formulaire HTML dynamique
- CSRF
- stockage de session dans `sessionStorage`

Ce service corrige ce point:

1. il ouvre Chromium
2. il se connecte a `Weezevent`
3. il lit `sessionStorage` (`oidc.user:*`)
4. il renvoie le `access_token`

## Endpoint

`POST /weezevent/session-token`

Headers:

- `Authorization: Bearer <SERVICE_SHARED_SECRET>`

Body JSON minimal:

```json
{
  "email": "estivalesdevolley.avb@gmail.com",
  "password": "...."
}
```

Body JSON complet possible:

```json
{
  "email": "estivalesdevolley.avb@gmail.com",
  "password": "....",
  "start_url": "https://admin.weezevent.com/ticket/O1145913/events",
  "timeout_ms": 45000
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

## Variables d'environnement

- `SERVICE_SHARED_SECRET`
- `WEEZEVENT_EMAIL`
- `WEEZEVENT_PASSWORD`
- `WEEZEVENT_START_URL`
- `WEEZEVENT_TIMEOUT_MS`
- `PUPPETEER_EXECUTABLE_PATH`

## Docker

Le conteneur est construit sur `ghcr.io/browserless/chromium:latest`.

Build local:

```bash
docker build -t weezevent-session-gateway .
```

Run local:

```bash
docker run --rm -p 3000:3000 \
  -e SERVICE_SHARED_SECRET=change-me \
  -e WEEZEVENT_EMAIL=estivalesdevolley.avb@gmail.com \
  -e WEEZEVENT_PASSWORD='...' \
  weezevent-session-gateway
```

Test:

```bash
curl -X POST http://localhost:3000/weezevent/session-token \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer change-me' \
  -d '{"email":"estivalesdevolley.avb@gmail.com","password":"..."}'
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
- Si ce service renvoie `two_factor_required` ou `captcha_or_bot_check`, il faut traiter le probleme comme un blocage navigateur, pas comme un simple bug HTTP.
