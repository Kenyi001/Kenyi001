#!/usr/bin/env node
// Genera assets/dk-core-magi.svg a partir de la actividad publica real de GitHub.
// Sin dependencias: Node 22+ (fetch, fs, Intl, node:assert).
//
//   node scripts/magi.mjs                 datos en vivo -> assets/dk-core-magi.svg
//   node scripts/magi.mjs --dump          imprime hechos normalizados + estado, no escribe
//   node scripts/magi.mjs --fixture NAME  renderiza datos de prueba, sin red
//   node scripts/magi.mjs --all           todas las combinaciones -> .preview/ + preview.html
//   node scripts/magi.mjs --self-test     verifica las reglas
//   node scripts/magi.mjs --golden        renderiza el diseno estatico original -> .preview/golden.svg
//   --now <iso>  congela el reloj  ·  --frame <k>  aplica el keyframe k en estatico (para revisar el 3D)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'assets/dk-core-magi.svg');
const PREVIEW = resolve(ROOT, '.preview');
const LOGIN = process.env.GH_USER || 'Kenyi001';
const DAY = 86_400_000;

const WINDOW = { build: 7, listen: 30, guide: 30, lang: 90, push: 30 };
const REVIEW_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

// ---------------------------------------------------------------- datos

async function request(url, init, attempt = 1) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (attempt < 3) return retry(url, init, attempt);
    throw err;
  }
  if (res.ok) return res.json();
  const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
  if ((res.status >= 500 || rateLimited) && attempt < 3) {
    const after = Number(res.headers.get('retry-after'));
    return retry(url, init, attempt, after ? after * 1000 : null);
  }
  // Sin el cuerpo de la respuesta: el log de Actions es publico y el cuerpo puede nombrar repos u orgs privadas.
  throw new Error(`HTTP ${res.status} en ${new URL(url).pathname}`);
}

async function retry(url, init, attempt, waitMs) {
  await new Promise((r) => setTimeout(r, waitMs ?? (attempt === 1 ? 2000 : 6000)));
  return request(url, init, attempt + 1);
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kenyi001-magi',
  };
}

