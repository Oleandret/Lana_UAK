const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const crypto = require('crypto');

const {
  db,
  log,
  createProject,
  getProject,
  listProjects,
  nextAvvikNo,
  regenerateApiKey,
  getOrCreateUser,
  setPassword,
  verifyPassword
} = require('./db');
const { setupAuthRoutes, requireAuth, requireApiKey, ssoConfigured } = require('./auth');
const { mcpHandler } = require('./mcp');
const { tripletexConfigured, listProjects: listTripletexProjects } = require('./tripletex');
const { buildReportModel, REPORT_TITLES } = require('./report');
const T = require('./templates');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// MCP-endepunkt – før sessions, autentiseres med API-nøkkel.
app.post('/mcp', requireApiKey, mcpHandler());
app.get('/mcp', requireApiKey, (req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bruk POST. SSE-strøm støttes ikke (stateless server).' },
    id: null
  })
);

app.use(
  cookieSession({
    name: 'bk_session',
    keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
    maxAge: 12 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

setupAuthRoutes(app);
const auth = requireAuth(db);

// ---------- Web-sider ----------

app.get('/', auth, (req, res) => {
  res.render('dashboard', {
    user: req.user,
    projects: listProjects(),
    T,
    tripletex: tripletexConfigured
  });
});

app.get('/projects/:id', auth, (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.status(404).send('Fant ikke prosjektet');
  const activity = db
    .prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 30')
    .all(p.id);
  res.render('project', { user: req.user, p, activity, T, REPORT_TITLES });
});

app.get('/projects/:id/rapport/:type', auth, (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.status(404).send('Fant ikke prosjektet');
  const type = req.params.type;
  if (!REPORT_TITLES[type]) return res.status(404).send('Ukjent rapporttype');
  res.render('report', { p, model: buildReportModel(p, type) });
});

app.get('/settings', auth, (req, res) => {
  const baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const users =
    req.user.role === 'admin'
      ? db.prepare("SELECT id, email, name, role, password_hash != '' AS has_password FROM users ORDER BY id").all()
      : [];
  res.render('settings', { user: req.user, baseUrl, ssoConfigured, users });
});

// ---------- JSON-API for nettsiden ----------

app.post('/api/projects', auth, (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Navn er påkrevd' });
  const omrader = Array.isArray(b.kontrollomrader)
    ? b.kontrollomrader
    : b.kontrollomrader
      ? [b.kontrollomrader]
      : [];
  const p = createProject(
    { ...b, kontrollomrader: omrader, created_by: req.user.id },
    req.user.name,
    'web'
  );
  res.json(p);
});

app.patch('/api/projects/:id', auth, (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Fant ikke prosjektet' });
  const { stage, status, notes } = req.body;
  if (stage !== undefined) {
    const s = Number(stage);
    if (s === 6) {
      const blocking = p.avvik.filter((a) => a.status === 'Åpent' || a.status === 'Varslet foretak');
      if (blocking.length > 0) {
        return res.status(400).json({
          error: `Kan ikke gå til steg 6: avvik nr. ${blocking.map((a) => a.nummer).join(', ')} er verken lukket eller varslet kommunen.`
        });
      }
    }
    db.prepare('UPDATE projects SET stage = ? WHERE id = ?').run(s, p.id);
    log(p.id, req.user.name, 'web', 'Steg endret', `Steg ${s}: ${T.WORKFLOW_STAGES[s - 1].navn}`);
  }
  if (status !== undefined) {
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, p.id);
    log(p.id, req.user.name, 'web', 'Status endret', status);
  }
  if (notes !== undefined) {
    db.prepare('UPDATE projects SET notes = ? WHERE id = ?').run(notes, p.id);
  }
  res.json(getProject(p.id));
});

app.patch('/api/checkpoints/:id', auth, (req, res) => {
  const cp = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(Number(req.params.id));
  if (!cp) return res.status(404).json({ error: 'Fant ikke sjekkpunktet' });
  const { status, comment } = req.body;
  db.prepare(
    `UPDATE checkpoints SET status = COALESCE(?, status), comment = COALESCE(?, comment),
     checked_by = ?, checked_at = datetime('now') WHERE id = ?`
  ).run(status ?? null, comment ?? null, req.user.name, cp.id);
  if (status) {
    log(cp.project_id, req.user.name, 'web', 'Sjekkpunkt oppdatert', `[${status}] ${cp.text}`);
  }
  res.json(db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(cp.id));
});

app.post('/api/projects/:id/checkpoints', auth, (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Fant ikke prosjektet' });
  const { omrade, fase, text } = req.body;
  if (!omrade || !fase || !text) return res.status(400).json({ error: 'omrade, fase og text er påkrevd' });
  const info = db
    .prepare('INSERT INTO checkpoints (project_id, omrade, fase, text, sort) VALUES (?, ?, ?, ?, 999)')
    .run(p.id, omrade, fase, text);
  log(p.id, req.user.name, 'web', 'Sjekkpunkt lagt til', text);
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/projects/:id/avvik', auth, (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Fant ikke prosjektet' });
  const { beskrivelse, omrade, alvorlighet, checkpoint_id } = req.body;
  if (!beskrivelse) return res.status(400).json({ error: 'Beskrivelse er påkrevd' });
  const nummer = nextAvvikNo(p.id);
  db.prepare(
    `INSERT INTO avvik (project_id, nummer, omrade, beskrivelse, alvorlighet, checkpoint_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(p.id, nummer, omrade || '', beskrivelse, alvorlighet || 'Middels', checkpoint_id || null);
  log(p.id, req.user.name, 'web', 'Avvik registrert', `Avvik ${nummer}: ${beskrivelse}`);
  res.json({ nummer });
});

app.patch('/api/avvik/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM avvik WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Fant ikke avviket' });
  const { status, lukket_dokumentasjon } = req.body;
  const d = new Date().toISOString().slice(0, 10);
  const fields = {};
  if (status) {
    fields.status = status;
    if (status === 'Varslet foretak') fields.varslet_foretak_dato = d;
    if (status === 'Varslet kommune') fields.varslet_kommune_dato = d;
    if (status === 'Lukket') fields.lukket_dato = d;
  }
  if (lukket_dokumentasjon !== undefined) fields.lukket_dokumentasjon = lukket_dokumentasjon;
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'Ingen felter å oppdatere' });
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE avvik SET ${sets} WHERE id = ?`).run(...Object.values(fields), a.id);
  if (status) log(a.project_id, req.user.name, 'web', 'Avvik oppdatert', `Avvik ${a.nummer} → ${status}`);
  res.json({ ok: true });
});

