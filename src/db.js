const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CHECKLIST_TEMPLATES } = require('./templates');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'byggkon-uk.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
try {
  db.pragma('journal_mode = WAL');
} catch {
  // Enkelte filsystemer (nettverksmonteringer) støtter ikke WAL.
  db.pragma('journal_mode = DELETE');
}
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'kontrollor',
  api_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_no TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  gnr_bnr TEXT DEFAULT '',
  kommune TEXT DEFAULT '',
  tiltaksklasse TEXT DEFAULT '2',
  tiltakshaver TEXT DEFAULT '',
  ansvarlig_soker TEXT DEFAULT '',
  kontrollomrader TEXT NOT NULL DEFAULT '[]',
  stage INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Aktiv',
  notes TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  omrade TEXT NOT NULL,
  fase TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Ikke kontrollert',
  comment TEXT DEFAULT '',
  checked_by TEXT DEFAULT '',
  checked_at TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS avvik (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  nummer INTEGER NOT NULL,
  omrade TEXT DEFAULT '',
  beskrivelse TEXT NOT NULL,
  alvorlighet TEXT DEFAULT 'Middels',
  status TEXT NOT NULL DEFAULT 'Åpent',
  checkpoint_id INTEGER,
  varslet_foretak_dato TEXT DEFAULT '',
  varslet_kommune_dato TEXT DEFAULT '',
  lukket_dato TEXT DEFAULT '',
  lukket_dokumentasjon TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  navn TEXT NOT NULL,
  type TEXT DEFAULT '',
  mottatt_fra TEXT DEFAULT '',
  mottatt_dato TEXT DEFAULT '',
  kommentar TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '{}',
  created_by TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, type)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  actor TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrering: passordkolonne for lokal innlogging
try {
  db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT ''");
} catch {
  /* kolonnen finnes allerede */
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function setPassword(userId, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
}

function verifyPassword(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
  if (!user || !user.password_hash) return null;
  const [salt, stored] = user.password_hash.split(':');
  const hash = crypto.scryptSync(password, salt, 64);
  const ok = crypto.timingSafeEqual(hash, Buffer.from(stored, 'hex'));
  return ok ? user : null;
}

function newApiKey() {
  return 'bk_' + crypto.randomBytes(24).toString('hex');
}

function getOrCreateUser(email, name) {
  email = String(email).toLowerCase().trim();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const role = count === 0 ? 'admin' : 'kontrollor';
    const info = db
      .prepare('INSERT INTO users (email, name, role, api_key) VALUES (?, ?, ?, ?)')
      .run(email, name || email, role, newApiKey());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  return user;
}

function userByApiKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM users WHERE api_key = ?').get(key) || null;
}

function regenerateApiKey(userId) {
  const key = newApiKey();
  db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(key, userId);
  return key;
}

function log(projectId, actor, source, action, detail) {
  db.prepare(
    'INSERT INTO activity (project_id, actor, source, action, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, actor, source, action, detail || '');
}

function createProject(data, actor, source) {
  const omrader = Array.isArray(data.kontrollomrader) ? data.kontrollomrader : [];
  const info = db
    .prepare(
      `INSERT INTO projects (project_no, name, address, gnr_bnr, kommune, tiltaksklasse,
        tiltakshaver, ansvarlig_soker, kontrollomrader, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.project_no || '',
      data.name,
      data.address || '',
      data.gnr_bnr || '',
      data.kommune || '',
      data.tiltaksklasse || '2',
      data.tiltakshaver || '',
      data.ansvarlig_soker || '',
      JSON.stringify(omrader),
      data.notes || '',
      data.created_by || null
    );
  const projectId = info.lastInsertRowid;

  // Opprett sjekkpunkter fra maler for valgte kontrollområder
  const ins = db.prepare(
    'INSERT INTO checkpoints (project_id, omrade, fase, text, sort) VALUES (?, ?, ?, ?, ?)'
  );
  let sort = 0;
  for (const omrade of omrader) {
    const tpl = CHECKLIST_TEMPLATES[omrade];
    if (!tpl) continue;
    for (const fase of ['Prosjektering', 'Utførelse']) {
      for (const text of tpl[fase] || []) {
        ins.run(projectId, omrade, fase, text, sort++);
      }
    }
  }
  log(projectId, actor, source, 'Prosjekt opprettet', `${data.project_no} ${data.name}`);
  return getProject(projectId);
}

function getProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) return null;
  p.kontrollomrader = JSON.parse(p.kontrollomrader || '[]');
  p.checkpoints = db
    .prepare('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY omrade, fase DESC, sort')
    .all(id);
  p.avvik = db.prepare('SELECT * FROM avvik WHERE project_id = ? ORDER BY nummer').all(id);
  p.documents = db
    .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY id DESC')
    .all(id);
  p.reports = db
    .prepare('SELECT type, updated_at, created_by FROM reports WHERE project_id = ?')
    .all(id);
  return p;
}

function listProjects(status) {
  let rows;
  if (status) {
    rows = db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY id DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM projects ORDER BY id DESC').all();
  }
  return rows.map((p) => {
    p.kontrollomrader = JSON.parse(p.kontrollomrader || '[]');
    const stats = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM checkpoints WHERE project_id = @id) AS punkter,
          (SELECT COUNT(*) FROM checkpoints WHERE project_id = @id AND status != 'Ikke kontrollert') AS kontrollert,
          (SELECT COUNT(*) FROM avvik WHERE project_id = @id AND status != 'Lukket') AS apne_avvik`
      )
      .get({ id: p.id });
    return { ...p, ...stats };
  });
}

function nextAvvikNo(projectId) {
  const r = db.prepare('SELECT MAX(nummer) AS m FROM avvik WHERE project_id = ?').get(projectId);
  return (r.m || 0) + 1;
}

module.exports = {
  db,
  getOrCreateUser,
  userByApiKey,
  regenerateApiKey,
  setPassword,
  verifyPassword,
  log,
  createProject,
  getProject,
  listProjects,
  nextAvvikNo
};
