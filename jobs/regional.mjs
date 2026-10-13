// Regionale Jobbörsen im Saarland. Jede Funktion liefert Stellen im gemeinsamen Format von crawl.mjs.
// Die Seiten haben keine offizielle Schnittstelle; die Parser lesen das HTML und sind deshalb
// bewusst tolerant: schlägt eine Quelle fehl, laufen die anderen weiter.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { encoding = 'utf-8', attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new TextDecoder(encoding).decode(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${url} -> ${lastErr?.message}`);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', euro: '€',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', raquo: '»', laquo: '«', bdquo: '„', ldquo: '“', rdquo: '”' };
const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? m);
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const deDate = (s) => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s || ''); if (!m) return null; const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; };

// Ortsangaben vereinheitlichen: "66117 Saarbrücken" -> PLZ + Ort, Kfz-Kürzel ausschreiben
const KFZ = { SB: 'Saarbrücken', VK: 'Völklingen', NK: 'Neunkirchen, Saar', HOM: 'Homburg, Saar', SLS: 'Saarlouis', MZG: 'Merzig',
  WND: 'St. Wendel, Saar', IGB: 'St. Ingbert', DIL: 'Dillingen, Saar', LEB: 'Lebach' };
export function cleanOrt(raw) {
  let ort = String(raw || '').replace(/\s+/g, ' ').trim();
  const plz = /\b(\d{5})\b/.exec(ort)?.[1] || '';
  ort = ort.replace(/\b\d{5}\b/, '').trim();
  if (/^(saarland|saarlandweit|bundesweit|deutschlandweit|homeoffice|remote)$/i.test(ort)) ort = '';
  const abbr = /^([A-ZÄÖÜ]{2,3})(?:[-/ ]|$)/.exec(ort)?.[1];
  if (abbr && KFZ[abbr]) ort = KFZ[abbr];
  ort = ort.replace(/\s*\/\s*Saar$/i, ', Saar');
  return { plz, ort };
}

function job(fields) {
  return {
    beruf: '', plz: '', region: 'Saarland', lat: null, lon: null, start: null, externalUrl: null,
    angebotsart: new Set([/ausbildung|azubi|duales studium/i.test(fields.title) ? 'Ausbildung / Duales Studium' : /praktik|trainee|werkstudent/i.test(fields.title) ? 'Praktikum / Trainee' : 'Arbeit']),
    arbeitszeit: new Set([
      ...(/vollzeit/i.test(fields.title) ? ['Vollzeit'] : []),
      ...(/teilzeit/i.test(fields.title) ? ['Teilzeit'] : []),
      ...(/minijob|aushilf|603|538|556|450/i.test(fields.title) ? ['Minijob'] : []),
    ]),
    zeitarbeit: false,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// RADIO SALÜ Jobbörse – zwei Tabellen: "im Radio gehört" und "die neuesten Stellenanzeigen"
// ---------------------------------------------------------------------------
export async function crawlSalue(log) {
  const base = 'https://www.salue.de/jobs/';
  const html = await fetchText(base, { encoding: 'iso-8859-1' });
  const out = [];
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 4) continue;
    const href = decode((/href="([^"]+)"/i.exec(cells[0]) || [])[1] || '');
    const title = text(cells[0]).replace(/\s*[»«]+$/, '');
    if (!title || !href) continue;
    const date = (/(\d{4}-\d{2}-\d{2})\.\d+\.(?:pdf|mp3)/.exec(row) || [])[1] || null;
    out.push(job({
      id: `salue:${href.replace(/^.*\/\/(uploads)?/, '')}`,
      source: 'RADIO SALÜ',
      title,
      employer: text(cells[1]),
      ...cleanOrt(text(cells[2])),
      beruf: text(cells[3]),
      published: date,
      url: new URL(href, base).href,
    }));
  }
  log(`RADIO SALÜ: ${out.length} Stellen`);
  return out;
}

