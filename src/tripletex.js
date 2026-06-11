// Tripletex-integrasjon: henter prosjekter via Tripletex API for import til UK-systemet.
// Konfigureres med TRIPLETEX_CONSUMER_TOKEN og TRIPLETEX_EMPLOYEE_TOKEN.

const BASE = (process.env.TRIPLETEX_BASE || 'https://tripletex.no/v2').replace(/\/$/, '');
const CONSUMER_TOKEN = process.env.TRIPLETEX_CONSUMER_TOKEN || '';
const EMPLOYEE_TOKEN = process.env.TRIPLETEX_EMPLOYEE_TOKEN || '';

const tripletexConfigured = Boolean(CONSUMER_TOKEN && EMPLOYEE_TOKEN);

let session = { token: null, expiresAt: 0 };

async function getSessionToken() {
  if (session.token && Date.now() < session.expiresAt - 60_000) return session.token;
  const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url =
    `${BASE}/token/session/:create?consumerToken=${encodeURIComponent(CONSUMER_TOKEN)}` +
    `&employeeToken=${encodeURIComponent(EMPLOYEE_TOKEN)}&expirationDate=${expirationDate}`;
  const r = await fetch(url, { method: 'PUT' });
  if (!r.ok) {
    throw new Error(`Tripletex: klarte ikke å opprette sesjon (HTTP ${r.status}). Sjekk tokens.`);
  }
  const data = await r.json();
  session = {
    token: data.value.token,
    expiresAt: new Date(data.value.expirationDate + 'T23:59:59').getTime()
  };
  return session.token;
}

async function api(path) {
  const token = await getSessionToken();
  const auth = Buffer.from(`0:${token}`).toString('base64');
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Tripletex API-feil (HTTP ${r.status}): ${body.slice(0, 200)}`);
  }
  return r.json();
}

// Liste over åpne prosjekter, eventuelt filtrert på fritekst (nummer/navn/kunde).
async function listProjects(query) {
  const fields =
    'id,number,name,displayName,description,' +
    'customer(name),deliveryAddress(addressLine1,postalCode,city)';
  const data = await api(`/project?isClosed=false&count=1000&fields=${encodeURIComponent(fields)}`);
  let projects = (data.values || []).map((p) => ({
    tripletex_id: p.id,
    number: p.number || '',
    name: p.name || p.displayName || '',
    customer: p.customer ? p.customer.name : '',
    address: p.deliveryAddress
      ? [p.deliveryAddress.addressLine1, p.deliveryAddress.postalCode, p.deliveryAddress.city]
          .filter(Boolean)
          .join(', ')
      : '',
    description: p.description || ''
  }));
  if (query) {
    const q = String(query).toLowerCase();
    projects = projects.filter(
      (p) =>
        p.number.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.customer.toLowerCase().includes(q)
    );
  }
  return projects;
}

async function getProjectById(tripletexId) {
  const all = await listProjects();
  return all.find((p) => p.tripletex_id === Number(tripletexId)) || null;
}

module.exports = { tripletexConfigured, listProjects, getProjectById };
