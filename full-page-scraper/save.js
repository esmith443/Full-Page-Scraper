const params = new URLSearchParams(location.search);
const tabId = parseInt(params.get('tabId'), 10);
const pageUrl = params.get('pageUrl') || '';
const pageTitle = params.get('title') || 'page';

document.getElementById('pageInfo').textContent = `${pageTitle} — ${pageUrl}`;

const logEl = document.getElementById('log');
const summaryEl = document.getElementById('summary');
const startBtn = document.getElementById('startBtn');

function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const FONT_EXT = ['woff2', 'woff', 'ttf', 'otf', 'eot'];
const MEDIA_EXT = ['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'];
const ASSET_EXT_RE = /(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|m4a)/i;

// Bundlers (Vite/webpack) often reference logos, icons, and fonts as plain string
// literals inside compiled JS rather than in the HTML/CSS - e.g. a hashed asset
// filename baked in by the build. Pull those out so they don't get missed entirely.
function harvestJsAssetUrls(jsText, baseUrl) {
  const found = new Set();
  const re = /["'`]([^"'`\s]+\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|m4a))(?:[?#][^"'`]*)?["'`]/gi;
  let m;
  while ((m = re.exec(jsText))) {
    const raw = m[1];
    if (raw.startsWith('data:') || raw.length > 300) continue;
    try { found.add(new URL(raw, baseUrl).href); } catch (e) {}
  }
  return [...found];
}

function extOf(url) {
  try {
    const clean = url.split('?')[0].split('#')[0];
    const m = clean.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  } catch (e) { return ''; }
}

function extractCssRefs(cssText, baseUrl) {
  const refs = [];
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m;
  while ((m = urlRe.exec(cssText))) {
    const raw = m[2];
    if (raw.startsWith('data:')) continue;
    try { refs.push(new URL(raw, baseUrl).href); } catch (e) {}
  }
  const importRe = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/g;
  const imports = [];
  while ((m = importRe.exec(cssText))) {
    const raw = m[1] || m[2];
    if (!raw) continue;
    try { imports.push(new URL(raw, baseUrl).href); } catch (e) {}
  }
  return { refs, imports };
}

// Rewrites url(...) references in CSS text to local paths using the urlToLocal map.
// `prefix` is prepended to each local path (e.g. "../" when the CSS file lives in css/).
function rewriteCssUrls(cssText, baseUrl, urlToLocal, prefix) {
  return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, raw) => {
    if (raw.startsWith('data:')) return match;
    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch (e) { return match; }
    const local = urlToLocal.get(abs);
    if (local) return `url("${prefix}${local}")`;
    return `url("${abs}")`;
  });
}

