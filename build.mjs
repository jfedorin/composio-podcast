/* ─────────────────────────────────────────────────────────────────────────
   Agents at Work — static SEO builder
   Generates one transcript/blog page per episode + sitemap.xml + robots.txt.

   Run:  node build.mjs
   - Reads episode data straight from index.html (single source of truth).
   - Pulls each episode's YouTube auto-transcript with yt-dlp and caches the
     cleaned text in transcripts/<videoId>.txt (so re-runs are instant and
     you can hand-edit a transcript file to fix wording).
   - Writes episodes/<slug>/index.html, sitemap.xml, robots.txt.

   If you get a custom domain later, change SITE below and re-run.
   ───────────────────────────────────────────────────────────────────────── */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'https://agents-at-work-site.vercel.app';   // ← update if you add a custom domain
const YT_DLP = process.env.YT_DLP || 'yt-dlp';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slugify = s => String(s).toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const epSlug = e => (slugify(`${e.guest} ${e.company || ''}`) || `episode-${e.number}`);

/* ── read EPISODES + LINKS from index.html ──────────────────────────────── */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const dataScript = scripts.find(s => s.includes('const EPISODES'));
if (!dataScript) { console.error('ERROR: could not find EPISODES in index.html'); process.exit(1); }
const { EPISODES, LINKS } = new Function(dataScript + '\nreturn { EPISODES, LINKS };')();

/* ── transcript helpers ─────────────────────────────────────────────────── */
/* YouTube's VTT escapes characters (e.g. ">" as "&gt;"). Decode them here, or the
   page template escapes the "&" a second time and readers literally see "&gt;". */
const decodeEntities = s => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');   // must run last

