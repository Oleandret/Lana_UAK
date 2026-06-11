// Sjekklistemaler og arbeidsflyt for uavhengig kontroll (UK) hos Bygg-Kon AS.
// Basert på Bygg-Kons interne rutine (KS-perm), sjekkliste for uavhengig kontroll
// og SAK10 § 14-7 med veiledning.

const WORKFLOW_STAGES = [
  {
    nr: 1,
    navn: 'Oppdrag og ansvarsrett',
    beskrivelse:
      'Oppdrag mottatt. Erklæring om ansvarsrett sendes og kontrollomfanget avgrenses. ' +
      'Grensesnitt mot eventuelle andre kontrollforetak avklares med ansvarlig søker.'
  },
  {
    nr: 2,
    navn: 'Plan for uavhengig kontroll',
    beskrivelse:
      'Utarbeid plan for kontroll: kontrollområder, tiltaksklasse, omfang (innledende og gjentakende kontroll), ' +
      'tidspunkter og hvilke dokumenter som skal innhentes.'
  },
  {
    nr: 3,
    navn: 'Innhenting av dokumentasjon',
    beskrivelse:
      'Innhent dokumentasjon fra prosjekterende/utførende: KS-rutiner, tegninger, beregninger, rapporter ' +
      'og dokumentasjon på gjennomført kvalitetssikring.'
  },
  {
    nr: 4,
    navn: 'Gjennomføring av kontroll',
    beskrivelse:
      'Kontroller at KS-rutiner er fulgt og dokumentert, at prosjekteringen er tilstrekkelig, og foreta enkel ' +
      'kontroll av at utførelsen samsvarer med produksjonsunderlaget. Mest intensivt ved oppstart av nye ' +
      'arbeidsprosesser, før lukking av konstruksjoner og ved sluttkontroll.'
  },
  {
    nr: 5,
    navn: 'Avviksbehandling',
    beskrivelse:
      'Avvik varsles foretaket og ansvarlig søker. Påse at avvik lukkes. Kommunen skal varsles om åpne avvik ' +
      'før sluttrapport kan ferdigstilles.'
  },
  {
    nr: 6,
    navn: 'Sluttrapport og kontrollerklæring',
    beskrivelse:
      'Utarbeid kontrollerklæring med sluttrapport og plan for kontroll som viser hva som er kontrollert og ' +
      'status for avvik. Send sluttrapport til ansvarlig søker.'
  }
];

const KONTROLLOMRADER = [
  'Konstruksjonssikkerhet',
  'Geoteknikk',
  'Bygningsfysikk',
  'Brannsikkerhet',
  'Våtrom (tkl. 1)',
  'Lufttetthet (tkl. 1)'
];

