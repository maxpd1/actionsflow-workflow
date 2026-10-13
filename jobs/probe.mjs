// Temporär: untersucht regionale Jobbörsen, um passende Parser zu schreiben.
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://www.salue.de/jobs/',
  'https://saarbruecker-zeitung.stellenanzeigen.de/',
  'https://saarbruecker-zeitung.stellenanzeigen.de/jobs/?where=66793&radius=50',
  'https://stellenangebotesaarland.de/',
  'https://stellenangebotesaarland.de/stellenanzeigen-im-saarland/',
  'https://www.wochenspiegelonline.de/anzeigen/kombianzeigen-job-spiegel',
  'https://www.wochenspiegelonline.de/anzeigen',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
for (const url of urls) {
  console.log('\n==================== ' + url);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' }, signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    console.log('status', res.status, 'final', res.url, 'len', html.length, 'type', res.headers.get('content-type'));
    console.log('title:', (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim());
    const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    console.log('json-ld blocks:', ld.length, ld.map((x) => x.slice(0, 300).replace(/\s+/g, ' ')).join(' || '));
    const links = [...new Set([...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]))];
    console.log('job-links:', links.filter((l) => /job|stelle|karriere|anzeige|markt/i.test(l)).slice(0, 60).join('\n  '));
    console.log('iframes:', [...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]).join(' | '));
    console.log('scripts:', [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]).filter((s) => !/google|facebook|cookie|consent|analytics|gtm/i.test(s)).slice(0, 25).join(' | '));
    const api = [...new Set([...html.matchAll(/["'](\/?[^"'\s]*(?:api|ajax|json|search|suche)[^"'\s]*)["']/gi)].map((m) => m[1]))].slice(0, 30);
    console.log('api-ish:', api.join(' | '));
    if (/xml|rss/.test(res.headers.get('content-type') || '') || /json/.test(res.headers.get('content-type') || '')) console.log('BODY:', html.slice(0, 3000));
    const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map((m) => m[0].replace(/\s+/g, ' ').slice(0, 1500));
    console.log('FORMS:', forms.join('\n  ---\n  '));
    console.log('ALL-LINKS:', links.filter((l) => !/\.(css|js|png|jpg|svg|ico|woff2?)(\?|$)/i.test(l)).slice(0, 150).join(' | '));
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const ti = text.search(/(m\/w\/d|w\/m\/d|Stellenangebot|Job)/);
    console.log('TEXT:', text.slice(Math.max(0, ti - 300), ti + 2500));
    console.log('table rows:', (html.match(/<tr/gi) || []).length, 'pdf links:', (html.match(/uploads\/pdf/gi) || []).length);
    // erstes Job-Listing-Fragment zeigen
    const i = html.search(/class="[^"]*(job|stelle|offer|listing)[^"]*"/i);
    if (i > 0) console.log('FRAGMENT:', html.slice(i - 200, i + 2500).replace(/\s+/g, ' '));
  } catch (err) {
    console.log('ERROR', err.message);
  }
}