function rewriteCssImports(cssText, baseUrl, urlToLocal) {
  return cssText.replace(/@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/g, (match, q1, raw1, q3, raw2) => {
    const raw = raw1 || raw2;
    if (!raw) return match;
    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch (e) { return match; }
    const local = urlToLocal.get(abs);
    if (local) {
      const filename = local.replace(/^css\//, '');
      return `@import url("${filename}")`;
    }
    return match;
  });
}

// Injected into the target page. Must be self-contained.
function scrapeFunc() {
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (e) { return null; } };

  const html = document.documentElement.outerHTML;

  const inlineCss = [];
  const externalCss = [];
  document.querySelectorAll('style').forEach(s => { if (s.textContent.trim()) inlineCss.push(s.textContent); });
  document.querySelectorAll('link[rel~="stylesheet"]').forEach(l => {
    const u = abs(l.href);
    if (u) externalCss.push(u);
  });

  const inlineJs = [];
  const externalJs = [];
  document.querySelectorAll('script').forEach(s => {
    if (s.src) {
      const u = abs(s.src);
      if (u) externalJs.push(u);
    } else if (s.textContent.trim()) {
      inlineJs.push(s.textContent);
    }
  });

  const images = new Set();
  document.querySelectorAll('img[src]').forEach(img => { const u = abs(img.currentSrc || img.getAttribute('src')); if (u) images.add(u); });
  document.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
    el.getAttribute('srcset').split(',').forEach(part => {
      const u = abs(part.trim().split(/\s+/)[0]);
      if (u) images.add(u);
    });
  });
  const collectBg = (styleDecl) => {
    const bg = styleDecl.backgroundImage;
    if (bg && bg !== 'none') {
      const matches = bg.matchAll(/url\(["']?([^"')]+)["']?\)/g);
      for (const mm of matches) {
        if (mm[1].startsWith('data:')) continue;
        const u = abs(mm[1]);
        if (u) images.add(u);
      }
    }
  };
  document.querySelectorAll('*').forEach(el => {
    collectBg(getComputedStyle(el));
    // Custom checkboxes/icons are very often drawn via ::before/::after rather
    // than on the element itself - these are invisible to a plain DOM scan.
    try { collectBg(getComputedStyle(el, '::before')); } catch (e) {}
    try { collectBg(getComputedStyle(el, '::after')); } catch (e) {}
  });

  // Constructable stylesheets (document.adoptedStyleSheets) don't show up as
  // <style> or <link> tags at all, so pull their rule text in separately.
  const adoptedCss = [];
  try {
    (document.adoptedStyleSheets || []).forEach(sheet => {
      try {
        const text = Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
        if (text.trim()) adoptedCss.push(text);
      } catch (e) {}
    });
  } catch (e) {}
  document.querySelectorAll('svg image, use').forEach(el => {
    const href = el.getAttribute('href') || el.getAttribute('xlink:href');
    if (href) { const u = abs(href); if (u) images.add(u); }
  });

  const media = { video: new Set(), audio: new Set() };
  document.querySelectorAll('video').forEach(v => {
    if (v.src) { const u = abs(v.src); if (u) media.video.add(u); }
    v.querySelectorAll('source[src]').forEach(s => { const u = abs(s.src); if (u) media.video.add(u); });
    if (v.poster) { const u = abs(v.poster); if (u) images.add(u); }
  });
  document.querySelectorAll('audio').forEach(a => {
    if (a.src) { const u = abs(a.src); if (u) media.audio.add(u); }
    a.querySelectorAll('source[src]').forEach(s => { const u = abs(s.src); if (u) media.audio.add(u); });
  });

  const icons = new Set();
  document.querySelectorAll('link[rel*="icon"]').forEach(l => { const u = abs(l.href); if (u) icons.add(u); });
  const manifestLink = document.querySelector('link[rel="manifest"]');
  const manifestUrl = manifestLink ? abs(manifestLink.href) : null;
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  const themeColor = themeColorMeta ? themeColorMeta.getAttribute('content') : null;
  const msTile = document.querySelector('meta[name="msapplication-TileImage"]');
  if (msTile) { const u = abs(msTile.getAttribute('content')); if (u) icons.add(u); }

  const fontPreloads = new Set();
  document.querySelectorAll('link[rel="preload"][as="font"]').forEach(l => { const u = abs(l.href); if (u) fontPreloads.add(u); });

  const iframes = Array.from(document.querySelectorAll('iframe[src]')).map(f => abs(f.getAttribute('src'))).filter(Boolean);

  const meta = {};
  document.querySelectorAll('meta').forEach(m => {
    const key = m.getAttribute('name') || m.getAttribute('property');
    if (key) meta[key] = m.getAttribute('content');
  });

  const links = Array.from(document.querySelectorAll('a[href]')).map(a => abs(a.getAttribute('href'))).filter(Boolean);

  // --- Data for the AI context file ---
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
    level: parseInt(h.tagName.slice(1), 10),
    text: h.textContent.trim().replace(/\s+/g, ' ').slice(0, 150),
  })).filter(h => h.text);

  const forms = Array.from(document.querySelectorAll('form')).slice(0, 20).map(f => ({
    action: f.getAttribute('action') || null,
    method: (f.getAttribute('method') || 'get').toUpperCase(),
    fields: Array.from(f.querySelectorAll('input,select,textarea')).slice(0, 30).map(el => ({
      name: el.name || el.id || null,
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.placeholder || null,
      required: el.required || false,
    })),
  }));

  const buttons = [...new Set(
    Array.from(document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]'))
      .map(b => (b.textContent || b.value || '').trim().replace(/\s+/g, ' '))
      .filter(t => t && t.length < 60)
  )].slice(0, 40);

  const navLinks = [...new Map(
    Array.from(document.querySelectorAll('nav a, header a'))
      .map(a => [a.textContent.trim(), abs(a.getAttribute('href'))])
      .filter(([text]) => text && text.length < 60)
  )].slice(0, 40).map(([text, href]) => ({ text, href }));

  const bodyStyle = getComputedStyle(document.body);
  const primaryBtn = document.querySelector('button, .btn-primary, [class*="primary"]');
  const heading1 = document.querySelector('h1');
  const colors = {
    bodyBackground: bodyStyle.backgroundColor,
    bodyText: bodyStyle.color,
    accent: primaryBtn ? getComputedStyle(primaryBtn).backgroundColor : null,
  };
  const fonts = {
    body: bodyStyle.fontFamily,
    heading: heading1 ? getComputedStyle(heading1).fontFamily : null,
  };

  let visibleText = document.body.innerText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const textTruncated = visibleText.length > 4000;
  if (textTruncated) visibleText = visibleText.slice(0, 4000);

  return {
    url: location.href,
    title: document.title,
    html,
    css: { inline: [...inlineCss, ...adoptedCss], external: [...new Set(externalCss)] },
    js: { inline: inlineJs, external: [...new Set(externalJs)] },
    images: [...images],
    media: { video: [...media.video], audio: [...media.audio] },
    icons: [...icons],
    manifestUrl,
    themeColor,
    fontPreloads: [...fontPreloads],
    iframes,
    meta,
    links: [...new Set(links)],
    aiContext: { headings, forms, buttons, navLinks, colors, fonts, visibleText, textTruncated },
  };
}

