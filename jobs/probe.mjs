// Temporär: untersucht regionale Jobbörsen, um passende Parser zu schreiben.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' }, signal: AbortSignal.timeout(30000) });
  const html = await res.text();
  console.log(`\n==================== ${url}\nstatus ${res.status} final ${res.url} len ${html.length}`);
  return html;
};
const flat = (s) => s.replace(/\s+/g, ' ');
const around = (html, re, before = 300, after = 3000) => { const i = html.search(re); return i < 0 ? '(nicht gefunden)' : flat(html.slice(Math.max(0, i - before), i + after)); };
const ld = (html) => [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => flat(m[1]).slice(0, 2500)).join('\n  || ');

try {
  // SZ-Stellenmarkt
  let h = await get('https://saarbruecker-zeitung.stellenanzeigen.de/');
  console.log('FORM-NAMES:', [...h.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).join(', '));
  console.log('RADIUS/ORT:', around(h, /Ort, PLZ/i, 500, 2500));
  h = await get('https://saarbruecker-zeitung.stellenanzeigen.de/stellenangebote/saarlouis');
  console.log('PAGEINFO:', around(h, /currentPageInformation = /, 0, 500));
  console.log('LIST:', around(h, /\/jobs\/\d+\//, 1500, 3000));
  console.log('PAGING:', [...new Set([...h.matchAll(/href="([^"]*(?:page|Seite|pageNumber|PageNumber)[^"]*)"/gi)].map((m) => m[1]))].slice(0, 20).join(' | '));
  console.log('COUNT-TEXT:', around(h, /Treffer|Stellenangebote gefunden|Ergebnisse/i, 200, 300));
  h = await get('https://saarbruecker-zeitung.stellenanzeigen.de/Suchergebnisse?Searchterm=&Ort=66793&Umkreis=30');
  console.log('PAGEINFO:', around(h, /currentPageInformation = /, 0, 500));
  console.log('COUNT-TEXT:', around(h, /Treffer|Stellenangebote gefunden|Ergebnisse/i, 200, 300));
  h = await get('https://saarbruecker-zeitung.stellenanzeigen.de/jobs/16418809/Netzmeister_Gas_Wasser_Fernw%C3%A4rme_Meister_im_Heizu');
  console.log('DETAIL-LD:', ld(h));

  // stellenangebotesaarland.de
  h = await get('https://stellenangebotesaarland.de/');
  console.log('CARD:', around(h, /Zum Stellenangebot/, 3500, 400));
  console.log('N-CARDS:', (h.match(/Zum Stellenangebot/g) || []).length);
  h = await get('https://stellenangebotesaarland.de/stellenangebot-transportmitarbeiter-saarland/');
  console.log('DETAIL-LD:', ld(h));
  console.log('DETAIL-DATES:', [...h.matchAll(/(article:(?:published|modified)_time|datePublished|dateModified)[^>]{0,80}/g)].map((m) => m[0]).slice(0, 4).join(' | '));

  // Wochenspiegel Job-Spiegel
  h = await get('https://www.wochenspiegelonline.de/anzeigen/job-spiegel');
  console.log('TEXT:', flat(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).slice(600, 3500));
  console.log('LINKS:', [...new Set([...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))].filter((l) => /job|anzeige|stelle|pdf|wospi/i.test(l)).slice(0, 60).join(' | '));
} catch (err) {
  console.log('ERROR', err.message);
}
