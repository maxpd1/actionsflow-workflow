// Temporär: untersucht die Bewerberportale von adesso (SuccessFactors) und juris (softgarden).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const flat = (s) => s.replace(/\s+/g, ' ');
const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' }, signal: AbortSignal.timeout(30000) });
  const html = await res.text();
  console.log(`\n==================== ${url}\nstatus ${res.status} final ${res.url} len ${html.length} type ${res.headers.get('content-type')}`);
  return html;
};
const around = (h, re, b = 200, a = 2500) => { const i = h.search(re); return i < 0 ? '(nicht gefunden)' : flat(h.slice(Math.max(0, i - b), i + a)); };
const tryit = async (fn) => { try { await fn(); } catch (e) { console.log('ERROR', e.message); } };

await tryit(async () => {
  const h = await get('https://jobs.adesso-group.com/search/?q=&locationsearch=Saarbr%C3%BCcken&locale=de_DE');
  console.log('ROWS:', (h.match(/class="data-row/g) || []).length, 'pagination:', around(h, /paginationLabel|pagination-label|Ergebnisse \d/i, 50, 300));
  console.log('ROW:', around(h, /class="data-row/, 50, 2500));
});
await tryit(async () => {
  const h = await get('https://jobs.adesso-group.com/services/rss/job/?locale=de_DE&keywords=(Saarbr%C3%BCcken)');
  console.log('ITEMS:', (h.match(/<item>/g) || []).length); console.log('XML:', flat(h.slice(0, 3000)));
});
await tryit(async () => {
  const h = await get('https://juris.softgarden.io/');
  const links = [...new Set([...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
  console.log('LINKS:', links.filter((l) => /job|vacanc|stelle/i.test(l)).slice(0, 40).join(' | '));
  console.log('API-ISH:', [...new Set([...h.matchAll(/["']([^"'\s]*(?:api|json|widget|rss|feed)[^"'\s]*)["']/gi)].map((m) => m[1]))].slice(0, 30).join(' | '));
  console.log('LIST:', around(h, /matchElement|job-title|jobTitle|class="[^"]*job/i, 200, 3000));
  console.log('LD:', [...h.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => flat(m[1]).slice(0, 500)).join(' || '));
});
await tryit(async () => {
  const h = await get('https://juris.softgarden.io/de/vacancies');
  console.log('LIST:', around(h, /\/job\/\d+/, 1500, 2500));
});