const usedNames = { css: new Set(), js: new Set(), images: new Set(), fonts: new Set(), icons: new Set(), media: new Set() };

function baseName(str, fallback) {
  if (!str) return fallback;
  try {
    const u = new URL(str);
    let base = u.pathname.split('/').filter(Boolean).pop() || fallback;
    base = base.split('?')[0].split('#')[0];
    return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || fallback;
  } catch (e) {
    return fallback;
  }
}

// Returns a filename guaranteed not to collide with another asset already saved in this folder.
function uniqueName(folder, desired) {
  const used = usedNames[folder];
  if (!used.has(desired)) { used.add(desired); return desired; }
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  let i = 2;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) { i++; candidate = `${stem}-${i}${ext}`; }
  used.add(candidate);
  return candidate;
}

async function getSubDir(rootHandle, name) {
  return rootHandle.getDirectoryHandle(name, { create: true });
}

async function writeText(dirHandle, filename, content) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function writeBinary(dirHandle, filename, blob) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function fetchBlob(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}

// Downloads a binary asset into fonts/, images/, or media/ based on extension and records its local path.
async function downloadAsset(url, seen, fontsDir, imagesDir, mediaDir, counters, urlToLocal) {
  if (seen.has(url)) return;
  seen.add(url);
  const ext = extOf(url);
  let folder, dir;
  if (FONT_EXT.includes(ext)) { folder = 'fonts'; dir = fontsDir; }
  else if (MEDIA_EXT.includes(ext)) { folder = 'media'; dir = mediaDir; }
  else { folder = 'images'; dir = imagesDir; }
  if (!dir) return;
  const name = uniqueName(folder, baseName(url, `asset-${seen.size}.${ext || 'bin'}`));
  try {
    const blob = await fetchBlob(url);
    await writeBinary(dir, name, blob);
    urlToLocal.set(url, `${folder}/${name}`);
    log(`${folder}/${name} saved  <-  ${url}`, 'ok');
    counters.ok++;
  } catch (e) {
    log(`${folder}/${name} FAILED (${e.message})`, 'fail');
    counters.fail++;
  }
}