function vttToText(vtt) {
  const out = [];
  for (let line of vtt.split(/\r?\n/)) {
    if (!line) continue;
    if (/^(WEBVTT|Kind:|Language:|NOTE)/.test(line)) continue;
    if (line.includes('-->')) continue;
    if (line.includes('<')) continue;   // animated/duplicated caption line (carries <c> tags).
                                        // Checked BEFORE decoding, so "&lt;" can't trip it.
    line = decodeEntities(line)
      .replace(/\[[^\]]*\]/g, ' ')   // [music], [applause], …
      .replace(/>>+/g, ' ')          // YouTube's speaker-change marker: scattered unreliably
                                     // (often mid-sentence), so drop it rather than break on it
      .replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (out.length && out[out.length - 1] === line) continue;  // dedupe consecutive repeats
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
function paragraphs(text) {
  const sents = text.replace(/>>+/g, ' ').replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  const paras = [];
  for (let i = 0; i < sents.length; i += 4) paras.push(sents.slice(i, i + 4).join('').trim());
  return paras.filter(Boolean);
}
function getTranscript(e) {
  if (!e.youtubeId) return null;
  const cacheDir = path.join(ROOT, 'transcripts');
  const cache = path.join(cacheDir, e.youtubeId + '.txt');
  if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8').trim() || null;
  const tmp = path.join(cacheDir, '_tmp');
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
    execFileSync(YT_DLP, ['--write-auto-subs', '--sub-langs', 'en.*', '--sub-format', 'vtt',
      '--skip-download', '-o', path.join(tmp, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${e.youtubeId}`], { stdio: 'ignore' });
    const files = fs.readdirSync(tmp).filter(f => f.startsWith(e.youtubeId) && f.endsWith('.vtt'));
    if (!files.length) throw new Error('no captions available');
    const pick = files.find(f => /\.en\.vtt$/.test(f)) || files.sort()[0];
    const text = vttToText(fs.readFileSync(path.join(tmp, pick), 'utf8'));
    fs.writeFileSync(cache, text);
    for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
    return text || null;
  } catch (err) {
    console.error(`  ⚠ transcript unavailable for EP.${e.number} (${e.youtubeId}): ${err.message}`);
    return null;
  }
}

/* ── date + duration → machine formats for schema ───────────────────────── */
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function isoDate(d) {
  const m = /([a-z]{3})[a-z]*\s+(\d{4})/i.exec(d || '');
  return m ? `${m[2]}-${MONTHS[m[1].toLowerCase()] || '01'}-01` : '';
}
function isoDuration(d) {
  if (!d) return '';
  const p = d.split(':').map(Number);
  const [h, m, s] = p.length === 3 ? p : [0, p[0], p[1]];
  return `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${s ? s + 'S' : ''}` || '';
}

/* ── page template ──────────────────────────────────────────────────────── */
function episodePage(e, transcript) {
  const slug = epSlug(e);
  const url = `${SITE}/episodes/${slug}/`;
  const pageTitle = `${e.title} — ${e.guest}${e.company ? ', ' + e.company : ''} | Agents at Work`;
  const desc = e.blurb || `${e.guest} on Agents at Work, the Composio founder podcast.`;
  const ogImg = e.youtubeId ? `https://img.youtube.com/vi/${e.youtubeId}/maxresdefault.jpg` : `${SITE}/cover.jpg`;
  const watch = e.youtubeId ? `https://www.youtube.com/watch?v=${e.youtubeId}` : '';
  const spotify = e.spotifyId ? `https://open.spotify.com/episode/${e.spotifyId}` : '';

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'PodcastEpisode',
    url, name: e.title,
    episodeNumber: e.number,
    ...(isoDate(e.date) ? { datePublished: isoDate(e.date) } : {}),
    ...(isoDuration(e.duration) ? { timeRequired: isoDuration(e.duration) } : {}),
    description: desc,
    partOfSeries: { '@type': 'PodcastSeries', name: 'Agents at Work', url: SITE },
    ...(e.youtubeId ? {
      associatedMedia: {
        '@type': 'VideoObject', name: e.title, description: desc,
        thumbnailUrl: ogImg, embedUrl: `https://www.youtube.com/embed/${e.youtubeId}`,
        ...(isoDate(e.date) ? { uploadDate: isoDate(e.date) } : {})
      }
    } : {})
  };

  const transcriptHtml = transcript
    ? paragraphs(transcript).map(p => `<p>${esc(p)}</p>`).join('\n        ')
    : `<p class="muted">Transcript coming soon — check back shortly, or watch the full conversation above.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(e.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ogImg}">
<meta property="og:site_name" content="Agents at Work">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="@juliafedorin">
<meta name="theme-color" content="#0005FD">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>
  :root{--blue:#0005FD;--blue-deep:#0004C9;--green:#83FD00;--white:#FFF;--dim:rgba(255,255,255,.68);--line:rgba(255,255,255,.28);--serif:'Instrument Serif',Georgia,serif;--sans:'Inter',system-ui,sans-serif;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--blue);color:var(--white);font-family:var(--sans);font-size:17px;line-height:1.7;-webkit-font-smoothing:antialiased;}
  a{color:var(--green);}
  ::selection{background:var(--green);color:#000;}
  .wrap{max-width:760px;margin:0 auto;padding:0 24px;}
  header{border-bottom:1px solid var(--line);}
  .bar{display:flex;align-items:center;justify-content:space-between;padding:14px 0;}
  .mark{font-family:var(--serif);font-size:22px;color:var(--white);text-decoration:none;}
  .mark em{font-style:italic;color:var(--green);}
  .back{font-size:13px;color:var(--dim);text-decoration:none;}
  .back:hover{color:var(--green);}
  article{padding:44px 0 72px;}
  .kicker{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--green);}
  h1{font-family:var(--serif);font-weight:400;font-size:clamp(30px,5vw,48px);line-height:1.05;margin:14px 0 14px;}
  .meta{color:var(--dim);font-size:14px;margin-bottom:22px;}
  .meta b{color:var(--white);}
  .video{position:relative;aspect-ratio:16/9;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#000;margin:0 0 20px;}
  .video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
  .listen{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 34px;}
  .btn{font-weight:700;font-size:13px;text-decoration:none;padding:10px 16px;border-radius:99px;border:1px solid var(--green);color:var(--white);}
  .btn.primary{background:var(--green);color:#000;}
  .btn:hover{border-color:var(--white);}
  .lede{font-size:19px;color:var(--white);border-left:2px solid var(--green);padding-left:16px;margin:0 0 34px;}
  .t-head{font-family:var(--serif);font-style:italic;font-size:24px;border-top:1px solid var(--line);padding-top:22px;margin:0 0 18px;}
  .transcript p{margin:0 0 18px;color:rgba(255,255,255,.9);}
  .muted{color:var(--dim);}
  footer{border-top:1px solid var(--line);padding:26px 0 60px;color:var(--dim);font-size:13px;}
  footer a{color:var(--green);}
</style>
</head>
<body>
<header>
  <div class="wrap bar">
    <a class="mark" href="/">Agents <em>at</em> Work</a>
    <a class="back" href="/">← All episodes</a>
  </div>
</header>
<main class="wrap">
  <article>
    <p class="kicker">Episode ${String(e.number).padStart(2, '0')}${e.date ? ' · ' + esc(e.date) : ''}${e.duration ? ' · ' + esc(e.duration) : ''}</p>
    <h1>${esc(e.title)}</h1>
    <p class="meta">with <b>${esc(e.guest)}</b>${e.company ? ' · ' + esc(e.company) : ''}</p>
    ${e.youtubeId ? `<div class="video"><iframe src="https://www.youtube.com/embed/${e.youtubeId}" title="${esc(e.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>` : ''}
    <div class="listen">
      ${watch ? `<a class="btn primary" href="${watch}" target="_blank" rel="noopener">▶ Watch on YouTube</a>` : ''}
      ${spotify ? `<a class="btn" href="${spotify}" target="_blank" rel="noopener">Listen on Spotify</a>` : ''}
      ${e.xUrl ? `<a class="btn" href="${esc(e.xUrl)}" target="_blank" rel="noopener">On X</a>` : ''}
    </div>
    <p class="lede">${esc(desc)}</p>
    <h2 class="t-head">Transcript</h2>
    <div class="transcript">
        ${transcriptHtml}
    </div>
  </article>
</main>
<footer>
  <div class="wrap">
    <p><b>Agents at Work</b> — Composio's founder podcast, hosted by <a href="https://x.com/juliafedorin" target="_blank" rel="noopener">Julia Fedorin</a>. <a href="/">Browse all episodes →</a></p>
    <p style="margin-top:8px">Transcript auto-generated from the episode audio and may contain small errors.</p>
  </div>
</footer>
</body>
</html>`;
}

/* ── build ──────────────────────────────────────────────────────────────── */
console.log(`Building ${EPISODES.length} episode pages…`);
const eps = [...EPISODES].sort((a, b) => b.number - a.number);
const built = [];
for (const e of eps) {
  const slug = epSlug(e);
  const transcript = getTranscript(e);
  const dir = path.join(ROOT, 'episodes', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), episodePage(e, transcript));
  const words = transcript ? transcript.split(/\s+/).length : 0;
  built.push({ slug, number: e.number, date: e.date });
  console.log(`  ✓ /episodes/${slug}/  (${words ? words + ' words' : 'no transcript yet'})`);
}

/* sitemap + robots */
const today = fs.statSync(path.join(ROOT, 'index.html')).mtime.toISOString().slice(0, 10);
const urls = [
  { loc: `${SITE}/`, pri: '1.0' },
  ...built.map(b => ({ loc: `${SITE}/episodes/${b.slug}/`, pri: '0.8' }))
];
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.pri}</priority></url>`).join('\n') +
  `\n</urlset>\n`);
fs.writeFileSync(path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`\nWrote ${built.length} pages + sitemap.xml (${urls.length} urls) + robots.txt`);