async function graphql(token, query, variables) {
  const body = await request('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return body;
}

const CORE_QUERY = `query($login:String!,$f7:DateTime!,$f30:DateTime!,$f90:DateTime!,$to:DateTime!){
  user(login:$login){
    c7: contributionsCollection(from:$f7,to:$to){
      restrictedContributionsCount
      commitContributionsByRepository(maxRepositories:100){ contributions{ totalCount } repository{ nameWithOwner isPrivate } }
    }
    c30: contributionsCollection(from:$f30,to:$to){
      issueContributions(first:50){ nodes{ occurredAt issue{ repository{ nameWithOwner isPrivate } } } }
      pullRequestReviewContributions(first:50){ nodes{ occurredAt
        pullRequestReview{ state }
        pullRequest{ author{ login } repository{ nameWithOwner isPrivate owner{ login } } } } }
    }
    c90: contributionsCollection(from:$f90,to:$to){
      commitContributionsByRepository(maxRepositories:25){
        contributions{ totalCount } repository{ nameWithOwner isPrivate isFork primaryLanguage{ name } } }
    }
  }
}`;

// Comentarios: fuente complementaria. Si el token no puede leerlos, se sigue con los eventos
// publicos (que tambien traen IssueCommentEvent) y se avisa en el log, sin el detalle del error.
const ISSUE_COMMENTS_QUERY = `query($login:String!,$after:String){
  user(login:$login){
    issueComments(first:50, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}){
      pageInfo{ hasNextPage endCursor } nodes{ createdAt updatedAt repository{ nameWithOwner isPrivate } } }
  }
}`;
const DISCUSSION_COMMENTS_QUERY = `query($login:String!){
  user(login:$login){
    repositoryDiscussionComments(last:30){ nodes{ createdAt discussion{ repository{ nameWithOwner isPrivate } } } }
  }
}`;

// Detalle de errores omitido a proposito: el log de Actions es publico.
const graphqlOk = (res) => {
  if (res.errors?.length) throw new Error(`GraphQL devolvio ${res.errors.length} error(es)`);
  return res.data;
};

async function fetchComments(token, now) {
  const cutoff = now - WINDOW.listen * DAY;
  const issueComments = [];
  let after = null;
  // Ordenado por updatedAt (la API no ordena por createdAt). createdAt <= updatedAt, asi que al
  // pasar un updatedAt fuera de la ventana, todo lo que sigue tambien quedo fuera.
  for (let page = 0; page < 5; page++) {
    const conn = graphqlOk(await graphql(token, ISSUE_COMMENTS_QUERY, { login: LOGIN, after })).user.issueComments;
    issueComments.push(...conn.nodes);
    const oldest = conn.nodes.at(-1);
    if (!conn.pageInfo.hasNextPage || !oldest || Date.parse(oldest.updatedAt) < cutoff) break;
    after = conn.pageInfo.endCursor;
  }
  const disc = graphqlOk(await graphql(token, DISCUSSION_COMMENTS_QUERY, { login: LOGIN }));
  return { issueComments, discussionComments: disc.user.repositoryDiscussionComments.nodes };
}

async function fetchRaw(now) {
  const token = process.env.MAGI_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Falta GITHUB_TOKEN (o MAGI_TOKEN).');
  const iso = (days) => new Date(now - days * DAY).toISOString();

  const data = graphqlOk(await graphql(token, CORE_QUERY, {
    login: LOGIN, f7: iso(7), f30: iso(30), f90: iso(90), to: new Date(now).toISOString(),
  }));
  if (!data?.user) throw new Error('Usuario no encontrado.');

  const warnings = [];
  let comments = null;
  try {
    comments = await fetchComments(token, now);
  } catch {
    warnings.push('comentarios no disponibles con este token; LISTEN usa solo eventos publicos');
  }

  // Eventos publicos: solo type, repo.name, created_at, actor.login y action (GitHub viene recortando los payloads).
  const events = [];
  const cutoff = now - WINDOW.push * DAY;
  for (let page = 1; page <= 3; page++) {
    const batch = await request(`https://api.github.com/users/${LOGIN}/events/public?per_page=100&page=${page}`, { headers: headers(token) });
    for (const e of batch) {
      if (Date.parse(e.created_at) < cutoff || e.actor?.login?.toLowerCase() !== LOGIN.toLowerCase() || !e.repo?.name) continue;
      events.push({ type: e.type, repo: e.repo.name, at: e.created_at, action: e.payload?.action ?? null });
    }
    if (batch.length < 100 || batch.some((e) => Date.parse(e.created_at) < cutoff)) break;
  }
  return { user: data.user, comments, events, warnings };
}

// Convierte la respuesta cruda en hechos planos. Tolera nodos null (issues/PRs borrados, acceso
// revocado): se descartan en vez de romper la corrida diaria.
function normalizeFacts(raw, now) {
  const u = raw.user;
  const repoOf = (r) => (r && typeof r.nameWithOwner === 'string' ? r : null);
  const listenSignals = [];
  const addListen = (kind, at, r) => { if (r && at) listenSignals.push({ kind, at, repo: r.nameWithOwner, isPrivate: r.isPrivate !== false }); };

  for (const n of u.c30?.issueContributions?.nodes ?? []) addListen('issue', n?.occurredAt, repoOf(n?.issue?.repository));
  for (const n of raw.comments?.issueComments ?? []) addListen('comment', n?.createdAt, repoOf(n?.repository));
  for (const n of raw.comments?.discussionComments ?? []) addListen('discussion', n?.createdAt, repoOf(n?.discussion?.repository));

  const pushEvents = [];
  for (const e of raw.events ?? []) {
    if (e.type === 'PushEvent') pushEvents.push({ repo: e.repo, at: e.at });
    if (e.type === 'IssuesEvent' && (e.action ?? 'opened') === 'opened') addListen('issue-event', e.at, { nameWithOwner: e.repo, isPrivate: false });
    if (e.type === 'IssueCommentEvent' || e.type === 'PullRequestReviewCommentEvent') addListen('comment-event', e.at, { nameWithOwner: e.repo, isPrivate: false });
  }

  const reviews = [];
  for (const n of u.c30?.pullRequestReviewContributions?.nodes ?? []) {
    const r = repoOf(n?.pullRequest?.repository);
    if (!r || !r.owner?.login || !n.occurredAt) continue;
    reviews.push({
      at: n.occurredAt,
      state: n.pullRequestReview?.state ?? null,
      prAuthor: n.pullRequest.author?.login ?? null,
      repo: r.nameWithOwner,
      owner: r.owner.login,
      isPrivate: r.isPrivate !== false,
    });
  }

  const commits = (list) => (list ?? []).filter((c) => repoOf(c?.repository));
  return {
    login: LOGIN,
    now: new Date(now).toISOString(),
    commitsByRepo7: commits(u.c7?.commitContributionsByRepository).map((c) => ({
      repo: c.repository.nameWithOwner, isPrivate: c.repository.isPrivate !== false, count: c.contributions?.totalCount ?? 0,
    })),
    restricted7: u.c7?.restrictedContributionsCount ?? 0,
    pushEvents,
    listenSignals,
    reviews,
    commitsByRepo90: commits(u.c90?.commitContributionsByRepository).map((c) => ({
      repo: c.repository.nameWithOwner, isPrivate: c.repository.isPrivate !== false, isFork: !!c.repository.isFork,
      lang: c.repository.primaryLanguage?.name ?? null, count: c.contributions?.totalCount ?? 0,
    })),
    warnings: raw.warnings ?? [],
  };
}

// ---------------------------------------------------------------- reglas

function deriveState(f) {
  const now = Date.parse(f.now);
  const me = f.login.toLowerCase();
  const profileRepo = `${me}/${me}`;
  const within = (at, days) => now - Date.parse(at) <= days * DAY && Date.parse(at) <= now;
  const notProfile = (repo) => repo.toLowerCase() !== profileRepo;

  const commits7 = f.commitsByRepo7.filter((c) => notProfile(c.repo));
  const publicCommits7 = commits7.filter((c) => !c.isPrivate).reduce((s, c) => s + c.count, 0);
  const privateCommits7 = commits7.filter((c) => c.isPrivate).reduce((s, c) => s + c.count, 0) + (f.restricted7 || 0);
  const pushes = f.pushEvents.filter((p) => notProfile(p.repo)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const pushed7 = pushes.some((p) => within(p.at, WINDOW.build));

  const build = publicCommits7 + privateCommits7 > 0 || pushed7;
  const listen = f.listenSignals.some((s) => !s.isPrivate && notProfile(s.repo) && within(s.at, WINDOW.listen));
  // Lista blanca: una review con estado desconocido o sin autor verificable no cuenta.
  const guide = f.reviews.some((r) =>
    !r.isPrivate && REVIEW_STATES.includes(r.state) && within(r.at, WINDOW.guide) &&
    !!r.prAuthor && r.prAuthor.toLowerCase() !== me && r.owner.toLowerCase() !== me);

  const langTotals = new Map();
  for (const c of f.commitsByRepo90) {
    if (c.isPrivate || c.isFork || !c.lang || !notProfile(c.repo)) continue;
    langTotals.set(c.lang, (langTotals.get(c.lang) || 0) + c.count);
  }
  const topLang = [...langTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const lastPush = pushes.find((p) => within(p.at, WINDOW.push)) ?? null;
  const shortRepo = (repo) => (repo.toLowerCase().startsWith(`${me}/`) ? repo.slice(me.length + 1) : repo);

  return {
    build, listen, guide,
    online: [build, listen, guide].filter(Boolean).length,
    publicCommits7, privateCommits7,
    lastPush: lastPush ? { repo: shortRepo(lastPush.repo), days: Math.floor((now - Date.parse(lastPush.at)) / DAY) } : null,
    topLang,
    syncDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
  };
}

// ---------------------------------------------------------------- 3D

const THETA_MAX = 8, PHI_MAX = 3, PERIOD_S = 18, STOPS = 24;
const CX = 480, CY = 340;
// echo en -160: con -60 su separacion (~8px) quedaba tapada por el halo del neon.
const LAYERS = { far: -320, echo: -160, core: 0, hud: 50 };
assert.ok(THETA_MAX <= 8 && PHI_MAX <= 4, 'amplitud 3D demasiado grande: el texto dejaria de leerse');

function pose(k, z) {
  const rad = Math.PI / 180;
  const t = THETA_MAX * rad * Math.sin((2 * Math.PI * k) / STOPS);
  const p = PHI_MAX * rad * Math.sin((4 * Math.PI * k) / STOPS);
  return {
    e: CX * (1 - Math.cos(t)) + z * Math.sin(t),
    f: CY * (1 - Math.cos(p)) - CX * Math.sin(t) * Math.sin(p) - z * Math.cos(t) * Math.sin(p),
    a: Math.atan(Math.tan(t) * Math.sin(p)) / rad,
    sx: Math.cos(t),
    sy: Math.cos(p),
  };
}

const r = (n, d) => Number(n.toFixed(d));
const cssTransform = ({ e, f, a, sx, sy }) => `translate(${r(e, 2)}px,${r(f, 2)}px) skewY(${r(a, 3)}deg) scale(${r(sx, 4)},${r(sy, 4)})`;
const attrTransform = ({ e, f, a, sx, sy }) => `translate(${r(e, 2)},${r(f, 2)}) skewY(${r(a, 3)}) scale(${r(sx, 4)},${r(sy, 4)})`;

function styleBlock() {
  const frames = Object.entries(LAYERS).map(([id, z]) => {
    const stops = [];
    for (let k = 0; k <= STOPS; k++) stops.push(`${r((k / STOPS) * 100, 4)}%{transform:${cssTransform(pose(k, z))}}`);
    return `@keyframes k-${id}{${stops.join('')}}\n    #${id}{animation:k-${id} ${PERIOD_S}s linear infinite}`;
  });
  return `  <style>
    .l{transform-box:view-box;transform-origin:0 0}
    ${frames.join('\n    ')}
    @media (prefers-reduced-motion:reduce){.l{animation:none}}
  </style>\n`;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function farDots() {
  const rnd = mulberry32(0xd4c0);
  // Las zonas libres de puntos se agrandan por lo maximo que se desplazan entre si la capa lejana
  // y la del HUD, para que ningun punto termine encima de un readout en ningun cuadro.
  const rad = Math.PI / 180;
  const padX = Math.ceil((Math.abs(LAYERS.far) + LAYERS.hud) * Math.sin(THETA_MAX * rad)) + 6;
  const padY = Math.ceil((Math.abs(LAYERS.far) + LAYERS.hud) * Math.sin(PHI_MAX * rad) + CX * Math.sin(THETA_MAX * rad) * Math.sin(PHI_MAX * rad)) + 6;
  const blocked = (x, y) => (x < 300 + padX && y < 340 + padY) || (x > 668 - padX && y < 325 + padY);
  const dots = [];
  const place = (count, rMin, rSpan, oMin, oSpan) => {
    let placed = 0;
    while (placed < count) {
      const x = -20 + rnd() * 1000, y = -20 + rnd() * 680;
      const rr = rMin + rnd() * rSpan, o = oMin + rnd() * oSpan;
      if (blocked(x, y)) continue;
      dots.push(`<circle cx="${r(x, 1)}" cy="${r(y, 1)}" r="${r(rr, 2)}" fill-opacity="${r(o, 2)}"/>`);
      placed++;
    }
  };
  place(110, 1.2, 1.0, 0.16, 0.2);
  place(9, 2.6, 1.0, 0.36, 0.14); // puntos ancla: se siguen con la vista y venden el paralaje
  return dots.join('');
}

// ---------------------------------------------------------------- render

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const VALUE_MAX = 18;

function readoutValues(st) {
  const commits = st.privateCommits7 > 0 ? `${st.publicCommits7} · +${st.privateCommits7} PRIV` : `${st.publicCommits7}`;
  let push = 'NONE · 30D';
  if (st.lastPush) {
    const age = st.lastPush.days === 0 ? 'TODAY' : `${st.lastPush.days}D`;
    const suffix = ` · ${age}`;
    push = cut(st.lastPush.repo.toUpperCase(), VALUE_MAX - suffix.length) + suffix;
  }
  return [
    ['PROTOCOL :', 'LISTEN_FIRST'],
    ['COMMITS · 7D :', cut(commits.toUpperCase(), VALUE_MAX)],
    ['LAST PUSH :', push],
    ['TOP LANG · 90D :', st.topLang ? cut(st.topLang.toUpperCase(), VALUE_MAX) : '—'],
    ['LAST SYNC :', `${st.syncDate} · UTC-4`],
  ];
}

function statusBox(x, y, online) {
  if (online) {
    return `    <g filter="url(#glowText)">
      <rect x="${x}" y="${y}" width="140" height="68" rx="4" fill="none" stroke="#7DD3B0" stroke-width="3"/>
      <text x="${x + 70}" y="${y + 50}" fill="#9BDCBF">稼働</text>
    </g>`;
  }
  return `    <g filter="url(#glowText)">
      <!-- parpadea ~8s y se queda fijo: sin movimiento infinito que no se pueda pausar -->
      <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="5" fill="freeze"/>
      <rect x="${x}" y="${y}" width="140" height="68" rx="4" fill="#EC7357" fill-opacity="0.08" stroke="#EC7357" stroke-width="3"/>
      <text x="${x + 70}" y="${y + 50}" fill="#EF937C">待機</text>
    </g>`;
}

const caption = (x, y, online) =>
  `    <text x="${x + 70}" y="${y + 96}" fill="${online ? '#7DD3B0' : '#EC7357'}">${online ? 'ONLINE' : 'STANDBY'}</text>`;

const PANELS = `    <polygon points="305,30 655,30 655,215 588,282 372,282 305,215"/>
    <polygon points="130,350 350,350 462,462 462,612 130,612"/>
    <polygon points="610,350 830,350 830,612 498,612 498,462"/>
    <polygon points="425,300 535,300 585,350 510,425 450,425 375,350"/>
    <rect x="472" y="437" width="16" height="22" stroke-width="5"/>`;

const GOLDEN_README = `    <text x="28" y="62">PROTOCOL :</text>
    <text x="28" y="88">LISTEN_FIRST</text>
    <text x="28" y="120">FILE :</text>
    <text x="28" y="146">DK.SYS</text>
    <text x="28" y="178">MODE :</text>
    <text x="28" y="204">DISCREET</text>
    <text x="28" y="236">PRIORITY :</text>
    <text x="28" y="262">GROWTH</text>`;

const GOLDEN_LABEL = 'DK Core: panel inspirado en MAGI. LISTEN 1 y BUILD 2 en linea, GUIDE 3 en espera, convergiendo en un nucleo DK';

function render(st, { golden = false, frame = null } = {}) {
  const live = !golden;
  const word = (on) => (on ? 'en linea' : 'en espera');
  const label = golden
    ? GOLDEN_LABEL
    : `DK Core, panel en vivo: BUILD 2 ${word(st.build)}, LISTEN 1 ${word(st.listen)}, GUIDE 3 ${word(st.guide)}. ${st.online} de 3 en linea. Sincronizado ${st.syncDate}`;

  const readout = golden
    ? GOLDEN_README
    : readoutValues(st)
        .map(([k, v], i) => `    <text x="28" y="${62 + i * 58}">${esc(k)}</text>\n    <text x="28" y="${88 + i * 58}">${esc(v)}</text>`)
        .join('\n');

  const layer = (id, body) => {
    if (!live) return body;
    const t = frame === null ? '' : ` transform="${attrTransform(pose(frame, LAYERS[id]))}"`;
    return `  <g id="${id}" class="l"${t}>\n${body}\n  </g>`;
  };

  const desc = live
    ? `  <desc>Generado ${esc(st.syncDate)} por scripts/magi.mjs con la API publica de GitHub. BUILD: commits o push en ${WINDOW.build} dias (${st.publicCommits7} publicos, ${st.privateCommits7} privados sin nombre). LISTEN: issue abierto o comentario en un repo publico (propio o ajeno) en ${WINDOW.listen} dias. GUIDE: review a un PR de otra persona en un repo ajeno en ${WINDOW.guide} dias. El repo del perfil no cuenta.</desc>\n`
    : '';
  const clip = live ? `    <clipPath id="bgclip"><rect width="960" height="640" rx="8"/></clipPath>\n` : '';

  const hud = `  <!-- readout izquierdo: etiqueta arriba, valor abajo, como en la referencia -->
  <g font-family="'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="0.6" fill="#EF937C" filter="url(#glowText)">
${readout}
  </g>

  <!-- columna derecha: dos cajas de estado + capas del stack -->
  <g font-family="'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif" font-weight="700" fill="#EF937C" filter="url(#glowText)">
    <rect x="680" y="30" width="260" height="62" rx="5" fill="none" stroke="#EC7357" stroke-width="2.5"/>
    <text x="694" y="54" font-size="15" letter-spacing="0.5" textLength="175" lengthAdjust="spacingAndGlyphs">DIRECT LINK : DK-CORE 01</text>
    <text x="694" y="80" font-size="19" font-weight="800" letter-spacing="0.4" textLength="196" lengthAdjust="spacingAndGlyphs">ACCESS MODE : PUBLIC</text>

    <rect x="680" y="104" width="260" height="62" rx="5" fill="none" stroke="#EC7357" stroke-width="2.5"/>
    <rect x="688" y="117" width="3" height="36" fill="#EC7357"/>
    <rect x="694" y="117" width="3" height="36" fill="#EC7357"/>
    <rect x="923" y="117" width="3" height="36" fill="#EC7357"/>
    <rect x="929" y="117" width="3" height="36" fill="#EC7357"/>
    <text x="708" y="128" font-size="15" letter-spacing="0.5" textLength="153" lengthAdjust="spacingAndGlyphs">DELIBERATION RESULT</text>
    <text x="708" y="154" font-size="20" font-weight="800" letter-spacing="0.4">${st.online} / 3 ONLINE</text>

    <text x="680" y="190" font-size="16">Layer 3:</text>
    <text x="680" y="211" font-size="17">Applied AI · RAG · Voice</text>
    <text x="680" y="239" font-size="16">Layer 2:</text>
    <text x="680" y="260" font-size="17" textLength="195" lengthAdjust="spacingAndGlyphs">Backend · Node · C# · Python</text>
    <text x="680" y="288" font-size="16">Layer 1:</text>
    <text x="680" y="309" font-size="17" textLength="236" lengthAdjust="spacingAndGlyphs">Cloud · Docker · GCP · Azure · AWS</text>
  </g>`;

  const core = `  <!-- estructura: tres paneles encajados alrededor del nucleo, chaflanes a 45 grados -->
  <g fill="none" stroke="#7DD3B0" stroke-width="7" stroke-linejoin="miter" filter="url(#neon)">
    <animate attributeName="opacity" values="1;0.82;1" dur="3.4s" repeatCount="indefinite"/>
${PANELS}
  </g>

  <!-- nombres de panel: grotesca condensada pesada -->
  <g font-family="Impact, Haettenschweiler, 'Arial Narrow', 'Roboto Condensed', sans-serif" font-size="58" letter-spacing="1" fill="#9BDCBF" text-anchor="middle" filter="url(#glowText)">
    <text x="480" y="108">BUILD·2</text>
    <text x="296" y="594">GUIDE·3</text>
    <text x="664" y="594">LISTEN·1</text>
  </g>

  <!-- nucleo -->
  <text x="480" y="381" text-anchor="middle" font-family="'Times New Roman', Georgia, serif" font-size="56" font-weight="700" letter-spacing="2" fill="#9BDCBF" filter="url(#glowText)">DK</text>

  <!-- recuadros de estado: 稼働 = en linea, 待機 = en espera -->
  <g font-family="'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'Noto Serif CJK JP', 'Noto Serif JP', 'MS Mincho', serif" font-size="44" font-weight="700" text-anchor="middle">
${statusBox(410, 128, st.build)}
${statusBox(607, 436, st.listen)}
${statusBox(215, 436, st.guide)}
  </g>

  <!-- traduccion bajo cada recuadro, para quien no lee japones o no tiene fuente CJK -->
  <g font-family="'JetBrains Mono', Consolas, monospace" font-size="15" font-weight="700" letter-spacing="3" text-anchor="middle">
${caption(410, 128, st.build)}
${caption(607, 436, st.listen)}
${caption(215, 436, st.guide)}
  </g>`;

  const far = live
    ? `  <g clip-path="url(#bgclip)">\n${layer('far', `    <g fill="#7DD3B0">${farDots()}</g>`)}\n  </g>\n\n`
    : '';
  const echo = live
    ? `${layer('echo', `  <g fill="none" stroke="#7DD3B0" stroke-width="2.5" stroke-opacity="0.35">\n${PANELS}\n  </g>`)}\n\n`
    : '';

  return `<svg width="960" height="640" viewBox="0 0 960 640" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}">
  <title>DK Core</title>
${desc}  <defs>
    <filter id="neon" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="7" result="blur"/>
      <!-- blur dos veces a proposito: duplica la intensidad del halo -->
      <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glowText" x="-10%" y="-30%" width="120%" height="160%">
      <feGaussianBlur stdDeviation="2.4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
${clip}  </defs>
${live && frame === null ? styleBlock() : ''}
  <rect width="960" height="640" rx="8" fill="#0B0D13"/>

${far}${echo}${layer('hud', hud)}

${layer('core', core)}
</svg>
`;
}

// ---------------------------------------------------------------- fixtures y pruebas

const FIX_NOW = '2026-09-24T12:00:00Z';
const ago = (days) => new Date(Date.parse(FIX_NOW) - days * DAY).toISOString();
const empty = () => ({ login: 'Kenyi001', now: FIX_NOW, commitsByRepo7: [], restricted7: 0, pushEvents: [], listenSignals: [], reviews: [], commitsByRepo90: [], warnings: [] });
const withBuild = (f) => {
  f.commitsByRepo7.push({ repo: 'Kenyi001/dk-portfolio', isPrivate: false, count: 5 });
  f.pushEvents.push({ repo: 'Kenyi001/dk-portfolio', at: ago(2) });
  f.commitsByRepo90.push({ repo: 'Kenyi001/dk-portfolio', isPrivate: false, isFork: false, lang: 'TypeScript', count: 40 });
  return f;
};
const withListen = (f) => { f.listenSignals.push({ kind: 'comment', at: ago(10), repo: 'someorg/somerepo', isPrivate: false }); return f; };
const withGuide = (f) => {
  f.reviews.push({ at: ago(5), state: 'APPROVED', prAuthor: 'alice', repo: 'someorg/project', owner: 'someorg', isPrivate: false });
  return f;
};

const FIXTURES = {
  '0of3': () => empty(),
  build: () => withBuild(empty()),
  listen: () => withListen(empty()),
  guide: () => withGuide(empty()),
  'build-listen': () => withListen(withBuild(empty())),
  'build-guide': () => withGuide(withBuild(empty())),
  'listen-guide': () => withGuide(withListen(empty())),
  '3of3': () => withGuide(withListen(withBuild(empty()))),
  empty: () => empty(),
  'long-names': () => {
    const f = empty();
    f.pushEvents.push({ repo: 'Kenyi001/an-extremely-long-repository-name-for-testing', at: ago(0) });
    f.commitsByRepo7.push({ repo: 'Kenyi001/an-extremely-long-repository-name-for-testing', isPrivate: false, count: 1234 });
    f.commitsByRepo90.push({ repo: 'Kenyi001/x', isPrivate: false, isFork: false, lang: 'Jupyter Notebook', count: 3 });
    f.restricted7 = 56;
    return f;
  },
  'private-leak': () => {
    const f = withBuild(empty());
    f.commitsByRepo7.push({ repo: 'Kenyi001/secret-client-work', isPrivate: true, count: 9 });
    f.commitsByRepo90.push({ repo: 'Kenyi001/secret-client-work', isPrivate: true, isFork: false, lang: 'Rust', count: 500 });
    f.listenSignals.push({ kind: 'comment', at: ago(1), repo: 'Kenyi001/secret-client-work', isPrivate: true });
    return f;
  },
};

function selfTest() {
  const st = (f) => deriveState(f);
  const f1 = empty(); f1.pushEvents.push({ repo: 'Kenyi001/dk-portfolio', at: ago(8) });
  assert.equal(st(f1).build, false, 'un push de hace 8 dias no enciende BUILD');

  const f2 = empty();
  f2.pushEvents.push({ repo: 'Kenyi001/Kenyi001', at: ago(1) });
  f2.commitsByRepo7.push({ repo: 'kenyi001/kenyi001', isPrivate: false, count: 4 });
  f2.listenSignals.push({ kind: 'comment', at: ago(1), repo: 'Kenyi001/Kenyi001', isPrivate: false });
  assert.equal(st(f2).build, false, 'el repo del perfil no cuenta para BUILD');
  assert.equal(st(f2).listen, false, 'el repo del perfil no cuenta para LISTEN');

  const f3 = empty(); f3.reviews.push({ at: ago(3), state: 'APPROVED', prAuthor: 'alice', repo: 'Kenyi001/ledgerlens', owner: 'Kenyi001', isPrivate: false });
  assert.equal(st(f3).guide, false, 'review en repo propio no enciende GUIDE');
  const f4 = empty(); f4.reviews.push({ at: ago(3), state: 'COMMENTED', prAuthor: 'Kenyi001', repo: 'org/app', owner: 'org', isPrivate: false });
  assert.equal(st(f4).guide, false, 'review a un PR propio no enciende GUIDE');
  const f5 = empty(); f5.reviews.push({ at: ago(3), state: 'PENDING', prAuthor: 'alice', repo: 'org/app', owner: 'org', isPrivate: false });
  assert.equal(st(f5).guide, false, 'una review pendiente no cuenta');
  const f6 = empty(); f6.reviews.push({ at: ago(31), state: 'APPROVED', prAuthor: 'alice', repo: 'org/app', owner: 'org', isPrivate: false });
  assert.equal(st(f6).guide, false, 'review fuera de la ventana de 30 dias no cuenta');
  assert.equal(st(withGuide(empty())).guide, true, 'review valida enciende GUIDE');

  const f7 = empty(); f7.pushEvents.push({ repo: 'Kenyi001/dk-portfolio', at: ago(7) });
  assert.equal(st(f7).build, true, 'un push de hace exactamente 7 dias todavia cuenta');
  const f8 = empty(); f8.reviews.push({ at: ago(3), state: null, prAuthor: 'alice', repo: 'org/app', owner: 'org', isPrivate: false });
  assert.equal(st(f8).guide, false, 'una review con estado desconocido no enciende GUIDE');
  const f9 = empty(); f9.reviews.push({ at: ago(3), state: 'APPROVED', prAuthor: null, repo: 'org/app', owner: 'org', isPrivate: false });
  assert.equal(st(f9).guide, false, 'una review sin autor verificable no enciende GUIDE');

  // Nodos null de GraphQL (issue o PR borrado, acceso revocado): se descartan sin romper.
  const nowMs = Date.parse(FIX_NOW);
  const raw = {
    user: {
      c7: { restrictedContributionsCount: 2, commitContributionsByRepository: [{ contributions: { totalCount: 3 }, repository: null }] },
      c30: {
        issueContributions: { nodes: [null, { occurredAt: ago(2), issue: null }, { occurredAt: ago(2), issue: { repository: { nameWithOwner: 'org/app', isPrivate: false } } }] },
        pullRequestReviewContributions: { nodes: [{ occurredAt: ago(2), pullRequestReview: null, pullRequest: null }, { occurredAt: ago(2), pullRequestReview: { state: 'APPROVED' }, pullRequest: { author: null, repository: { nameWithOwner: 'org/app', isPrivate: false, owner: { login: 'org' } } } }] },
      },
      c90: { commitContributionsByRepository: [{ contributions: { totalCount: 5 }, repository: null }] },
    },
    comments: { issueComments: [{ createdAt: ago(1), updatedAt: ago(1), repository: null }], discussionComments: [{ createdAt: ago(1), discussion: null }] },
    events: [],
    warnings: [],
  };
  const nf = normalizeFacts(raw, nowMs);
  assert.equal(nf.listenSignals.length, 1, 'solo sobrevive el issue con repo valido');
  assert.equal(nf.reviews.length, 1, 'la review sin PR se descarta');
  assert.equal(st(nf).guide, false, 'la review de un autor borrado no cuenta');
  assert.equal(st(nf).privateCommits7, 2, 'los commits restringidos se siguen contando');

  for (const [, v] of readoutValues(st(FIXTURES['long-names']()))) {
    assert.ok(v.length <= VALUE_MAX, `readout dentro del limite: ${v}`);
  }

  const leak = render(st(FIXTURES['private-leak']()));
  assert.ok(!/secret/i.test(leak), 'un repo privado nunca aparece en el SVG');
  assert.ok(!/RUST/.test(leak), 'el lenguaje de un repo privado no se usa');
  assert.equal(st(FIXTURES['private-leak']()).privateCommits7, 9, 'los commits privados se cuentan sin nombre');

  for (const [name, make] of Object.entries(FIXTURES)) {
    const s = st(make());
    const svg = render(s);
    assert.ok(!/undefined|NaN/.test(svg), `${name}: sin undefined/NaN`);
    assert.equal(s.online, [s.build, s.listen, s.guide].filter(Boolean).length, `${name}: N correcto`);
    assert.ok(svg.includes(`>${s.online} / 3 ONLINE<`), `${name}: la caja de deliberacion muestra N`);
    assert.equal((svg.match(/>稼働</g) || []).length, s.online, `${name}: un 稼働 por panel en linea`);
  }
  console.log('self-test: ok');
}

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const now = opt('--now') ? Date.parse(opt('--now')) : Date.now();
const frame = opt('--frame') !== null ? Number(opt('--frame')) : null;

if (flag('--self-test')) {
  selfTest();
} else if (flag('--golden')) {
  mkdirSync(PREVIEW, { recursive: true });
  const st = deriveState(FIXTURES['build-listen']());
  writeFileSync(resolve(PREVIEW, 'golden.svg'), render(st, { golden: true }));
  console.log('golden -> .preview/golden.svg');
} else if (flag('--all')) {
  mkdirSync(PREVIEW, { recursive: true });
  const names = Object.keys(FIXTURES);
  for (const name of names) writeFileSync(resolve(PREVIEW, `${name}.svg`), render(deriveState(FIXTURES[name]()), { frame }));
  const cells = names.map((n) => `<figure><figcaption>${n}</figcaption><img src="${n}.svg" width="820"></figure>`).join('\n');
  writeFileSync(resolve(PREVIEW, 'preview.html'),
    `<!doctype html><meta charset="utf-8"><style>body{background:#0d1117;color:#8b949e;font:14px monospace}figure{display:inline-block;margin:12px}</style>\n${cells}\n`);
  console.log(`${names.length} fixtures -> .preview/`);
} else if (opt('--fixture')) {
  const make = FIXTURES[opt('--fixture')];
  if (!make) throw new Error(`fixture desconocido; opciones: ${Object.keys(FIXTURES).join(', ')}`);
  mkdirSync(PREVIEW, { recursive: true });
  const file = resolve(PREVIEW, `${opt('--fixture')}${frame === null ? '' : `-f${frame}`}.svg`);
  writeFileSync(file, render(deriveState(make()), { frame }));
  console.log(`-> ${file}`);
} else {
  const facts = normalizeFacts(await fetchRaw(now), now);
  for (const w of facts.warnings) console.warn(`aviso: ${w}`);
  const st = deriveState(facts);
  // Solo conteos y estado en el log: sin nombres de repos privados.
  const inWindow = (at, days) => now - Date.parse(at) <= days * DAY;
  const uniq = (list) => new Set(list.map((s) => `${s.repo}|${s.at.slice(0, 16)}`)).size; // GraphQL y eventos se solapan
  console.log(JSON.stringify({ state: st, evidence: {
    pushes7d: facts.pushEvents.filter((p) => inWindow(p.at, WINDOW.build)).length,
    publicListenSignals30d: uniq(facts.listenSignals.filter((s) => !s.isPrivate && inWindow(s.at, WINDOW.listen))),
    publicReviews30d: facts.reviews.filter((r) => !r.isPrivate && inWindow(r.at, WINDOW.guide)).length,
  } }, null, 2));
  if (!flag('--dump')) {
    writeFileSync(OUT, render(st));
    console.log(`-> ${OUT}`);
  }
}