// ---------------------------------------------------------------------------
// Stellenmarkt der Saarbrücker Zeitung / Pfälzischer Merkur (Plattform von stellenanzeigen.de)
// ---------------------------------------------------------------------------
export async function crawlSZ(log, { city = 'Saarlouis', cityId = 'M-DE-17307', radiusKm = 50, maxPages = 60 } = {}) {
  const base = 'https://saarbruecker-zeitung.stellenanzeigen.de';
  const seen = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      city, cityId, areaRadius: String(radiusKm), page: String(page),
      topJobOnly: '0', jobModeId: '0', sortKey: '1', topUpOffers: 'False', searchCompanyProfiles: 'False',
    });
    const html = await fetchText(`${base}/Suchergebnisse?${qs}`);
    const blocks = html.split(/<div class="jobad-container/).slice(1);
    let added = 0;
    for (const b of blocks) {
      const a = /<a href="(\/jobs\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
      if (!a || seen.has(a[2])) continue;
      const dcc = /<div class="date-company-city">([\s\S]*?)<\/div>/i.exec(b)?.[1] || '';
      const parts = text(dcc).split(' / ').map((s) => s.trim());
      seen.set(a[2], job({
        id: `sz:${a[2]}`,
        source: 'Saarbrücker Zeitung',
        title: text(a[3]),
        employer: text(/id="companyName"[^>]*>([\s\S]*?)<\/span>/i.exec(dcc)?.[1]) || parts[1] || '',
        ort: parts.length >= 3 ? parts[parts.length - 1] : '',
        published: deDate(parts[0]),
        url: base + a[1],
      }));
      added++;
    }
    if (!added) break;
    await sleep(400);
  }
  log(`Saarbrücker Zeitung: ${seen.size} Stellen`);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// stellenangebotesaarland.de – Karten auf der Startseite, Details per JobPosting-JSON-LD
