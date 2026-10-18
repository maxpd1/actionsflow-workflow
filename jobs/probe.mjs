// Temporär: untersucht die Karriereseiten von juris und adesso.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const urls = [
  'https://www.juris.de/karriere', 'https://www.juris.de/jobs', 'https://karriere.juris.de/',
  'https://www.adesso.de/de/jobs-karriere/', 'https://www.adesso.de/de/jobs-karriere/unsere-stellenangebote/index.jsp',
  'https://jobs.adesso-group.com/', 'https://www.adesso.de/de/jobs-karriere/jobs/',
];
const flat = (s) => s.replace(/\s+/g, ' ');
for (const url of urls) {
  console.log('\n==================== ' + url);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' }, signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    console.log('status', res.status, 'final', res.url, 'len', html.length, 'type', res.headers.get('content-type'));
    console.log('title:', (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim());
    const links = [...new Set([...html.matchAll(/(?:href|src|data-src|data-url|action)="([^"]+)"/gi)].map((m) => m[1]))];
    console.log('JOB-LINKS:', links.filter((l) => /job|stelle|karriere|career|bewerb|personio|softgarden|rexx|dvinci|smartrecruit|workday|onlyfy|prescreen|greenhouse|lever|recruit|talent/i.test(l)).slice(0, 80).join('\n  '));
    console.log('SCRIPTS:', [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]).filter((s) => !/google|facebook|consent|analytics|gtm|usercentrics|cookie/i.test(s)).slice(0, 30).join(' | '));
    console.log('IFRAMES:', [...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]).join(' | '));
    console.log('API-ISH:', [...new Set([...html.matchAll(/["'(]((?:https?:)?\/?[^"'\s()]*(?:api|ajax|json|feed|xml|search|widget|embed)[^"'\s()]*)["')]/gi)].map((m) => m[1]))].slice(0, 40).join(' | '));
    const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => flat(m[1]).slice(0, 400));
    console.log('LD:', ld.join(' || '));
    const text = flat(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
    const i = text.search(/m\/w\/d|w\/m\/d|all genders|Stellenangebot|offene Stellen/i);
    console.log('TEXT:', text.slice(Math.max(0, i - 300), i + 1500));
  } catch (err) { console.log('ERROR', err.message); }
}
