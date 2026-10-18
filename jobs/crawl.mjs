#!/usr/bin/env node
// Crawlt Stellenanzeigen rund um eine PLZ, berechnet die Fahrzeit mit dem Auto
// und erzeugt eine filterbare, eigenständige HTML-Seite (docs/index.html).
//
// Quellen:
//   - Jobbörse der Bundesagentur für Arbeit (öffentliche API, kein Schlüssel nötig)
//   - Regionale Börsen: RADIO SALÜ, Saarbrücker Zeitung, stellenangebotesaarland.de, Wochenspiegel (regional.mjs)
//   - Adzuna (optional, wenn ADZUNA_APP_ID und ADZUNA_APP_KEY gesetzt sind)
// Fahrzeit:
//   - OSRM (router.project-osrm.org), Ergebnisse werden in jobs/drive-cache.json gecacht
//   - Fallback: Schätzung aus Luftlinie, falls OSRM nicht erreichbar ist

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONAL_SOURCES } from './regional.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const config = JSON.parse(await readFile(join(here, 'config.json'), 'utf8'));

const BA_BASE = process.env.BA_API_BASE || 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service';
const BA_KEY = process.env.BA_API_KEY || 'jobboerse-jobsuche';
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const NOMINATIM_BASE = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
const CACHE_FILE = join(here, 'drive-cache.json');
const GEO_CACHE_FILE = join(here, 'geo-cache.json');
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
    ...(config.maxAgeDays ? { veroeffentlichtseit: String(config.maxAgeDays) } : {}),
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
        const sample = baItems(res.data)[0];
        log(`BA-API: verwende ${path} mit Header-Variante ${hi + 1}; Antwortfelder: ${Object.keys(res.data).join(', ')}`);
        if (sample) log(`BA-API: Felder einer Stelle: ${JSON.stringify(sample).slice(0, 1500)}`);
        const vals = new Set(baItems(res.data).map((x) => `${x.verguetungsangabe}/${x.artDerVerguetung}`));
        log(`BA-API: Vergütungsangaben auf Seite 1: ${[...vals].join(', ')}`);
      }
      return res.data;
    }
  }
  throw new Error(`Kein BA-Endpunkt erreichbar: ${tried.join('; ')}`);
}

// v4 liefert "stellenangebote", v6 "ergebnisliste"
const baItems = (data) => data?.stellenangebote || data?.ergebnisliste || data?.ergebnisse || [];

// Holt alle Seiten einer Suchanfrage und gibt die Rohdaten zurück.
async function baQuery(params, label) {
  const first = await baPage(params, 1);
  const items = [...baItems(first)];
  const total = Number(first.maxErgebnisse ?? first.anzahlErgebnisse ?? items.length);
  const pages = Math.min(Math.ceil(total / config.pageSize), config.maxPagesPerQuery);
  for (let start = 2; start <= pages; start += 4) {
    const batch = [];
    for (let p = start; p < start + 4 && p <= pages; p++) batch.push(baPage(params, p));
    for (const data of await Promise.all(batch)) {
      items.push(...baItems(data));
    }
    await sleep(200);
  }
  log(`BA ${label}: ${items.length} von ${total} Treffern`);
  if (total > 0 && !items.length) {
    throw new Error(`BA-API meldet ${total} Treffer, aber keine Stellen im Ergebnis. Felder: ${Object.keys(first).join(', ')}`);
  }
  return items;
}

const baRefnr = (raw) => raw.refnr || raw.referenznummer || raw.hashId || raw.id;
const asText = (v) => (v && typeof v === 'object' ? v.name || v.bezeichnung || v.text || '' : v || '');

// Sucht rekursiv das erste Objekt mit lat/lon (Koordinaten liegen je nach API-Version unterschiedlich tief)
function findCoords(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  const lat = obj.lat ?? obj.latitude ?? obj.breitengrad;
  const lon = obj.lon ?? obj.lng ?? obj.longitude ?? obj.laengengrad;
  if (lat != null && lon != null && !isNaN(lat) && !isNaN(lon)) return { lat: Number(lat), lon: Number(lon) };
  for (const v of Object.values(obj)) {
    const c = findCoords(v, depth + 1);
    if (c) return c;
  }
  return null;
}