app.post('/api/projects/:id/documents', auth, (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Fant ikke prosjektet' });
  const { navn, type, mottatt_fra, mottatt_dato, kommentar } = req.body;
  if (!navn) return res.status(400).json({ error: 'Navn er påkrevd' });
  db.prepare(
    `INSERT INTO documents (project_id, navn, type, mottatt_fra, mottatt_dato, kommentar)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(p.id, navn, type || '', mottatt_fra || '', mottatt_dato || new Date().toISOString().slice(0, 10), kommentar || '');
  log(p.id, req.user.name, 'web', 'Dokument registrert', navn);
  res.json({ ok: true });
});

// ---------- Tripletex ----------

app.get('/api/tripletex/projects', auth, async (req, res) => {
  if (!tripletexConfigured) {
    return res.status(400).json({ error: 'Tripletex er ikke konfigurert (TRIPLETEX_CONSUMER_TOKEN / TRIPLETEX_EMPLOYEE_TOKEN).' });
  }
  try {
    res.json(await listTripletexProjects(req.query.q || ''));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- Brukeradministrasjon ----------

const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Krever admin-rolle' });

app.post('/api/users', auth, requireAdmin, (req, res) => {
  const { email, name, password, role } = req.body;
  if (!email || !email.includes('@') || !password || password.length < 8) {
    return res.status(400).json({ error: 'Gyldig e-post og passord (minst 8 tegn) er påkrevd.' });
  }
  const u = getOrCreateUser(email, name || email);
  setPassword(u.id, password);
  if (role === 'admin' || role === 'kontrollor') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  }
  log(null, req.user.name, 'web', 'Bruker opprettet/oppdatert', email);
  res.json({ ok: true, id: u.id });
});

app.post('/api/users/:id/password', auth, requireAdmin, (req, res) => {
  const { password } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'Fant ikke brukeren' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Passord må ha minst 8 tegn.' });
  setPassword(target.id, password);
  log(null, req.user.name, 'web', 'Passord tilbakestilt', target.email);
  res.json({ ok: true });
});

app.post('/api/me/password', auth, (req, res) => {
  const { current_password, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Passord må ha minst 8 tegn.' });
  if (req.user.password_hash && !verifyPassword(req.user.email, current_password || '')) {
    return res.status(400).json({ error: 'Feil nåværende passord.' });
  }
  setPassword(req.user.id, password);
  res.json({ ok: true });
});

app.post('/api/me/apikey', auth, (req, res) => {
  const key = regenerateApiKey(req.user.id);
  res.json({ api_key: key });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Det oppstod en feil. Prøv igjen.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Byggkon UK kjører på port ${PORT}`);
  console.log(`Innlogging: e-post/passord${ssoConfigured ? ' + Microsoft 365 SSO' : ''}${process.env.ADMIN_PASSWORD ? ' + admin-passord' : ''}`);
});
