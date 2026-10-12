#!/usr/bin/env node
// Crawlt Stellenanzeigen rund um eine PLZ, berechnet die Fahrzeit mit dem Auto
// und erzeugt eine filterbare, eigenständige HTML-Seite (docs/index.html).
//
// Quellen:
//   - Jobbörse der Bundesagentur für Arbeit (öffentliche API, kein Schlüssel nötig)
//   - Adzuna (optional, wenn ADZUNA_APP_ID und ADZUNA_APP_KEY gesetzt sind)
// Fahrzeit:
//   - OSRM (router.project-osrm.org), Ergebnisse werden in jobs/drive-cache.json gecacht
//   - Fallback: Schätzung aus Luftlinie, falls OSRM nicht erreichbar ist

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const config = JSON.parse(await readFile(join(here, 'config.json'), 'utf8'));

const BA_BASE = process.env.BA_API_BASE || 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service';
const BA_KEY = process.env.BA_API_KEY || 'jobboerse-jobsuche';
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const CACHE_FILE = join(here, 'drive-cache.json');
const OUT_DIR = join(root, process.env.OUT_DIR || 'docs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fetchJson(url, options = {}, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (res.status === 401 || res.status === 403 || res.status === 404) return { status: res.status };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { status: res.status, data: await res.json() };
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${url} -> ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------
// Bundesagentur für Arbeit
// ---------------------------------------------------------------------------

const BA_PATHS = ['/pc/v4/jobs', '/pc/v6/jobs', '/pc/v4/app/jobs'];
// Die API lehnt manche Clients mit 403 ab; deshalb mehrere Varianten durchprobieren.
const BA_HEADER_VARIANTS = [
  { 'X-API-Key': BA_KEY, 'User-Agent': 'Jobsuche/2.9.2 (de.arbeitsagentur.jobboerse; build:1077; iOS 15.1.0) Alamofire/5.4.4' },
  { 'X-API-Key': BA_KEY, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' },
  { 'X-API-KEY': BA_KEY, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' },
];
let baPath = null;
let baHeaders = null;

async function baPage(params, page) {
  const qs = new URLSearchParams({
    wo: config.plz,
    umkreis: String(config.searchRadiusKm),
    size: String(config.pageSize),
    page: String(page),
    ...params,
  });
  const tried = [];
  for (const path of baPath ? [baPath] : BA_PATHS) {
    for (const [hi, headers] of (baHeaders ? [baHeaders] : BA_HEADER_VARIANTS).entries()) {
      const res = await fetchJson(`${BA_BASE}${path}?${qs}`, { headers });
      if (!res.data) { tried.push(`${path} (Header-Variante ${hi + 1}): HTTP ${res.status}`); continue; }
      if (!baPath) {
        baPath = path;
        baHeaders = headers;
        const sample = (res.data.stellenangebote || res.data.ergebnisse || [])[0];
        log(`BA-API: verwende ${path} mit Header-Variante ${hi + 1}; Antwortfelder: ${Object.keys(res.data).join(', ')}`);
        if (sample) log(`BA-API: Felder einer Stelle: ${JSON.stringify(sample).slice(0, 600)}`);
      }
      return res.data;
    }
  }
  throw new Error(`Kein BA-Endpunkt erreichbar: ${tried.join('; ')}`);
}

// Holt alle Seiten einer Suchanfrage und gibt die Rohdaten zurück.
async function baQuery(params, label) {
  const first = await baPage(params, 1);
  const items = [...(first.stellenangebote || first.ergebnisse || [])];
  const total = Number(first.maxErgebnisse ?? first.anzahlErgebnisse ?? items.length);
  const pages = Math.min(Math.ceil(total / config.pageSize), config.maxPagesPerQuery);
  for (let start = 2; start <= pages; start += 4) {
    const batch = [];
    for (let p = start; p < start + 4 && p <= pages; p++) batch.push(baPage(params, p));
    for (const data of await Promise.all(batch)) {
      items.push(...(data.stellenangebote || data.ergebnisse || []));
    }
    await sleep(200);
  }
  log(`BA ${label}: ${items.length} von ${total} Treffern`);
  return items;
}

function baNormalize(raw) {
  const refnr = raw.refnr || raw.referenznummer;
  const ort = raw.arbeitsort || raw.arbeitsorte?.[0] || {};
  const coords = ort.koordinaten || {};
  return {
    id: `ba:${refnr}`,
    source: 'Arbeitsagentur',
    title: raw.titel || raw.stellenangebotsTitel || raw.beruf || '(ohne Titel)',
    beruf: raw.beruf || '',
    employer: raw.arbeitgeber || '',
    ort: ort.ort || '',
    plz: ort.plz || '',
    region: ort.region || '',
    lat: coords.lat ?? null,
    lon: coords.lon ?? null,
    published: raw.aktuelleVeroeffentlichungsdatum || raw.veroeffentlichungsdatum || null,
    start: raw.eintrittsdatum || null,
    url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`,
    externalUrl: raw.externeUrl || null,
    angebotsart: new Set(),
    arbeitszeit: new Set(),
    zeitarbeit: true, // wird unten auf false gesetzt, wenn die Stelle in der Suche ohne Zeitarbeit auftaucht
  };
}

async function crawlBA() {
  const jobs = new Map();
  const add = (raw, apply) => {
    const refnr = raw.refnr || raw.referenznummer;
    if (!refnr) return;
    const id = `ba:${refnr}`;
    if (!jobs.has(id)) jobs.set(id, baNormalize(raw));
    apply(jobs.get(id));
  };

  for (const [art, artLabel] of Object.entries(config.angebotsarten)) {
    for (const raw of await baQuery({ angebotsart: art }, artLabel)) {
      add(raw, (j) => j.angebotsart.add(artLabel));
    }
    for (const [az, azLabel] of Object.entries(config.arbeitszeiten)) {
      for (const raw of await baQuery({ angebotsart: art, arbeitszeit: az }, `${artLabel} / ${azLabel}`)) {
        add(raw, (j) => { j.angebotsart.add(artLabel); j.arbeitszeit.add(azLabel); });
      }
    }
    for (const raw of await baQuery({ angebotsart: art, zeitarbeit: 'false' }, `${artLabel} / ohne Zeitarbeit`)) {
      add(raw, (j) => { j.angebotsart.add(artLabel); j.zeitarbeit = false; });
    }
  }
  return [...jobs.values()];
}

// ---------------------------------------------------------------------------
// Adzuna (optional)
// ---------------------------------------------------------------------------

async function crawlAdzuna() {
  const { ADZUNA_APP_ID: id, ADZUNA_APP_KEY: key } = process.env;
  if (!id || !key) {
    log('Adzuna: übersprungen (ADZUNA_APP_ID / ADZUNA_APP_KEY nicht gesetzt)');
    return [];
  }
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const qs = new URLSearchParams({
      app_id: id, app_key: key, where: config.plz, distance: String(config.searchRadiusKm),
      results_per_page: '50', 'content-type': 'application/json',
    });
    const { data } = await fetchJson(`https://api.adzuna.com/v1/api/jobs/de/search/${page}?${qs}`);
    const results = data?.results || [];
    for (const r of results) {
      out.push({
        id: `adzuna:${r.id}`,
        source: 'Adzuna',
        title: r.title?.replace(/<[^>]+>/g, '') || '(ohne Titel)',
        beruf: r.category?.label || '',
        employer: r.company?.display_name || '',
        ort: r.location?.area?.at(-1) || r.location?.display_name || '',
        plz: '',
        region: r.location?.area?.[1] || '',
        lat: r.latitude ?? null,
        lon: r.longitude ?? null,
        published: r.created?.slice(0, 10) || null,
        start: null,
        url: r.redirect_url,
        externalUrl: null,
        angebotsart: new Set(['Arbeit']),
        arbeitszeit: new Set(
          { full_time: ['Vollzeit'], part_time: ['Teilzeit'] }[r.contract_time] || [],
        ),
        zeitarbeit: false,
        salaryMin: r.salary_min ?? null,
        salaryMax: r.salary_max ?? null,
      });
    }
    if (results.length < 50) break;
    await sleep(300);
  }
  log(`Adzuna: ${out.length} Treffer`);
  return out;
}

// ---------------------------------------------------------------------------
// Fahrzeiten
// ---------------------------------------------------------------------------

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Grobe Schätzung, wenn kein Routing verfügbar ist: Umwegfaktor 1,3, ~60 km/h im Schnitt.
const estimateMinutes = (km) => Math.round(((km * 1.3) / 60) * 60 + 3);

const coordKey = (lat, lon) => `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;

async function addDriveTimes(jobs) {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')); } catch {}
  const originKey = coordKey(config.origin.lat, config.origin.lon);
  if (cache.origin !== originKey) cache = { origin: originKey, durations: {} };

  const missing = [...new Set(
    jobs.filter((j) => j.lat != null && j.lon != null)
      .map((j) => coordKey(j.lat, j.lon))
      .filter((k) => cache.durations[k] == null),
  )];
  log(`Fahrzeiten: ${missing.length} neue Orte (Cache: ${Object.keys(cache.durations).length})`);

  let osrmOk = true;
  for (let i = 0; i < missing.length && osrmOk; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const coords = [config.origin, ...chunk.map((k) => { const [lat, lon] = k.split(','); return { lat, lon }; })]
      .map((c) => `${c.lon},${c.lat}`).join(';');
    try {
      const { data } = await fetchJson(`${OSRM_BASE}/table/v1/driving/${coords}?sources=0&annotations=duration`, {}, 3);
      if (data?.code !== 'Ok') throw new Error(data?.message || data?.code);
      chunk.forEach((k, idx) => {
        const sec = data.durations[0][idx + 1];
        if (sec != null) cache.durations[k] = Math.round(sec / 60);
      });
    } catch (err) {
      log(`OSRM nicht verfügbar (${err.message}) – verwende Schätzung aus Luftlinie`);
      osrmOk = false;
    }
    await sleep(1100); // Fair-Use-Policy des öffentlichen OSRM-Servers
  }

  for (const j of jobs) {
    if (j.lat == null || j.lon == null) { j.driveMinutes = null; continue; }
    j.distanceKm = Math.round(haversineKm(config.origin, j) * 10) / 10;
    const cached = cache.durations[coordKey(j.lat, j.lon)];
    j.driveMinutes = cached ?? estimateMinutes(j.distanceKm);
    j.driveEstimated = cached == null;
  }
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 0) + '\n');
}

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

function dedupe(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const key = `${norm(j.title)}|${norm(j.employer)}|${norm(j.ort)}`;
    if (!seen.has(key)) seen.set(key, j);
  }
  return [...seen.values()];
}

async function main() {
  const results = await Promise.allSettled([crawlBA(), crawlAdzuna()]);
  const jobs = [];
  for (const r of results) {
    if (r.status === 'fulfilled') jobs.push(...r.value);
    else console.error('Quelle fehlgeschlagen:', r.reason?.message || r.reason);
  }
  if (!jobs.length) throw new Error('Keine Stellen gefunden – alle Quellen fehlgeschlagen?');

  await addDriveTimes(jobs);

  const filtered = dedupe(jobs)
    .filter((j) => j.driveMinutes == null || j.driveMinutes <= config.maxDriveMinutes)
    .map((j) => ({
      ...j,
      angebotsart: [...j.angebotsart],
      arbeitszeit: [...j.arbeitszeit],
    }))
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));

  const payload = {
    generated: new Date().toISOString(),
    plz: config.plz,
    ortName: config.ortName,
    maxDriveMinutes: config.maxDriveMinutes,
    total: filtered.length,
    jobs: filtered,
  };
  log(`Ergebnis: ${filtered.length} Stellen innerhalb von ${config.maxDriveMinutes} min (von ${jobs.length} gecrawlt)`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'jobs.json'), JSON.stringify(payload));
  const template = await readFile(join(here, 'template.html'), 'utf8');
  // "<" escapen, damit Inhalte wie "</script>" das eingebettete JSON nicht beenden
  const html = template.replace('/*__JOBS_DATA__*/null', () => JSON.stringify(payload).replace(/</g, '\\u003c'));
  await writeFile(join(OUT_DIR, 'index.html'), html);
  log(`Geschrieben: ${join(OUT_DIR, 'index.html')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