// Gehaltsangabe der BA: gehaltsspanneVon/-Bis bzw. Einzelwert, Einheit aus verguetungsangabe
function baSalary(raw) {
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  let min = num(raw.gehaltsspanneVon ?? raw.gehaltVon ?? raw.gehalt ?? raw.verguetungVon);
  let max = num(raw.gehaltsspanneBis ?? raw.gehaltBis ?? raw.verguetungBis);
  if (!min && !max) return null;
  if (!min) min = max;
  if (max != null && max < min) [min, max] = [max, min];
  const art = String(raw.verguetungsangabe || raw.gehaltsangabe || raw.verguetungseinheit || '');
  const unit = /stunde/i.test(art) ? 'Std' : /jahr/i.test(art) ? 'Jahr' : /monat/i.test(art) ? 'Monat' : guessUnit(min);
  return makeSalary(min, max, unit);
}

function baNormalize(raw) {
  const refnr = baRefnr(raw);
  const ort = raw.arbeitsort || raw.arbeitsorte?.[0] || raw.arbeitsortAdresse || raw.stellenlokationen?.[0]?.adresse || {};
  const coords = findCoords(ort) || findCoords(raw) || {};
  return {
    id: `ba:${refnr}`,
    source: 'Arbeitsagentur',
    title: asText(raw.titel || raw.stellenangebotsTitel || raw.stellentitel || raw.stellenbezeichnung || raw.beruf || raw.hauptberuf) || '(ohne Titel)',
    beruf: asText(raw.beruf || raw.hauptberuf),
    employer: asText(raw.arbeitgeber || raw.firma || raw.arbeitgeberName),
    ort: ort.ort || ort.stadt || '',
    plz: String(ort.plz || ''),
    region: ort.region || '',
    lat: coords.lat ?? null,
    lon: coords.lon ?? null,
    published: (raw.aktuelleVeroeffentlichungsdatum || raw.veroeffentlichungsdatum || raw.datumErsteVeroeffentlichung || '').slice(0, 10) || null,
    start: (raw.eintrittsdatum || '').slice(0, 10) || null,
    url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`,
    externalUrl: raw.externeUrl || null,
    angebotsart: new Set(),
    arbeitszeit: new Set(),
    zeitarbeit: true, // wird unten auf false gesetzt, wenn die Stelle in der Suche ohne Zeitarbeit auftaucht
    salary: baSalary(raw),
  };
}

async function crawlBA() {
  const jobs = new Map();
  const add = (raw, apply) => {
    const refnr = baRefnr(raw);
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
        salary: r.salary_min || r.salary_max ? makeSalary(r.salary_min || r.salary_max, r.salary_max || null, 'Jahr') : null,
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
// Geocodierung (die BA-API v6 liefert keine Koordinaten mehr)
// ---------------------------------------------------------------------------

const GEO_CACHE_VERSION = 2;
const GEO_HEADERS = { 'User-Agent': 'jobs-crawler (github.com/maxpd1/actionsflow-workflow)', 'Accept-Language': 'de' };

async function nominatim(params) {
  const qs = new URLSearchParams({ format: 'jsonv2', limit: '1', ...params });
  const { data } = await fetchJson(`${NOMINATIM_BASE}/search?${qs}`, { headers: GEO_HEADERS }, 3);
  await sleep(1100); // Nominatim erlaubt höchstens 1 Anfrage pro Sekunde
  return data?.[0] ? { lat: Number(data[0].lat), lon: Number(data[0].lon) } : null;
}

async function geocodeMissing(jobs) {
  let cache = {};
  try { cache = JSON.parse(await readFile(GEO_CACHE_FILE, 'utf8')); } catch {}
  if (cache.version !== GEO_CACHE_VERSION) cache = { version: GEO_CACHE_VERSION, places: {} };
  const keyOf = (j) => `${j.plz}|${j.ort}`;
  const todo = [...new Set(jobs.filter((j) => j.lat == null && (j.plz || j.ort)).map(keyOf))]
    .filter((k) => !(k in cache.places))
    .sort((a, b) => (a.startsWith('|') ? 1 : 0) - (b.startsWith('|') ? 1 : 0));
  log(`Geocodierung: ${todo.length} neue Orte (Cache: ${Object.keys(cache.places).length})`);

  // Suchfenster rund um den Startort, damit gleichnamige Orte woanders nicht gewinnen
  const d = 1.0;
  const viewbox = [config.origin.lon - d, config.origin.lat + d, config.origin.lon + d, config.origin.lat - d].join(',');
  // Bekannte Orte mit PLZ (aus der Arbeitsagentur) als Nachschlagetabelle für Angaben ohne PLZ,
  // z. B. "Dillingen" (SZ) -> "66763|Dillingen, Saar"; "Sankt Wendel" -> "St. Wendel, Saar"
  const normPlace = (s) => s.toLowerCase().replace(/\bsankt\b/g, 'st.').replace(/\s*[,/(].*$/, '').replace(/\s+/g, ' ').trim();
  const twinOf = (name) => {
    const n = normPlace(name);
    const hit = jobs.find((j) => j.plz && normPlace(j.ort) === n && cache.places[keyOf(j)]);
    return hit ? cache.places[keyOf(hit)] : null;
  };
  for (const key of todo) {
    const [plz, ort] = key.split('|');
    // Kandidaten: ganze Angabe, jede Teilangabe ("A, B" oder "A/B"), Hauptort vor einem Bindestrich
    const parts = ort.split(/\s*[,/]\s*/).map((x) => x.replace(/\s*\(.*\)$/, '').trim()).filter((x) => x.length > 2 && !/^saar(land)?$/i.test(x));
    const candidates = [...new Set([...parts, ...parts.map((x) => x.split('-')[0])])];
    try {
      // Nur die PLZ liefert den Mittelpunkt des PLZ-Gebiets (genauer als die Stadtmitte)
      let c = plz ? await nominatim({ postalcode: plz, countrycodes: 'de' }) : null;
      // Ohne PLZ: gleichnamigen Ort mit PLZ aus den Daten übernehmen ("Neunkirchen, Saar" gibt es mehrfach)
      if (!c && !plz) c = twinOf(ort) || candidates.map(twinOf).find(Boolean) || null;
      for (const place of candidates) {
        if (c) break;
        c = await nominatim({ q: place, countrycodes: 'de,fr,lu', viewbox, bounded: '1' });
        // Unplausible Treffer verwerfen (Stellen liegen höchstens im Suchradius)
        if (c && haversineKm(config.origin, c) > config.searchRadiusKm * 1.5) c = null;
      }
      cache.places[key] = c;
    } catch (err) {
      log(`Geocodierung fehlgeschlagen für ${key}: ${err.message}`);
    }
  }

  for (const j of jobs) {
    const c = j.lat == null ? cache.places[keyOf(j)] : null;
    if (c) { j.lat = c.lat; j.lon = c.lon; }
  }
  const missing = jobs.filter((j) => j.lat == null).length;
  if (missing) log(`Geocodierung: ${missing} Stellen ohne Koordinaten`);
  await writeFile(GEO_CACHE_FILE, JSON.stringify(cache, null, 0) + '\n');
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
    // Routing-Ausreißer (z. B. Punkt an einer Sackgasse eingerastet) durch die Schätzung ersetzen
    const plausible = cached != null && cached <= estimateMinutes(j.distanceKm) * 1.8 + 5;
    j.driveMinutes = plausible ? cached : estimateMinutes(j.distanceKm);
    j.driveEstimated = !plausible;
  }
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 0) + '\n');
}

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

// Die Arbeitsagentur markiert manche Teilzeit- oder Minijob-Stellen als Vollzeit.
// Eine eindeutige Angabe im Titel hat deshalb Vorrang vor der Markierung.
function fixArbeitszeit(j) {
  const t = j.title || '';
  const hours = Number((/(\d{1,2})(?:[,.]\d+)?\s*(?:std|stunden|h)\b\.?\s*(?:\/|pro|je|in der)?\s*(?:wo|woche)/i.exec(t) || [])[1]);
  const percent = Number((/\b(\d{2})\s*%/.exec(t) || [])[1]);
  const part = /teilzeit|teil-\s|\btz\b|halbtags/i.test(t) || (hours > 0 && hours < 30) || (percent > 0 && percent < 90);
  const full = /vollzeit|voll-\s|\bvz\b/i.test(t) || (hours >= 35 && !part);
  const mini = /minijob|mini-job|geringfügig|\b(520|538|556|603)\s*(€|euro|eur)|auf (450|520|538|556|603)/i.test(t);
  const set = j.arbeitszeit;
  if (full) set.add('Vollzeit');
  if (part) set.add('Teilzeit');
  if (mini) set.add('Minijob');
  // Nur bei eindeutigem Titel widersprechende Markierungen entfernen
  if ((part || mini) && !full) set.delete('Vollzeit');
  if (full && !part && !mini) { set.delete('Teilzeit'); set.delete('Minijob'); }
}

// ---------------------------------------------------------------------------
// Gehalt: einheitliches Format { min, max, unit: 'Std'|'Monat'|'Jahr', monthly }
// ---------------------------------------------------------------------------
const guessUnit = (v) => (v >= 15000 ? 'Jahr' : v >= 450 ? 'Monat' : 'Std');
function makeSalary(min, max, unit) {
  if (!min || min <= 0) return null;
  if (max && max === min) max = null;
  // Platzhalter der Arbeitgeber ("1 – 500.000") und extrem weite Spannen verwerfen
  if (min <= 1 || (max && max / min > 4)) return null;
  // Einheit an die Größenordnung anpassen (z. B. "2.700–4.788 € pro Jahr" ist ein Monatsgehalt)
  const top = max || min;
  if (unit === 'Jahr' && top < 12000) unit = top < 150 ? 'Std' : 'Monat';
  else if (unit === 'Monat' && top >= 20000) unit = 'Jahr';
  else if (unit === 'Monat' && top < 60) unit = 'Std';
  else if (unit === 'Std' && top >= 450) unit = top >= 15000 ? 'Jahr' : 'Monat';
  const factor = { Std: 173, Monat: 1, Jahr: 1 / 12 }[unit];
  const mid = max ? (min + max) / 2 : min;
  const monthly = Math.round(mid * factor);
  // Unplausible Werte (z. B. Tippfehler oder Stückzahlen) verwerfen
  if (monthly < 300 || monthly > 30000) return null;
  return { min, max: max || null, unit, monthly };
}

// Gehalt aus dem Titel lesen ("18 €/Std.", "16,36 €/h", "3.200 € brutto/Monat", "45.000–55.000 € p.a.")
function salaryFromTitle(t) {
  const n = (x) => Number(String(x).replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  const amount = String.raw`(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)`;
  const re = new RegExp(`${amount}\\s*(?:€|euro|eur)?\\s*(?:-|–|bis)\\s*${amount}\\s*(?:€|euro|eur)|${amount}\\s*(?:€|euro|eur)`, 'gi');
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, m.index - 25), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 25);
    // Prämien, Boni und Zuschüsse sind kein Gehalt
    if (/prämie|bonus|zuschuss|zulage|gutschein|provision|sachbezug/i.test(after.slice(0, 20)) || /(prämie|bonus|zuschuss|zulage|gutschein)\s*(von|in höhe von|i\.?\s?h\.?\s?v\.?)?\s*(bis\s*(zu)?)?\s*$/i.test(before)) continue;
    const upTo = !m[2] && /\bbis\s*(zu\s*)?$/i.test(before);
    const first = n(m[1] ?? m[3]);
    const second = m[2] ? n(m[2]) : null;
    const unit = /^\s*(?:brutto\s*)?(?:\/|pro|je|die)?\s*(?:std|stunde|h\b)/i.test(after) ? 'Std'
      : /^\s*(?:brutto\s*)?(?:\/|pro|im|je)?\s*(?:monat|mtl|mon\b)/i.test(after) ? 'Monat'
      : /^\s*(?:brutto\s*)?(?:\/|pro|im|je)?\s*(?:jahr|p\.\s?a\.|jährlich)/i.test(after) ? 'Jahr'
      : guessUnit(second || first);
    const sal = makeSalary(first, second, unit);
    if (sal && upTo) sal.upTo = true;
    if (sal) return sal;
  }
  return null;
}

const normOrt = (s) => norm((s || '').replace(/\bSankt\b/g, 'St.').replace(/\s*[,/(].*$/, ''));

// Gleiche Stelle aus mehreren Quellen nur einmal zeigen; die weiteren Quellen werden vermerkt
function dedupe(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const key = `${norm(j.title)}|${norm(j.employer)}|${normOrt(j.ort)}`;
    const first = seen.get(key);
    if (!first) seen.set(key, j);
    else if (first.source !== j.source) {
      first.alsoAt = [...new Set([...(first.alsoAt || []), j.source])];
      first.alsoAtUrl ||= j.url;
    }
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

  // Regionale Börsen; Ortsnamen aus den BA-Daten helfen, Orte in Kleinanzeigen zu erkennen
  const knownTowns = [...new Set(jobs.map((j) => j.ort.replace(/\s*[,(].*$/, '')).filter((o) => o.length > 3))]
    .sort((a, b) => b.length - a.length);
  for (const crawl of REGIONAL_SOURCES) {
    try {
      jobs.push(...await crawl(log, { knownTowns, portals: config.employerPortals || [] }));
    } catch (err) {
      console.error(`Regionale Quelle fehlgeschlagen (${crawl.name}):`, err.message);
    }
  }

  // Nur Anzeigen der letzten maxAgeDays Tage; Anzeigen ohne Datum lassen sich nicht prüfen und fallen raus
  if (config.maxAgeDays) {
    const cutoff = new Date(Date.now() - config.maxAgeDays * 864e5).toISOString().slice(0, 10);
    const before = jobs.length;
    for (let i = jobs.length - 1; i >= 0; i--) if (!jobs[i].published || jobs[i].published < cutoff) jobs.splice(i, 1);
    log(`Alter: ${before - jobs.length} Anzeigen älter als ${config.maxAgeDays} Tage oder ohne Datum entfernt (Stichtag ${cutoff})`);
  }

  jobs.forEach(fixArbeitszeit);
  for (const j of jobs) if (!j.salary) j.salary = salaryFromTitle(j.title || '');
  log(`Gehalt: ${jobs.filter((j) => j.salary).length} von ${jobs.length} Anzeigen mit Gehaltsangabe`);
  await geocodeMissing(jobs);
  await addDriveTimes(jobs);

  const filtered = dedupe(jobs)
    // Regionale Kleinanzeigen ohne erkennbaren Ort bleiben drin (auf der Seite standardmäßig ausgeblendet)
    .filter((j) => (j.driveMinutes == null ? j.source !== 'Arbeitsagentur' : j.driveMinutes <= config.maxDriveMinutes))
    .map((j) => ({
      ...j,
      angebotsart: [...j.angebotsart],
      arbeitszeit: [...j.arbeitszeit],
    }))
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));

  let profiles = [];
  try { profiles = JSON.parse(await readFile(join(here, 'profiles.json'), 'utf8')).profiles || []; } catch (err) { log(`Profile nicht geladen: ${err.message}`); }

  const payload = {
    profiles,
    generated: new Date().toISOString(),
    plz: config.plz,
    ortName: config.ortName,
    maxDriveMinutes: config.maxDriveMinutes,
    maxAgeDays: config.maxAgeDays || null,
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
