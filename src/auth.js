// Autentisering: Microsoft 365 SSO (Entra ID / Azure AD) via OpenID Connect.
// Faller tilbake til enkel utvikler-innlogging hvis Azure-variabler ikke er satt.

const { Issuer, generators } = require('openid-client');
const { getOrCreateUser, userByApiKey } = require('./db');

const TENANT = process.env.AZURE_TENANT_ID || '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'byggkon.no')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const ssoConfigured = Boolean(TENANT && CLIENT_ID && CLIENT_SECRET);

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = Issuer.discover(
      `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`
    ).then(
      (issuer) =>
        new issuer.Client({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uris: [`${BASE_URL}/auth/callback`],
          response_types: ['code']
        })
    );
  }
  return clientPromise;
}

function emailAllowed(email) {
  if (ALLOWED_DOMAINS.length === 0) return true;
  const domain = String(email).toLowerCase().split('@')[1] || '';
  return ALLOWED_DOMAINS.includes(domain);
}

function setupAuthRoutes(app) {
  app.get('/login', async (req, res) => {
    if (req.session.userId) return res.redirect('/');
    if (!ssoConfigured) {
      return res.render('login', { sso: false, error: req.query.error || '' });
    }
    return res.render('login', { sso: true, error: req.query.error || '' });
  });

  app.get('/auth/microsoft', async (req, res, next) => {
    try {
      if (!ssoConfigured) return res.redirect('/login');
      const client = await getClient();
      const state = generators.state();
      const nonce = generators.nonce();
      req.session.oidc = { state, nonce };
      const url = client.authorizationUrl({
        scope: 'openid profile email',
        state,
        nonce
      });
      res.redirect(url);
    } catch (e) {
      next(e);
    }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      const client = await getClient();
      const params = client.callbackParams(req);
      const { state, nonce } = req.session.oidc || {};
      const tokenSet = await client.callback(`${BASE_URL}/auth/callback`, params, {
        state,
        nonce
      });
      const claims = tokenSet.claims();
      const email = (claims.email || claims.preferred_username || '').toLowerCase();
      const name = claims.name || email;
      delete req.session.oidc;
      if (!email || !emailAllowed(email)) {
        return res.redirect('/login?error=' + encodeURIComponent('Kontoen er ikke tillatt. Bruk Byggkon-konto.'));
      }
      const user = getOrCreateUser(email, name);
      req.session.userId = user.id;
      res.redirect('/');
    } catch (e) {
      next(e);
    }
  });

  // Utvikler-innlogging når SSO ikke er konfigurert (f.eks. lokal testing).
  app.post('/auth/dev', (req, res) => {
    if (ssoConfigured) return res.status(403).send('Dev-innlogging er deaktivert når SSO er konfigurert.');
    const email = (req.body.email || '').toLowerCase().trim();
    const name = (req.body.name || '').trim() || email;
    if (!email.includes('@')) return res.redirect('/login?error=Ugyldig e-post');
    const user = getOrCreateUser(email, name);
    req.session.userId = user.id;
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });
}

function requireAuth(db) {
  return (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
      req.session = null;
      return res.redirect('/login');
    }
    req.user = user;
    next();
  };
}

// Bearer API-nøkkel for MCP-endepunktet.
function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : req.query.key;
  const user = userByApiKey(key);
  if (!user) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Ugyldig eller manglende API-nøkkel. Bruk Authorization: Bearer <nøkkel>.' },
      id: null
    });
  }
  req.user = user;
  next();
}

module.exports = { setupAuthRoutes, requireAuth, requireApiKey, ssoConfigured };