// ---------------------------------------------------------------------------
export async function crawlStellenangeboteSaarland(log) {
  const base = 'https://stellenangebotesaarland.de/';
  const html = await fetchText(base);
  const out = [];
  // Jede Karte endet mit dem Button "Zum Stellenangebot"; davor stehen Firma und Titel als
  // Überschriften und der Ort als erster Eintrag der Symbol-Liste
  const re = /href="(https:\/\/stellenangebotesaarland\.de\/[^"#]+)"[^>]*>(?:(?!<\/a>)[\s\S]){0,400}?Zum Stellenangebot/gi;
  const seenUrls = new Set();
  let last = 0;
  for (const m of html.matchAll(re)) {
    const chunk = html.slice(last, m.index);
    last = m.index + m[0].length;
    if (seenUrls.has(m[1])) continue;
    seenUrls.add(m[1]);
    const headings = [...chunk.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((x) => text(x[1])).filter(Boolean);
    const items = [...chunk.matchAll(/<li[^>]*elementor-icon-list-item[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => x[1]);
    const ortItem = items.find((x) => /map-marker|location/i.test(x)) || items[0] || '';
    const [employer = '', title = ''] = headings.slice(-2);
    out.push(job({ id: `sas:${m[1]}`, source: 'stellenangebotesaarland.de', title, employer, ...cleanOrt(text(/elementor-icon-list-text[^>]*>([\s\S]*?)<\/span>/i.exec(ortItem)?.[1])), published: null, url: m[1] }));
  }
  // Detailseiten: Titel und Datum aus dem JobPosting
  for (const j of out) {
    try {
      const d = await fetchText(j.url);
      for (const block of d.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
        const data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, ''));
        const list = [data, ...(data['@graph'] || [])].flatMap((x) => [x, ...(x?.['@graph'] || [])]);
        const jp = list.find((x) => x?.['@type'] === 'JobPosting');
        if (!jp) continue;
        if (jp.title) j.title = decode(jp.title);
        j.published = jp.datePosted?.slice(0, 10) || null;
        const addr = [].concat(jp.jobLocation || [])[0]?.address;
        if (addr?.postalCode) j.plz = String(addr.postalCode);
        if (addr?.addressLocality && !j.ort) j.ort = addr.addressLocality;
        const et = [].concat(jp.employmentType || []).join(' ');
        if (/FULL/i.test(et)) j.arbeitszeit.add('Vollzeit');
        if (/PART/i.test(et)) j.arbeitszeit.add('Teilzeit');
      }
    } catch (err) {
      log(`stellenangebotesaarland.de: Detailseite ${j.url} fehlgeschlagen (${err.message})`);
    }
    await sleep(300);
  }
  const valid = out.filter((j) => j.title);
  log(`stellenangebotesaarland.de: ${valid.length} Stellen`);
  return valid;
}

// ---------------------------------------------------------------------------
// Wochenspiegel Job-Spiegel – Kleinanzeigen; nur Rubriken mit Stellenangeboten (keine Gesuche)
// ---------------------------------------------------------------------------
const WOSPI_RUBRIKEN = [
  'aushilfen-angebote-603-eur',
  'betreuungs-pflegeangebote',
  'haushalts-putzhilfe-angebote',
  'hotels-gaststaetten',
  'raum-und-gebaeudereinigung',
  'stellenmarkt-allgemein-st',
];

// Ortsnamen im Anzeigentext erkennen ("im Raum Neunkirchen", "in Saarlouis", "66740 Saarlouis")
function guessOrt(t, knownTowns) {
  const plz = /\b(66\d{3}|54\d{3}|67\d{3})\b/.exec(t)?.[1] || '';
  const lower = t.toLowerCase();
  const town = knownTowns.find((o) => new RegExp(`\\b${o.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
  return { plz, ort: town || '' };
}

export async function crawlWochenspiegel(log, { knownTowns = [] } = {}) {
  // Kfz-Kürzel wie "HOM" oder "SLS" in Kleinanzeigen als Ort werten
  knownTowns = [...knownTowns];
  const base = 'https://www.wochenspiegelonline.de';
  const seen = new Map();
  for (const rubrik of WOSPI_RUBRIKEN) {
    for (let page = 1; page <= 15; page++) {
      const url = `${base}/anzeigen/job-spiegel/${rubrik}${page > 1 ? `/seite-${page}` : ''}`;
      let html;
      try { html = await fetchText(url); } catch (err) { if (page === 1) log(`Wochenspiegel ${rubrik}: ${err.message}`); break; }
      const hits = [...html.matchAll(/href="(\/anzeigen\/job-spiegel\/anzeige\/(\d+))"/g)];
      let added = 0;
      for (let i = 0; i < hits.length; i++) {
        const id = hits[i][2];
        if (seen.has(id)) continue;
        const chunk = html.slice(hits[i].index, hits[i + 1]?.index ?? hits[i].index + 3000);
        const t = text(chunk.replace(/^[^>]*>/, ''));
        const published = deDate(t);
        const title = t.replace(/\s*\d{1,2}\.\d{1,2}\.\d{4}[\s\S]*$/, '').trim();
        if (!title) continue;
        let { plz, ort } = guessOrt(title, knownTowns);
        if (!ort) { const k = /\b(SB|VK|NK|HOM|SLS|MZG|WND|IGB)\b/.exec(title)?.[1]; if (k) ort = KFZ[k]; }
        seen.set(id, job({
          id: `wospi:${id}`,
          source: 'Wochenspiegel',
          title: title.length > 160 ? `${title.slice(0, 157)}…` : title,
          employer: '',
          ort, plz,
          published,
          url: base + hits[i][1],
        }));
        added++;
      }
      if (!added || !html.includes(`seite-${page + 1}`)) break;
      await sleep(400);
    }
  }
  log(`Wochenspiegel: ${seen.size} Kleinanzeigen`);
  return [...seen.values()];
}

export const REGIONAL_SOURCES = [crawlSalue, crawlSZ, crawlStellenangeboteSaarland, crawlWochenspiegel];
