// Temporär: testet die Parser in regional.mjs gegen die echten Seiten.
import { readFile } from 'node:fs/promises';
import { crawlSalue, crawlSZ, crawlStellenangeboteSaarland, crawlWochenspiegel } from './regional.mjs';
const log = (...a) => console.log(...a);
const geo = JSON.parse(await readFile(new URL('./geo-cache.json', import.meta.url), 'utf8'));
const knownTowns = [...new Set(Object.keys(geo.places).map((k) => k.split('|')[1].replace(/,.*$/, '')))].sort((a, b) => b.length - a.length);
const show = (name, jobs, n = 5) => {
  console.log(`\n##### ${name}: ${jobs.length}`);
  for (const j of jobs.slice(0, n)) console.log(JSON.stringify({ ...j, angebotsart: [...j.angebotsart], arbeitszeit: [...j.arbeitszeit] }));
  const noOrt = jobs.filter((j) => !j.ort && !j.plz).length, noDate = jobs.filter((j) => !j.published).length, noEmp = jobs.filter((j) => !j.employer).length;
  console.log(`ohne Ort: ${noOrt}, ohne Datum: ${noDate}, ohne Firma: ${noEmp}`);
  const orte = {}; for (const j of jobs) orte[j.ort] = (orte[j.ort] || 0) + 1;
  console.log('Orte:', Object.entries(orte).sort((a, b) => b[1] - a[1]).slice(0, 25).map((x) => x.join(':')).join(', '));
};
for (const [name, fn, n] of [['Salü', crawlSalue, 25], ['SZ', crawlSZ, 5], ['SAS', crawlStellenangeboteSaarland, 40], ['WoSpi', (l) => crawlWochenspiegel(l, { knownTowns }), 12]]) {
  try { show(name, await fn(log), n); } catch (err) { console.log(`##### ${name} FEHLER`, err.stack); }
}
