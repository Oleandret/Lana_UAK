# Byggkon UK – uavhengig kontroll med Claude

Webapplikasjon for Bygg-Kon AS som forenkler uavhengig kontroll (SAK10 § 14-7). Innlogging med Microsoft 365, prosjektstyring etter Byggkons 6-stegs UK-rutine, sjekklister generert fra interne maler, avviksbehandling, rapportgenerering – og et innebygd MCP-endepunkt slik at Claude kan jobbe direkte i systemet.

## Funksjoner

Nettsiden gir prosjektoversikt med fremdrift, sjekklister per kontrollområde (konstruksjonssikkerhet, geoteknikk, bygningsfysikk, brannsikkerhet, våtrom og lufttetthet i tkl. 1) delt i prosjektering/utførelse, avviksregister med varslingsdatoer (foretak/kommune), dokumentlogg, aktivitetslogg som skiller mellom endringer gjort fra web og fra Claude, og utskriftsvennlige rapporter: kontrollerklæring med sluttrapport, sluttrapport og plan for kontroll. Systemet sperrer overgang til steg 6 (sluttrapport) hvis avvik verken er lukket eller varslet kommunen – i tråd med rutinen.

MCP-serveren på `/mcp` gir Claude verktøyene: `uk_veiledning`, `list_projects`, `get_project`, `create_project`, `set_stage`, `update_checkpoint`, `add_checkpoint`, `create_avvik`, `update_avvik`, `register_document`, `get_report_data`, `save_report`, `get_activity`. Typisk arbeidsflyt: be Claude lese dokumentasjon, vurdere den mot sjekkpunktene, sette status, registrere avvik og utarbeide rapportutkast som lagres i systemet og skrives ut fra nettsiden.

## Kjøre lokalt

```bash
npm install
npm start          # http://localhost:3000
```

Uten Azure-variabler er utviklings-innlogging aktiv (kun e-post). Første bruker som logger inn blir admin.

## Deploy på Railway

1. Opprett nytt prosjekt på railway.app → «Deploy from GitHub repo» (push denne mappen til et repo) eller `railway up` med CLI. Dockerfile plukkes opp automatisk.
2. Legg til et **volum** montert på `/data`, og sett variabelen `DB_PATH=/data/byggkon-uk.db` (ellers slettes databasen ved hver deploy).
3. Sett variabler: `BASE_URL` (Railway-domenet, f.eks. `https://byggkon-uk.up.railway.app`), `SESSION_SECRET` (lang tilfeldig streng), og Azure-variablene under.
4. Generer offentlig domene under Settings → Networking.

## Microsoft 365 SSO (Entra ID)

1. Gå til [entra.microsoft.com](https://entra.microsoft.com) → App registrations → **New registration**.
2. Navn: «Byggkon UK». Supported account types: «Accounts in this organizational directory only».
3. Redirect URI (Web): `https://<ditt-domene>/auth/callback`.
4. Under Certificates & secrets → New client secret. Kopier verdien.
5. Sett i Railway: `AZURE_TENANT_ID` (Directory ID), `AZURE_CLIENT_ID` (Application ID), `AZURE_CLIENT_SECRET`.
6. `ALLOWED_DOMAINS=byggkon.no` begrenser innlogging til Byggkon-kontoer.

## Koble til Claude

Hver bruker har sin personlige API-nøkkel under «Innstillinger / Claude» på nettsiden – der ligger også ferdig konfigurasjon til å lime inn.

Claude Code:
```bash
claude mcp add byggkon-uk --transport http https://<ditt-domene>/mcp \
  --header "Authorization: Bearer <api-nøkkel>"
```

Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "byggkon-uk": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<ditt-domene>/mcp",
               "--header", "Authorization: Bearer <api-nøkkel>"]
    }
  }
}
```

Merk: claude.ai (web) sine «custom connectors» krever OAuth; denne versjonen bruker API-nøkkel, som fungerer med Claude Code, Claude Desktop og API-et. OAuth-støtte kan legges til senere.

## Eksempel på bruk med Claude

«Opprett UK-prosjekt 26 042 for NorSea AS, ny lagerhall i Sandnes, tkl. 2, kontrollområder konstruksjonssikkerhet og geoteknikk» → Claude oppretter prosjektet med ferdige sjekklister. Lim deretter inn (eller la Claude lese) prosjekteringsdokumentasjon og be Claude vurdere den mot sjekkpunktene, sette status og registrere avvik. Til slutt: «Utarbeid sluttrapport og kontrollerklæring» → Claude henter datagrunnlaget, skriver rapporttekst og lagrer den; du åpner rapporten fra prosjektsiden og skriver ut til PDF.

All aktivitet fra Claude logges med kilde «Claude» i aktivitetsloggen, slik at kontrolløren alltid kan etterprøve hva som er gjort. Det faglige ansvaret ligger hos ansvarlig kontrollerende – Claude er et hjelpemiddel, og rapporter skal alltid gjennomgås før de sendes.