// Maler: sjekkpunkter per kontrollområde, delt i fase Prosjektering / Utførelse.
const CHECKLIST_TEMPLATES = {
  Konstruksjonssikkerhet: {
    Prosjektering: [
      'Tegningsliste med angivelse av kritiske punkt foreligger',
      'KS-system og aktuelle prosedyrer er fulgt og dokumentert',
      'Beregningsforutsetninger: standarder, laster, verktøy og metodevalg',
      'Kontrolldokumentasjon fra prosjekterende foreligger',
      'Global likevekt: avstiving, skiver og fundamenter for disse',
      'Akkumulert overliggende last',
      'Kritiske punkt: enighet om de som er anvist og oppfølging mht. utførelse',
      'Pålitelighetsklasse iht. NS-EN 1990 + NA er korrekt fastsatt'
    ],
    Utførelse: [
      'Dokumentasjon for utførelse samt bruk av korrekt tegningsliste',
      'Hovedbæresystemet er utført som prosjektert',
      'Stikkprøver: materialer har forutsatte egenskaper (produktdokumentasjon)'
    ]
  },
  Geoteknikk: {
    Prosjektering: [
      'Geoteknisk rapport foreligger',
      'Kvalifisert undersøkelse for fastsettelse av geoteknisk kategori og pålitelighetsklasse'
    ],
    Utførelse: [
      'Dokumentasjon for utførelse i henhold til geoteknisk rapport',
      'Stikkprøver: prosjekteringens forutsetninger er representative for forholdene på byggeplassen',
      'Rapportering fra byggeplass skjer i henhold til geoteknisk kategori'
    ]
  },
  Bygningsfysikk: {
    Prosjektering: [
      'Vertikalsnitt som viser dampsperre, vindsperre og overganger',
      'Tegninger som viser oppbygging av terrasse, membran og tilslutninger',
      'Rapport for energieffektivitet foreligger'
    ],
    Utførelse: [
      'Dokumentasjon for utførelse samt bruk av korrekt tegningsliste',
      'Registrering fra utført fuktmåling i trematerialer før lukking av yttervegg',
      'Installert ventilasjonsaggregat har ytelser som forutsatt i energiberegningen'
    ]
  },
  Brannsikkerhet: {
    Prosjektering: [
      'Brannkonsept/brannstrategi foreligger og samsvarer med TEK17 kap. 11',
      'KS-rutiner for brannprosjektering er fulgt og dokumentert',
      'Grensesnitt mot øvrige fag (konstruksjon, VVS, el) er avklart og dokumentert',
      'Forutsetninger og ytelseskrav er videreført i detaljprosjekteringen'
    ],
    Utførelse: []
  },
  'Våtrom (tkl. 1)': {
    Prosjektering: [],
    Utførelse: [
      'Fuktsikring/membran utført iht. Byggebransjens våtromsnorm eller tilsvarende',
      'Sluk, gjennomføringer og tilslutninger er korrekt utført',
      'Dokumentasjon på utførende foretaks kvalitetssikring foreligger'
    ]
  },
  'Lufttetthet (tkl. 1)': {
    Prosjektering: [],
    Utførelse: [
      'Tetthetsmåling (trykkmetoden, NS-EN ISO 9972) er gjennomført',
      'Målt lekkasjetall samsvarer med forutsetning i energiberegningen',
      'Måleprotokoll foreligger'
    ]
  }
};

const CHECKPOINT_STATUSES = ['Ikke kontrollert', 'OK', 'Avvik', 'Ikke relevant'];
const AVVIK_STATUSES = ['Åpent', 'Varslet foretak', 'Varslet kommune', 'Lukket'];
const PROJECT_STATUSES = ['Aktiv', 'Fullført', 'Arkivert'];
const TILTAKSKLASSER = ['1', '2', '3'];

const UK_VEILEDNING = `UAVHENGIG KONTROLL – BYGG-KON AS

Regelverk: Plan- og bygningsloven, SAK10 § 14-2 (obligatoriske kontrollområder) og § 14-7 (gjennomføring).

Når kontroll er obligatorisk:
- Tiltaksklasse 1: fuktsikring av våtrom i boliger og lufttetthet i nye boliger. Følges våtromsnormen
  eller Byggforskseriens anvisning for tetthetsmåling, kan kontrollen forenkles til å bekrefte at
  anvisningene er fulgt.
- Tiltaksklasse 2 og 3: uavhengig kontroll av bygningsfysikk, konstruksjonssikkerhet, geoteknikk og
  brannsikkerhet når oppgavene ligger i disse klassene.

Kontrollørens oppgaver (SAK10 § 14-7):
1. Kontrollere at prosjekterende/utførende har rutiner for kvalitetssikring innenfor kontrollområdet,
   og at rutinene er fulgt og dokumentert (sjekklister, foto, tegninger med kontrollanmerkninger, referat).
2. Kontrollere at det er foretatt tilstrekkelig prosjektering, og foreta enkel kontroll av at utførelsen
   er i samsvar med produksjonsunderlaget, at produktdokumentasjon foreligger og at produkter er brukt
   i samsvar med forutsetningene. Kontrolløren skal ikke selv prosjektere.
3. Påse at avvik lukkes. Kommunen skal varsles om åpne avvik før sluttrapport ferdigstilles.

Arbeidsflyt (Bygg-Kons rutine):
${WORKFLOW_STAGES.map((s) => `  Steg ${s.nr}: ${s.navn} – ${s.beskrivelse}`).join('\n')}

Sluttdokumentasjon: kontrollerklæring med sluttrapport og plan for kontroll som viser hva som er
kontrollert og status for avvik, sendes ansvarlig søker.`;

module.exports = {
  WORKFLOW_STAGES,
  KONTROLLOMRADER,
  CHECKLIST_TEMPLATES,
  CHECKPOINT_STATUSES,
  AVVIK_STATUSES,
  PROJECT_STATUSES,
  TILTAKSKLASSER,
  UK_VEILEDNING
};