// Fetches a CSS file, recursively pulls its url()/@import assets, rewrites references to local
// paths, then writes the final file. Registers its own local path in urlToLocal before recursing
// so @import cycles or repeat references resolve correctly.
async function processCss(url, cssDir, fontsDir, imagesDir, mediaDir, seenCss, seenAssets, counters, depth, urlToLocal) {
  if (seenCss.has(url) || depth > 3) return;
  seenCss.add(url);
  const name = uniqueName('css', baseName(url, `external-${seenCss.size}.css`));
  urlToLocal.set(url, `css/${name}`);

  let text;
  try {
    text = await fetchText(url);
  } catch (e) {
    await writeText(cssDir, name + '.url.txt', url);
    log(`css/${name} FAILED (${e.message}) - saved source URL instead`, 'fail');
    counters.fail++;
    return;
  }

  const { refs, imports } = extractCssRefs(text, url);
  for (const ref of refs) {
    await downloadAsset(ref, seenAssets, fontsDir, imagesDir, mediaDir, counters, urlToLocal);
  }
  for (const imp of imports) {
    await processCss(imp, cssDir, fontsDir, imagesDir, mediaDir, seenCss, seenAssets, counters, depth + 1, urlToLocal);
  }

  let finalText = rewriteCssUrls(text, url, urlToLocal, '../');
  finalText = rewriteCssImports(finalText, url, urlToLocal);
  await writeText(cssDir, name, finalText);
  log(`css/${name} saved  <-  ${url}`, 'ok');
  counters.ok++;
}

const TECH_KEYWORDS = {
  'react': 'React', 'next': 'Next.js', 'nuxt': 'Nuxt.js', 'vue': 'Vue.js',
  'angular': 'Angular', 'svelte': 'Svelte', 'jquery': 'jQuery',
  'bootstrap': 'Bootstrap', 'tailwind': 'Tailwind CSS',
  'vite': 'Vite (build tool)', 'webpack': 'Webpack (build tool)',
  'chart.js': 'Chart.js', 'chartist': 'Chartist', 'd3.': 'D3.js',
  'font-awesome': 'Font Awesome', 'fontawesome': 'Font Awesome',
  'glyphicon': 'Glyphicons', 'tinymce': 'TinyMCE editor', 'tiptap': 'Tiptap editor',
  'helpscout': 'HelpScout widget', 'sortable': 'SortableJS',
};

function detectTechStack(data) {
  const haystack = [data.html, ...data.css.external, ...data.js.external].join(' ').toLowerCase();
  const found = new Set();
  for (const [kw, label] of Object.entries(TECH_KEYWORDS)) {
    if (haystack.includes(kw)) found.add(label);
  }
  if (data.meta.generator) found.add(`Generator: ${data.meta.generator}`);
  return [...found];
}

