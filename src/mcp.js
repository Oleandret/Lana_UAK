// MCP-server (Streamable HTTP, stateless) som gir Claude verktøy for uavhengig kontroll.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const {
  db,
  log,
  createProject,
  getProject,
  listProjects,
  nextAvvikNo
} = require('./db');
const { tripletexConfigured, listProjects: listTripletexProjects, getProjectById } = require('./tripletex');
const {
  WORKFLOW_STAGES,
  KONTROLLOMRADER,
  CHECKPOINT_STATUSES,
  AVVIK_STATUSES,
  UK_VEILEDNING
} = require('./templates');

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});
const fail = (msg) => ({ content: [{ type: 'text', text: `FEIL: ${msg}` }], isError: true });

function buildServer(user) {
  const server = new McpServer({
    name: 'byggkon-uk',
    version: '1.0.0'
  });
  const actor = `${user.name} (via Claude)`;

  server.tool(
    'uk_veiledning',
    'Returnerer Bygg-Kons rutine og regelverkskrav for uavhengig kontroll (SAK10 § 14-7). Les denne først for å forstå arbeidsflyten.',
    {},
    async () => ok(UK_VEILEDNING)
  );

  server.tool(
    'list_projects',
    'Lister alle UK-prosjekter med fremdrift og antall åpne avvik. Filtrer eventuelt på status (Aktiv, Fullført, Arkivert).',
    { status: z.string().optional().describe('Aktiv | Fullført | Arkivert') },
    async ({ status }) => ok(listProjects(status))
  );

  server.tool(
    'get_project',
    'Henter komplett prosjekt: info, arbeidsflytsteg, alle sjekkpunkter, avvik, dokumentliste og rapportstatus.',
    { project_id: z.number().int().describe('Prosjektets ID') },
    async ({ project_id }) => {
      const p = getProject(project_id);
      if (!p) return fail(`Fant ikke prosjekt ${project_id}`);
      p.arbeidsflyt = WORKFLOW_STAGES.map((s) => ({
        ...s,
        status: s.nr < p.stage ? 'Fullført' : s.nr === p.stage ? 'Pågår' : 'Ikke startet'
      }));
      return ok(p);
    }
  );

  server.tool(
    'create_project',
    `Oppretter nytt UK-prosjekt. Sjekklister genereres automatisk fra Bygg-Kons maler for valgte kontrollområder. Gyldige kontrollområder: ${KONTROLLOMRADER.join(', ')}.`,
    {
      project_no: z.string().describe('Prosjektnummer, f.eks. 26 042'),
      name: z.string().describe('Prosjektnavn, f.eks. "NorSea AS, Cutting hall"'),
      kontrollomrader: z.array(z.enum(KONTROLLOMRADER)).min(1),
      tiltaksklasse: z.enum(['1', '2', '3']).default('2'),
      address: z.string().optional(),
      gnr_bnr: z.string().optional().describe('Gnr./Bnr.'),
      kommune: z.string().optional(),
      tiltakshaver: z.string().optional(),
      ansvarlig_soker: z.string().optional().describe('Ansvarlig søker (foretak og kontaktperson)'),
      notes: z.string().optional()
    },
    async (args) => {
      const p = createProject({ ...args, created_by: user.id }, actor, 'claude');
      return ok({ melding: 'Prosjekt opprettet med sjekklister fra maler.', prosjekt: p });
    }
  );

  server.tool(
    'set_stage',
    `Setter arbeidsflytsteg (1–6) for et prosjekt. Steg: ${WORKFLOW_STAGES.map((s) => `${s.nr}=${s.navn}`).join(', ')}. Steg 6 krever at kommunen er varslet om eventuelle åpne avvik.`,
    {
      project_id: z.number().int(),
      stage: z.number().int().min(1).max(6)
    },
    async ({ project_id, stage }) => {
      const p = getProject(project_id);
      if (!p) return fail(`Fant ikke prosjekt ${project_id}`);
      if (stage === 6) {
        const blocking = p.avvik.filter((a) => a.status === 'Åpent' || a.status === 'Varslet foretak');
        if (blocking.length > 0) {
          return fail(
            `Kan ikke gå til steg 6: ${blocking.length} avvik er verken lukket eller varslet kommunen (avvik nr. ${blocking
              .map((a) => a.nummer)
              .join(', ')}). Lukk avvikene eller registrer varsling av kommunen først.`
          );
        }
      }
      db.prepare('UPDATE projects SET stage = ? WHERE id = ?').run(stage, project_id);
      log(project_id, actor, 'claude', 'Steg endret', `Steg ${stage}: ${WORKFLOW_STAGES[stage - 1].navn}`);
      return ok({ melding: `Prosjektet er nå i steg ${stage}: ${WORKFLOW_STAGES[stage - 1].navn}` });
    }
  );

  server.tool(
    'update_checkpoint',
    `Oppdaterer status/kommentar på et sjekkpunkt. Statuser: ${CHECKPOINT_STATUSES.join(', ')}. Settes status til "Avvik", bør det også opprettes et avvik med create_avvik.`,
    {
      checkpoint_id: z.number().int(),
      status: z.enum(CHECKPOINT_STATUSES),
      comment: z.string().optional().describe('Kontrollkommentar / henvisning til dokumentasjon')
    },
    async ({ checkpoint_id, status, comment }) => {
      const cp = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpoint_id);
      if (!cp) return fail(`Fant ikke sjekkpunkt ${checkpoint_id}`);
      db.prepare(
        `UPDATE checkpoints SET status = ?, comment = COALESCE(?, comment),
         checked_by = ?, checked_at = datetime('now') WHERE id = ?`
      ).run(status, comment ?? null, actor, checkpoint_id);
      log(cp.project_id, actor, 'claude', 'Sjekkpunkt oppdatert', `[${status}] ${cp.text}`);
      return ok({ melding: `Sjekkpunkt ${checkpoint_id} satt til "${status}".` });
    }
  );

  server.tool(
    'add_checkpoint',
    'Legger til et prosjektspesifikt sjekkpunkt utover standardmalene.',
    {
      project_id: z.number().int(),
      omrade: z.string().describe('Kontrollområde'),
      fase: z.enum(['Prosjektering', 'Utførelse']),
      text: z.string().describe('Hva som skal kontrolleres')
    },
    async ({ project_id, omrade, fase, text }) => {
      if (!getProject(project_id)) return fail(`Fant ikke prosjekt ${project_id}`);
      const info = db
        .prepare(
          'INSERT INTO checkpoints (project_id, omrade, fase, text, sort) VALUES (?, ?, ?, ?, 999)'
        )
        .run(project_id, omrade, fase, text);
      log(project_id, actor, 'claude', 'Sjekkpunkt lagt til', text);
      return ok({ melding: 'Sjekkpunkt opprettet.', checkpoint_id: info.lastInsertRowid });
    }
  );

  server.tool(
    'create_avvik',
    'Registrerer et avvik. Avvik skal varsles foretaket/ansvarlig søker, og kommunen skal varsles om åpne avvik før sluttrapport.',
    {
      project_id: z.number().int(),
      beskrivelse: z.string(),
      omrade: z.string().optional(),
      alvorlighet: z.enum(['Lav', 'Middels', 'Høy']).default('Middels'),
      checkpoint_id: z.number().int().optional().describe('Sjekkpunktet avviket gjelder')
    },
    async ({ project_id, beskrivelse, omrade, alvorlighet, checkpoint_id }) => {
      if (!getProject(project_id)) return fail(`Fant ikke prosjekt ${project_id}`);
      const nummer = nextAvvikNo(project_id);
      const info = db
        .prepare(
          `INSERT INTO avvik (project_id, nummer, omrade, beskrivelse, alvorlighet, checkpoint_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(project_id, nummer, omrade || '', beskrivelse, alvorlighet, checkpoint_id || null);
      log(project_id, actor, 'claude', 'Avvik registrert', `Avvik ${nummer}: ${beskrivelse}`);
      return ok({ melding: `Avvik nr. ${nummer} registrert.`, avvik_id: info.lastInsertRowid });
    }
  );

  server.tool(
    'update_avvik',
    `Oppdaterer avviksstatus. Statuser: ${AVVIK_STATUSES.join(', ')}. Ved "Lukket" bør dokumentasjon på lukking oppgis.`,
    {
      avvik_id: z.number().int(),
      status: z.enum(AVVIK_STATUSES),
      dato: z.string().optional().describe('Dato (ÅÅÅÅ-MM-DD) for hendelsen, standard i dag'),
      lukket_dokumentasjon: z.string().optional().describe('Dokumentasjon på at avviket er lukket')
    },
    async ({ avvik_id, status, dato, lukket_dokumentasjon }) => {
      const a = db.prepare('SELECT * FROM avvik WHERE id = ?').get(avvik_id);
      if (!a) return fail(`Fant ikke avvik ${avvik_id}`);
      const d = dato || new Date().toISOString().slice(0, 10);
      const fields = { status };
      if (status === 'Varslet foretak') fields.varslet_foretak_dato = d;
      if (status === 'Varslet kommune') fields.varslet_kommune_dato = d;
      if (status === 'Lukket') {
        fields.lukket_dato = d;
        if (lukket_dokumentasjon) fields.lukket_dokumentasjon = lukket_dokumentasjon;
      }
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE avvik SET ${sets} WHERE id = ?`).run(...Object.values(fields), avvik_id);
      log(a.project_id, actor, 'claude', 'Avvik oppdatert', `Avvik ${a.nummer} → ${status}`);
      return ok({ melding: `Avvik nr. ${a.nummer} satt til "${status}".` });
    }
  );

  server.tool(
    'register_document',
    'Registrerer mottatt dokumentasjon (tegninger, beregninger, KS-dokumentasjon, rapporter) i prosjektets dokumentlogg.',
    {
      project_id: z.number().int(),
      navn: z.string(),
      type: z.string().optional().describe('F.eks. Tegning, Beregning, KS-dokumentasjon, Rapport'),
      mottatt_fra: z.string().optional(),
      mottatt_dato: z.string().optional().describe('ÅÅÅÅ-MM-DD'),
      kommentar: z.string().optional()
    },
    async ({ project_id, navn, type, mottatt_fra, mottatt_dato, kommentar }) => {
      if (!getProject(project_id)) return fail(`Fant ikke prosjekt ${project_id}`);
      db.prepare(
        `INSERT INTO documents (project_id, navn, type, mottatt_fra, mottatt_dato, kommentar)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        project_id,
        navn,
        type || '',
        mottatt_fra || '',
        mottatt_dato || new Date().toISOString().slice(0, 10),
        kommentar || ''
      );
      log(project_id, actor, 'claude', 'Dokument registrert', navn);
      return ok({ melding: `Dokument "${navn}" registrert.` });
    }
  );

  server.tool(
    'get_report_data',
    'Henter alt datagrunnlag for å skrive kontrollerklæring/sluttrapport: prosjektinfo, kontrollstatus per område, avvikslogg og dokumentliste. Bruk dette til å utarbeide rapporttekst, og lagre teksten med save_report.',
    { project_id: z.number().int() },
    async ({ project_id }) => {
      const p = getProject(project_id);
      if (!p) return fail(`Fant ikke prosjekt ${project_id}`);
      const perOmrade = {};
      for (const o of p.kontrollomrader) {
        const cps = p.checkpoints.filter((c) => c.omrade === o);
        perOmrade[o] = {
          totalt: cps.length,
          ok: cps.filter((c) => c.status === 'OK').length,
          avvik: cps.filter((c) => c.status === 'Avvik').length,
          ikke_relevant: cps.filter((c) => c.status === 'Ikke relevant').length,
          ikke_kontrollert: cps.filter((c) => c.status === 'Ikke kontrollert').length,
          punkter: cps.map((c) => ({ id: c.id, fase: c.fase, text: c.text, status: c.status, kommentar: c.comment }))
        };
      }
      return ok({
        prosjekt: {
          id: p.id, project_no: p.project_no, name: p.name, address: p.address,
          gnr_bnr: p.gnr_bnr, kommune: p.kommune, tiltaksklasse: p.tiltaksklasse,
          tiltakshaver: p.tiltakshaver, ansvarlig_soker: p.ansvarlig_soker, stage: p.stage
        },
        kontroll_per_omrade: perOmrade,
        avvik: p.avvik,
        dokumenter: p.documents,
        krav: 'Husk: kommunen skal være varslet om åpne avvik før sluttrapport ferdigstilles. ' +
          'Rapporttyper for save_report: "kontrollerklaering", "sluttrapport", "kontrollplan".'
      });
    }
  );

  server.tool(
    'save_report',
    'Lagrer rapporttekst (seksjoner) for et prosjekt. Rapporten kan deretter åpnes og skrives ut fra nettsiden. Typer: kontrollerklaering, sluttrapport, kontrollplan.',
    {
      project_id: z.number().int(),
      type: z.enum(['kontrollerklaering', 'sluttrapport', 'kontrollplan']),
      sections: z
        .record(z.string())
        .describe(
          'Nøkkel→tekst. Anbefalte seksjoner: sammendrag, kontrollomfang, gjennomforing, avvik_oppsummering, konklusjon. Ren tekst eller enkel HTML (<p>, <ul>).'
        )
    },
    async ({ project_id, type, sections }) => {
      if (!getProject(project_id)) return fail(`Fant ikke prosjekt ${project_id}`);
      db.prepare(
        `INSERT INTO reports (project_id, type, sections, created_by, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, type) DO UPDATE SET sections = excluded.sections,
           created_by = excluded.created_by, updated_at = datetime('now')`
      ).run(project_id, type, JSON.stringify(sections), actor);
      log(project_id, actor, 'claude', 'Rapport lagret', type);
      return ok({
        melding: `Rapport "${type}" lagret. Åpne /projects/${project_id}/rapport/${type} på nettsiden for utskrift/PDF.`
      });
    }
  );

  server.tool(
    'tripletex_list_projects',
    'Lister åpne prosjekter fra Tripletex (regnskaps-/prosjektsystemet til Bygg-Kon). Bruk dette for å finne prosjekter som skal importeres til UK-systemet.',
    { query: z.string().optional().describe('Fritekstsøk på prosjektnr., navn eller kunde') },
    async ({ query }) => {
      if (!tripletexConfigured) return fail('Tripletex er ikke konfigurert på serveren.');
      try {
        return ok(await listTripletexProjects(query));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.tool(
    'tripletex_import_project',
    `Importerer et Tripletex-prosjekt som nytt UK-prosjekt. Prosjektnr., navn, adresse og tiltakshaver hentes fra Tripletex; sjekklister genereres fra maler. Gyldige kontrollområder: ${KONTROLLOMRADER.join(', ')}.`,
    {
      tripletex_id: z.number().int().describe('ID fra tripletex_list_projects'),
      kontrollomrader: z.array(z.enum(KONTROLLOMRADER)).min(1),
      tiltaksklasse: z.enum(['1', '2', '3']).default('2'),
      gnr_bnr: z.string().optional(),
      kommune: z.string().optional(),
      ansvarlig_soker: z.string().optional(),
      notes: z.string().optional()
    },
    async (args) => {
      if (!tripletexConfigured) return fail('Tripletex er ikke konfigurert på serveren.');
      try {
        const tt = await getProjectById(args.tripletex_id);
        if (!tt) return fail(`Fant ikke Tripletex-prosjekt ${args.tripletex_id}`);
        const eksisterende = db
          .prepare('SELECT id FROM projects WHERE tripletex_id = ?')
          .get(args.tripletex_id);
        if (eksisterende) {
          return fail(`Tripletex-prosjektet er allerede importert som prosjekt ${eksisterende.id}.`);
        }
        const p = createProject(
          {
            project_no: tt.number,
            name: tt.name,
            address: tt.address,
            tiltakshaver: tt.customer,
            tripletex_id: tt.tripletex_id,
            kontrollomrader: args.kontrollomrader,
            tiltaksklasse: args.tiltaksklasse,
            gnr_bnr: args.gnr_bnr,
            kommune: args.kommune,
            ansvarlig_soker: args.ansvarlig_soker,
            notes: args.notes,
            created_by: user.id
          },
          actor,
          'claude'
        );
        return ok({ melding: 'Prosjekt importert fra Tripletex med sjekklister fra maler.', prosjekt: p });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.tool(
    'get_activity',
    'Henter aktivitetslogg for et prosjekt (hvem gjorde hva, fra web eller Claude).',
    { project_id: z.number().int(), limit: z.number().int().max(200).default(50) },
    async ({ project_id, limit }) => {
      const rows = db
        .prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?')
        .all(project_id, limit);
      return ok(rows);
    }
  );

  return server;
}

// Stateless: ny server + transport per forespørsel.
function mcpHandler() {
  return async (req, res) => {
    try {
      const server = buildServer(req.user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP-feil:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Intern feil i MCP-server' },
          id: null
        });
      }
    }
  };
}

module.exports = { mcpHandler };
