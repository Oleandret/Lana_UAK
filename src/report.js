// Bygger datamodell for utskriftsvennlige rapporter (kontrollerklæring, sluttrapport, kontrollplan).
const { db } = require('./db');

const REPORT_TITLES = {
  kontrollerklaering: 'Kontrollerklæring med sluttrapport',
  sluttrapport: 'Sluttrapport – uavhengig kontroll',
  kontrollplan: 'Plan for uavhengig kontroll'
};

const DEFAULT_SECTION_ORDER = [
  ['sammendrag', 'Sammendrag'],
  ['kontrollomfang', 'Kontrollomfang'],
  ['gjennomforing', 'Gjennomføring av kontrollen'],
  ['avvik_oppsummering', 'Avvik'],
  ['konklusjon', 'Konklusjon']
];

function buildReportModel(project, type) {
  const row = db
    .prepare('SELECT * FROM reports WHERE project_id = ? AND type = ?')
    .get(project.id, type);
  const sections = row ? JSON.parse(row.sections || '{}') : {};

  const orderedSections = [];
  for (const [key, title] of DEFAULT_SECTION_ORDER) {
    if (sections[key]) orderedSections.push({ key, title, text: sections[key] });
  }
  // Egne seksjoner utover standardrekkefølgen
  for (const key of Object.keys(sections)) {
    if (!DEFAULT_SECTION_ORDER.some(([k]) => k === key)) {
      orderedSections.push({ key, title: key.replace(/_/g, ' '), text: sections[key] });
    }
  }

  const perOmrade = project.kontrollomrader.map((omrade) => {
    const cps = project.checkpoints.filter((c) => c.omrade === omrade);
    return {
      omrade,
      punkter: cps,
      ok: cps.filter((c) => c.status === 'OK').length,
      avvik: cps.filter((c) => c.status === 'Avvik').length,
      ikkeKontrollert: cps.filter((c) => c.status === 'Ikke kontrollert').length,
      ikkeRelevant: cps.filter((c) => c.status === 'Ikke relevant').length
    };
  });

  const apneAvvik = project.avvik.filter((a) => a.status !== 'Lukket');

  return {
    title: REPORT_TITLES[type] || type,
    type,
    sections: orderedSections,
    updatedAt: row ? row.updated_at : null,
    createdBy: row ? row.created_by : null,
    perOmrade,
    apneAvvik
  };
}

module.exports = { buildReportModel, REPORT_TITLES };