function buildContextMarkdown(data, counters, savedFiles) {
  const c = data.aiContext;
  const lines = [];
  lines.push(`# Page Context: ${data.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **URL:** ${data.url}`);
  lines.push(`- **Scraped:** ${new Date().toISOString()}`);
  if (data.meta.description) lines.push(`- **Meta description:** ${data.meta.description}`);
  if (data.themeColor) lines.push(`- **Theme color:** ${data.themeColor}`);
  lines.push('');

  const stack = detectTechStack(data);
  lines.push('## Detected tech stack');
  lines.push(stack.length ? stack.map(s => `- ${s}`).join('\n') : '- Could not confidently detect (likely plain HTML/CSS/JS or heavily obfuscated).');
  lines.push('');

  lines.push('## Colors & fonts (as computed on the live page)');
  lines.push(`- Body background: \`${c.colors.bodyBackground}\``);
  lines.push(`- Body text: \`${c.colors.bodyText}\``);
  if (c.colors.accent) lines.push(`- Likely accent/button color: \`${c.colors.accent}\``);
  lines.push(`- Body font: \`${c.fonts.body}\``);
  if (c.fonts.heading) lines.push(`- Heading font: \`${c.fonts.heading}\``);
  lines.push('');

  lines.push('## Heading outline');
  if (c.headings.length) {
    c.headings.slice(0, 100).forEach(h => lines.push(`${'  '.repeat(h.level - 1)}- H${h.level}: ${h.text}`));
  } else {
    lines.push('- No headings found.');
  }
  lines.push('');

  if (c.navLinks.length) {
    lines.push('## Navigation links');
    c.navLinks.forEach(n => lines.push(`- [${n.text}](${n.href})`));
    lines.push('');
  }

  if (c.buttons.length) {
    lines.push('## Buttons / calls to action');
    c.buttons.forEach(b => lines.push(`- "${b}"`));
    lines.push('');
  }

  if (c.forms.length) {
    lines.push('## Forms');
    c.forms.forEach((f, i) => {
      lines.push(`### Form ${i + 1} (${f.method}${f.action ? ' -> ' + f.action : ''})`);
      f.fields.forEach(field => {
        lines.push(`- ${field.name || '(unnamed)'} — type: ${field.type}${field.placeholder ? `, placeholder: "${field.placeholder}"` : ''}${field.required ? ', required' : ''}`);
      });
    });
    lines.push('');
  }

  lines.push('## Visible page text' + (c.textTruncated ? ' (truncated to 4000 chars)' : ''));
  lines.push('```');
  lines.push(c.visibleText || '(no visible text captured)');
  lines.push('```');
  lines.push('');

  lines.push('## What was saved alongside this file');
  lines.push(savedFiles.map(f => `- ${f}`).join('\n'));
  lines.push('');

  lines.push('## Notes / limitations for whoever (or whatever) reads this');
  lines.push('- This is a snapshot of the page as it rendered at scrape time. Any content loaded dynamically after scroll, interaction, or a live API call (dashboards, feeds, search results) reflects only that one moment, not the current live state.');
  lines.push('- `index.html` has its live `<script>` tags removed by default so it displays as a static snapshot rather than trying (and failing) to re-fetch live data offline.');
  lines.push(`- Asset fetch results: ${counters.ok} saved, ${counters.fail} failed, ${counters.skipped} skipped (data URIs).`);

  return lines.join('\n');
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  logEl.innerHTML = '';
  summaryEl.textContent = '';
  Object.values(usedNames).forEach(s => s.clear());

  const opts = {
    html: document.getElementById('chkHtml').checked,
    css: document.getElementById('chkCss').checked,
    js: document.getElementById('chkJs').checked,
    img: document.getElementById('chkImg').checked,
    fonts: document.getElementById('chkFonts').checked,
    icons: document.getElementById('chkIcons').checked,
    media: document.getElementById('chkMedia').checked,
    manifest: document.getElementById('chkManifest').checked,
    rewrite: document.getElementById('chkRewrite').checked,
    stripScripts: document.getElementById('chkStripScripts').checked,
    context: document.getElementById('chkContext').checked,
  };

  let rootHandle;
  try {
    rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    log('Folder selection cancelled.', 'fail');
    startBtn.disabled = false;
    return;
  }

  log('Scraping page...', 'info');
  let data;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeFunc });
    data = result;
  } catch (e) {
    log('Could not scrape this tab: ' + e.message + ' (chrome:// pages and the Web Store are blocked by Chrome)', 'fail');
    startBtn.disabled = false;
    return;
  }

  const counters = { ok: 0, fail: 0, skipped: 0 };
  const seenAssets = new Set();
  const urlToLocal = new Map(); // absolute source URL -> root-relative local path

  const imagesDir = opts.img ? await getSubDir(rootHandle, 'images') : null;
  const fontsDir = opts.fonts ? await getSubDir(rootHandle, 'fonts') : null;
  const mediaDir = opts.media ? await getSubDir(rootHandle, 'media') : null;

  // CSS first, since it can reference images/fonts that other steps also need.
  if (opts.css) {
    const cssDir = await getSubDir(rootHandle, 'css');
    const seenCss = new Set();
    for (let i = 0; i < data.css.inline.length; i++) {
      const text = data.css.inline[i];
      const { refs } = extractCssRefs(text, data.url);
      for (const ref of refs) await downloadAsset(ref, seenAssets, fontsDir, imagesDir, mediaDir, counters, urlToLocal);
      const rewritten = rewriteCssUrls(text, data.url, urlToLocal, '');
      await writeText(cssDir, `inline-${i + 1}.css`, rewritten);
      log(`css/inline-${i + 1}.css saved`, 'ok'); counters.ok++;
    }
    for (const url of data.css.external) {
      await processCss(url, cssDir, fontsDir, imagesDir, mediaDir, seenCss, seenAssets, counters, 0, urlToLocal);
    }
  }

  if (opts.js) {
    const jsDir = await getSubDir(rootHandle, 'js');
    for (let i = 0; i < data.js.inline.length; i++) {
      await writeText(jsDir, `inline-${i + 1}.js`, data.js.inline[i]);
      log(`js/inline-${i + 1}.js saved`, 'ok'); counters.ok++;
      if (opts.img || opts.fonts || opts.media) {
        const found = harvestJsAssetUrls(data.js.inline[i], data.url);
        for (const assetUrl of found) await downloadAsset(assetUrl, seenAssets, fontsDir, imagesDir, mediaDir, counters, urlToLocal);
      }
    }
    for (const url of data.js.external) {
      const name = uniqueName('js', baseName(url, `external.js`));
      try {
        const text = await fetchText(url);
        await writeText(jsDir, name, text);
        urlToLocal.set(url, `js/${name}`);
        log(`js/${name} saved  <-  ${url}`, 'ok'); counters.ok++;
        if (opts.img || opts.fonts || opts.media) {
          const found = harvestJsAssetUrls(text, url);
          for (const assetUrl of found) await downloadAsset(assetUrl, seenAssets, fontsDir, imagesDir, mediaDir, counters, urlToLocal);
        }
      } catch (e) {
        await writeText(jsDir, name + '.url.txt', url);
        log(`js/${name} FAILED (${e.message}) - saved source URL instead`, 'fail'); counters.fail++;
      }
    }
  }

  if (opts.img) {
    for (const url of data.images) {
      if (url.startsWith('data:')) { counters.skipped++; continue; }
      await downloadAsset(url, seenAssets, fontsDir, imagesDir, mediaDir, counters, urlToLocal);
    }
  }

  if (opts.fonts) {
    for (const url of data.fontPreloads) {
      await downloadAsset(url, seenAssets, fontsDir, imagesDir, mediaDir, counters, urlToLocal);
    }
  }

  if (opts.media) {
    const mediaUrls = [...data.media.video, ...data.media.audio];
    for (const url of mediaUrls) {
      if (seenAssets.has(url)) continue;
      seenAssets.add(url);
      const name = uniqueName('media', baseName(url, `media-${counters.ok + counters.fail}`));
      try {
        const blob = await fetchBlob(url);
        await writeBinary(mediaDir, name, blob);
        urlToLocal.set(url, `media/${name}`);
        log(`media/${name} saved  <-  ${url}`, 'ok'); counters.ok++;
      } catch (e) {
        log(`media/${name} FAILED (${e.message})`, 'fail'); counters.fail++;
      }
    }
  }

  if (opts.icons) {
    const iconsDir = data.icons.length ? await getSubDir(rootHandle, 'icons') : null;
    for (const url of data.icons) {
      if (urlToLocal.has(url)) continue;
      const name = uniqueName('icons', baseName(url, `icon-${counters.ok + counters.fail}`));
      try {
        const blob = await fetchBlob(url);
        await writeBinary(iconsDir, name, blob);
        urlToLocal.set(url, `icons/${name}`);
        log(`icons/${name} saved  <-  ${url}`, 'ok'); counters.ok++;
      } catch (e) {
        log(`icons/${name} FAILED (${e.message})`, 'fail'); counters.fail++;
      }
    }
    if (!data.icons.length) {
      try {
        const fallback = new URL('/favicon.ico', data.url).href;
        const blob = await fetchBlob(fallback);
        const dir = await getSubDir(rootHandle, 'icons');
        await writeBinary(dir, 'favicon.ico', blob);
        urlToLocal.set(fallback, 'icons/favicon.ico');
        log(`icons/favicon.ico saved  <-  ${fallback}`, 'ok'); counters.ok++;
      } catch (e) { /* no favicon.ico, fine */ }
    }
  }

  let manifestSaved = false;
  if (opts.manifest && data.manifestUrl) {
    try {
      const text = await fetchText(data.manifestUrl);
      await writeText(rootHandle, 'manifest.webmanifest', text);
      urlToLocal.set(data.manifestUrl, 'manifest.webmanifest');
      manifestSaved = true;
      log(`manifest.webmanifest saved  <-  ${data.manifestUrl}`, 'ok'); counters.ok++;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.icons)) {
          const iconsDir = await getSubDir(rootHandle, 'icons');
          for (const icon of parsed.icons) {
            if (!icon.src) continue;
            const iconUrl = new URL(icon.src, data.manifestUrl).href;
            if (urlToLocal.has(iconUrl)) continue;
            const name = uniqueName('icons', baseName(iconUrl, `manifest-icon-${counters.ok}`));
            try {
              const blob = await fetchBlob(iconUrl);
              await writeBinary(iconsDir, name, blob);
              urlToLocal.set(iconUrl, `icons/${name}`);
              log(`icons/${name} saved  <-  ${iconUrl}`, 'ok'); counters.ok++;
            } catch (e) {
              log(`icons/${name} FAILED (${e.message})`, 'fail'); counters.fail++;
            }
          }
        }
      } catch (e) { /* not valid JSON, skip icon extraction */ }
    } catch (e) {
      log(`manifest.webmanifest FAILED (${e.message})`, 'fail'); counters.fail++;
    }
  }

  // Build the final index.html, rewriting references to local files if requested.
  if (opts.html) {
    let finalHtml = data.html;
    if (opts.rewrite) {
      const doc = new DOMParser().parseFromString(data.html, 'text/html');

      doc.querySelectorAll('link[rel~="stylesheet"]').forEach(l => {
        try {
          const abs = new URL(l.getAttribute('href'), data.url).href;
          const local = urlToLocal.get(abs);
          if (local) l.setAttribute('href', local);
        } catch (e) {}
      });

      doc.querySelectorAll('script[src]').forEach(s => {
        try {
          const abs = new URL(s.getAttribute('src'), data.url).href;
          const local = urlToLocal.get(abs);
          if (local) s.setAttribute('src', local);
        } catch (e) {}
      });

      doc.querySelectorAll('style').forEach(s => {
        s.textContent = rewriteCssUrls(s.textContent, data.url, urlToLocal, '');
      });

      doc.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        if (src) {
          try {
            const abs = new URL(src, data.url).href;
            const local = urlToLocal.get(abs);
            if (local) img.setAttribute('src', local);
          } catch (e) {}
        }
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          const rewritten = srcset.split(',').map(part => {
            const trimmed = part.trim();
            const [u, descriptor] = trimmed.split(/\s+/, 2);
            try {
              const abs = new URL(u, data.url).href;
              const local = urlToLocal.get(abs);
              return local ? `${local}${descriptor ? ' ' + descriptor : ''}` : trimmed;
            } catch (e) { return trimmed; }
          }).join(', ');
          img.setAttribute('srcset', rewritten);
        }
      });

      doc.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style && style.includes('url(')) {
          el.setAttribute('style', rewriteCssUrls(style, data.url, urlToLocal, ''));
        }
      });

      doc.querySelectorAll('link[rel*="icon"]').forEach(l => {
        try {
          const abs = new URL(l.getAttribute('href'), data.url).href;
          const local = urlToLocal.get(abs);
          if (local) l.setAttribute('href', local);
        } catch (e) {}
      });

      if (manifestSaved) {
        const manifestLink = doc.querySelector('link[rel="manifest"]');
        if (manifestLink) manifestLink.setAttribute('href', 'manifest.webmanifest');
      }

      doc.querySelectorAll('video, audio').forEach(el => {
        const src = el.getAttribute('src');
        if (src) {
          try {
            const abs = new URL(src, data.url).href;
            const local = urlToLocal.get(abs);
            if (local) el.setAttribute('src', local);
          } catch (e) {}
        }
        el.querySelectorAll('source[src]').forEach(s => {
          try {
            const abs = new URL(s.getAttribute('src'), data.url).href;
            const local = urlToLocal.get(abs);
            if (local) s.setAttribute('src', local);
          } catch (e) {}
        });
      });

      if (opts.stripScripts) {
        doc.querySelectorAll('script').forEach(s => s.remove());
      }

      finalHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    }

    await writeText(rootHandle, 'index.html', finalHtml);
    log('index.html saved' + (opts.rewrite ? ' (rewritten to local files)' : ''), 'ok'); counters.ok++;
  }

  const meta = {
    url: data.url,
    title: data.title,
    themeColor: data.themeColor,
    scrapedAt: new Date().toISOString(),
    counts: {
      css_inline: data.css.inline.length,
      css_external: data.css.external.length,
      js_inline: data.js.inline.length,
      js_external: data.js.external.length,
      images: data.images.length,
      video: data.media.video.length,
      audio: data.media.audio.length,
      icons: data.icons.length,
      iframes: data.iframes.length,
      links: data.links.length,
    },
    metaTags: data.meta,
    iframes: data.iframes,
    links: data.links,
  };
  await writeText(rootHandle, 'meta.json', JSON.stringify(meta, null, 2));
  log('meta.json saved (page info, meta tags, iframe/link lists)', 'ok'); counters.ok++;

  if (opts.context) {
    const savedFiles = [];
    if (opts.html) savedFiles.push('index.html - frozen page snapshot');
    if (opts.css) savedFiles.push('css/ - stylesheets');
    if (opts.js) savedFiles.push('js/ - scripts (saved for reference; stripped from index.html)');
    if (opts.img) savedFiles.push('images/ - images and CSS backgrounds');
    if (opts.fonts) savedFiles.push('fonts/ - web fonts');
    if (opts.icons) savedFiles.push('icons/ - favicons and app icons');
    if (opts.media) savedFiles.push('media/ - video/audio files');
    if (opts.manifest) savedFiles.push('manifest.webmanifest - web app manifest');
    savedFiles.push('meta.json - machine-readable page metadata');
    const md = buildContextMarkdown(data, counters, savedFiles);
    await writeText(rootHandle, 'context.md', md);
    log('context.md saved (AI-agent-ready page summary)', 'ok'); counters.ok++;
  }

  summaryEl.textContent = `Done: ${counters.ok} files saved, ${counters.fail} failed, ${counters.skipped} data-URI images skipped.`;
  startBtn.disabled = false;
});
