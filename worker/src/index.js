// GCS Studio Build API
// One Cloudflare Worker + one D1 database (binding: DB).
// Never log keys, key hashes, or IPs.

// ---------------------------------------------------------------------------
// CONFIG: rename a status by changing its label. Keep the id the same,
// because the id is what's stored on each item.
// ---------------------------------------------------------------------------
const STATUSES = [
  { id: 'researching', label: 'Researching' },
  { id: 'need_to_order', label: 'Need to order' },
  { id: 'ordered', label: 'Ordered' },
  { id: 'received', label: 'Received/Ready to install' },
  { id: 'installed', label: 'Installed' },
];

const FIELD_TYPES = ['text', 'link', 'number', 'price', 'date', 'dropdown', 'checkbox', 'person'];

const FAIL_WINDOW_MS = 15 * 60 * 1000; // rate limit window
const FAIL_LIMIT = 20; // failed key attempts per hashed IP per window
const UNDO_WINDOW_MS = 2 * 60 * 1000; // how long the archiver can undo
const MAX_BODY = 64 * 1024;
const LIMITS = { title: 200, note: 5000, text: 2000, label: 60, options: 50, option: 80 };

const STATUS_IDS = new Set(STATUSES.map((s) => s.id));
const statusLabel = (id) => (STATUSES.find((s) => s.id === id) || { label: id }).label;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHEMA_VERSION = '2';

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      await ensureSchema(env);
      const res = await route(request, env);
      return withHeaders(res, cors);
    } catch (err) {
      if (err instanceof HttpError) {
        return withHeaders(json({ error: err.code, ...(err.extra || {}) }, err.status), cors);
      }
      // Message only. Never the request, headers, or body.
      console.error('unhandled', err && err.message);
      return withHeaders(json({ error: 'server' }, 500), cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const fail = (status, code, extra) => {
  throw new HttpError(status, code, extra);
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });
  }
  if (!path.startsWith('/api/')) {
    return new Response('Nothing here.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const me = await authenticate(request, env);
  const isAdmin = me.role === 'admin';
  const adminOnly = () => {
    if (!isAdmin) fail(403, 'not_allowed');
  };

  let m;
  if (path === '/api/board' && method === 'GET') return json(await getBoard(env, me));

  if (path === '/api/items' && method === 'POST') return json(await createItem(env, me, await readBody(request)), 201);

  if ((m = path.match(/^\/api\/items\/(\d+)$/)) && method === 'PATCH') {
    return json(await updateItem(env, me, Number(m[1]), await readBody(request)));
  }
  if ((m = path.match(/^\/api\/items\/(\d+)\/archive$/)) && method === 'POST') {
    return json(await archiveItem(env, me, Number(m[1]), 'archived'));
  }
  if ((m = path.match(/^\/api\/items\/(\d+)\/delete$/)) && method === 'POST') {
    return json(await archiveItem(env, me, Number(m[1]), 'deleted'));
  }
  if (path === '/api/activity' && method === 'GET') return json(await listActivity(env, url));
  if ((m = path.match(/^\/api\/items\/(\d+)\/restore$/)) && method === 'POST') {
    return json(await restoreItem(env, me, Number(m[1])));
  }

  if (path.startsWith('/api/admin/')) {
    adminOnly();
    if (path === '/api/admin/archived' && method === 'GET') return json(await listArchived(env));
    if ((m = path.match(/^\/api\/admin\/people\/(\d+)\/regenerate$/)) && method === 'POST') {
      return json(await regenerateKey(env, me, Number(m[1])));
    }
    if (path === '/api/admin/fields' && method === 'POST') return json(await createField(env, me, await readBody(request)), 201);
    if ((m = path.match(/^\/api\/admin\/fields\/(f_[a-z0-9_]+)$/)) && method === 'PATCH') {
      return json(await updateField(env, me, m[1], await readBody(request)));
    }
  }

  fail(404, 'not_found');
}

// ---------------------------------------------------------------------------
// Schema upgrades. Runs once per Worker start and only does real work the
// first time, so new versions never need anything pasted into the D1 console.
// ---------------------------------------------------------------------------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_v'").first();
  if (row && row.value === SCHEMA_VERSION) {
    schemaReady = true;
    return;
  }
  const steps = [
    'ALTER TABLE items ADD COLUMN due_date TEXT',
    'ALTER TABLE items ADD COLUMN archive_reason TEXT',
    `CREATE TABLE IF NOT EXISTS activity (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       at INTEGER NOT NULL,
       person_id INTEGER NOT NULL,
       item_id INTEGER,
       item_title TEXT,
       action TEXT NOT NULL,
       details_json TEXT NOT NULL DEFAULT '[]'
     )`,
    'CREATE INDEX IF NOT EXISTS activity_item ON activity (item_id, id)',
    // "Received" and "Ready to install" are one column now.
    "UPDATE items SET status = 'received' WHERE status = 'ready_to_install'",
    "UPDATE items SET archive_reason = 'archived' WHERE archived_at IS NOT NULL AND archive_reason IS NULL",
  ];
  for (const sql of steps) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      // "duplicate column" just means this step already ran. Anything else is real.
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_v', ?)").bind(SCHEMA_VERSION).run();
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------
function logStmt(env, me, action, itemId, itemTitle, details) {
  return env.DB.prepare(
    'INSERT INTO activity (at, person_id, item_id, item_title, action, details_json) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(Date.now(), me.id, itemId ?? null, itemTitle ?? null, action, JSON.stringify(details || []));
}
async function log(env, me, action, itemId, itemTitle, details) {
  await logStmt(env, me, action, itemId, itemTitle, details).run();
}

async function listActivity(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const item = Number(url.searchParams.get('item')) || null;
  const stmt = item
    ? env.DB.prepare('SELECT * FROM activity WHERE item_id = ? AND id < ? ORDER BY id DESC LIMIT ?').bind(item, before, limit + 1)
    : env.DB.prepare('SELECT * FROM activity WHERE id < ? ORDER BY id DESC LIMIT ?').bind(before, limit + 1);
  const { results } = await stmt.all();
  return {
    entries: results.slice(0, limit).map((r) => ({
      id: r.id,
      at: r.at,
      by: r.person_id,
      itemId: r.item_id,
      itemTitle: r.item_title,
      action: r.action,
      changes: safeParse(r.details_json, []),
    })),
    more: results.length > limit,
  };
}

// What changed between two versions of an item, in plain terms.
// f = what it's called, t = kind of value, a = before, b = after.
// Labels are snapshots, so old entries still read right after a rename.
async function diffItem(env, oldRow, next) {
  const out = [];
  if (oldRow.title !== next.title) out.push({ f: 'Name', t: 'text', a: oldRow.title, b: next.title });
  if (oldRow.status !== next.status) {
    out.push({ f: 'Status', t: 'status', a: statusLabel(oldRow.status), b: statusLabel(next.status) });
  }
  if ((oldRow.due_date || null) !== (next.due || null)) {
    out.push({ f: 'Due date', t: 'date', a: oldRow.due_date || null, b: next.due || null });
  }
  if (oldRow.note !== next.note) out.push({ f: 'Notes', t: 'note' });
  const before = safeParse(oldRow.custom_json, {});
  const keys = [...new Set([...Object.keys(before), ...Object.keys(next.custom)])].filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(next.custom[k])
  );
  if (keys.length) {
    const { results } = await env.DB.prepare('SELECT id, label, type FROM fields').all();
    const fields = new Map(results.map((f) => [f.id, f]));
    for (const k of keys) {
      const f = fields.get(k) || { label: 'A field', type: 'text' };
      out.push({ f: f.label, t: f.type, a: before[k] ?? null, b: next.custom[k] ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth + rate limit
// ---------------------------------------------------------------------------
async function authenticate(request, env) {
  const ipHash = await hashIp(request, env);
  const since = Date.now() - FAIL_WINDOW_MS;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip_hash = ? AND at > ?')
    .bind(ipHash, since)
    .first();
  if (row && row.n >= FAIL_LIMIT) fail(429, 'slow_down');

  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{20,128})$/);
  let person = null;
  if (match) {
    const keyHash = await sha256hex(match[1]);
    person = await env.DB.prepare('SELECT id, name, role FROM people WHERE key_hash = ? AND revoked_at IS NULL')
      .bind(keyHash)
      .first();
  }
  if (!person) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO auth_failures (ip_hash, at) VALUES (?, ?)').bind(ipHash, Date.now()),
      env.DB.prepare('DELETE FROM auth_failures WHERE at < ?').bind(since),
    ]);
    fail(401, 'bad_key');
  }
  return person;
}

let saltCache = null;
async function getSalt(env) {
  if (saltCache) return saltCache;
  let row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'ip_salt'").first();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('ip_salt', ?)").bind(randomToken(32)).run();
    row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'ip_salt'").first();
  }
  saltCache = row.value;
  return saltCache;
}

async function hashIp(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256hex((await getSalt(env)) + '|' + ip);
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
async function getBoard(env, me) {
  const isAdmin = me.role === 'admin';
  const [people, fields, items] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, role FROM people WHERE revoked_at IS NULL ORDER BY id'),
    env.DB.prepare('SELECT id, label, type, options_json, sort_order, hidden_at FROM fields ORDER BY sort_order, id'),
    env.DB.prepare('SELECT * FROM items WHERE archived_at IS NULL ORDER BY updated_at DESC'),
  ]);
  return {
    me: { id: me.id, name: me.name, role: me.role },
    people: people.results.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    statuses: STATUSES,
    fields: fields.results.filter((f) => isAdmin || !f.hidden_at).map(fieldOut),
    items: items.results.map(itemOut),
  };
}

function itemOut(r) {
  return {
    id: r.id,
    title: r.title,
    note: r.note,
    status: r.status,
    due: r.due_date || null,
    custom: safeParse(r.custom_json, {}),
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.archived_at
      ? { archivedAt: r.archived_at, archivedBy: r.archived_by, archiveReason: r.archive_reason || 'archived' }
      : {}),
  };
}

function fieldOut(f) {
  return {
    id: f.id,
    label: f.label,
    type: f.type,
    options: safeParse(f.options_json, []),
    hidden: !!f.hidden_at,
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
async function createItem(env, me, body) {
  const title = cleanText(body.title, LIMITS.title);
  if (!title) fail(400, 'need_title');
  const note = cleanNote(body.note);
  const status = body.status === undefined ? STATUSES[0].id : body.status;
  if (!STATUS_IDS.has(status)) fail(400, 'bad_input');
  const due = cleanDue(body.due);
  const custom = await mergeCustom(env, {}, body.custom);
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO items (title, note, status, due_date, custom_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(title, note, status, due, JSON.stringify(custom), me.id, me.id, now, now)
    .run();
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(res.meta.last_row_id).first();
  const details = [{ f: 'Status', t: 'status', b: statusLabel(status) }];
  if (due) details.push({ f: 'Due date', t: 'date', b: due });
  await log(env, me, 'added', row.id, row.title, details);
  return { item: itemOut(row) };
}

async function updateItem(env, me, id, body) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'not_found');
  if (row.archived_at) fail(410, 'gone');

  const base = Number(body.base);
  if (!Number.isFinite(base)) fail(400, 'bad_input');
  if (base !== row.updated_at) await conflict(env, row);

  let title = row.title;
  if (body.title !== undefined) {
    title = cleanText(body.title, LIMITS.title);
    if (!title) fail(400, 'need_title');
  }
  const note = body.note !== undefined ? cleanNote(body.note) : row.note;
  let status = row.status;
  if (body.status !== undefined) {
    if (!STATUS_IDS.has(body.status)) fail(400, 'bad_input');
    status = body.status;
  }
  const due = body.due !== undefined ? cleanDue(body.due) : row.due_date || null;
  const custom = await mergeCustom(env, safeParse(row.custom_json, {}), body.custom);

  const changes = await diffItem(env, row, { title, note, status, due, custom });
  if (!changes.length) return { item: itemOut(row) }; // nothing changed, nothing to save or log

  const now = Math.max(Date.now(), row.updated_at + 1);
  const res = await env.DB.prepare(
    `UPDATE items SET title = ?, note = ?, status = ?, due_date = ?, custom_json = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND updated_at = ? AND archived_at IS NULL`
  )
    .bind(title, note, status, due, JSON.stringify(custom), me.id, now, id, base)
    .run();

  if (!res.meta.changes) {
    // Someone saved in between our read and our write.
    const latest = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!latest || latest.archived_at) fail(410, 'gone');
    await conflict(env, latest);
  }
  await log(env, me, 'edited', id, title, changes);
  const fresh = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  return { item: itemOut(fresh) };
}

async function conflict(env, latestRow) {
  const who = await env.DB.prepare('SELECT name FROM people WHERE id = ?').bind(latestRow.updated_by).first();
  fail(409, 'conflict', { item: itemOut(latestRow), by: who ? who.name : 'Someone' });
}

// Deleted items are archived too, just marked so Yeti can tell them apart.
async function archiveItem(env, me, id, reason) {
  const now = Date.now();
  const res = await env.DB.prepare(
    'UPDATE items SET archived_at = ?, archived_by = ?, archive_reason = ? WHERE id = ? AND archived_at IS NULL'
  )
    .bind(now, me.id, reason, id)
    .run();
  if (!res.meta.changes) {
    const row = await env.DB.prepare('SELECT id FROM items WHERE id = ?').bind(id).first();
    fail(row ? 410 : 404, row ? 'gone' : 'not_found');
  }
  const row = await env.DB.prepare('SELECT title FROM items WHERE id = ?').bind(id).first();
  await log(env, me, reason, id, row.title, []);
  return { ok: true, archivedAt: now };
}

async function restoreItem(env, me, id) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!row) fail(404, 'not_found');
  if (!row.archived_at) return { item: itemOut(row) };
  // Undo only covers archiving. Deleted items come back through Yeti.
  const canUndo =
    row.archive_reason !== 'deleted' && row.archived_by === me.id && Date.now() - row.archived_at <= UNDO_WINDOW_MS;
  if (me.role !== 'admin' && !canUndo) fail(403, 'too_late');
  await env.DB.batch([
    env.DB.prepare('UPDATE items SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = ?').bind(id),
    logStmt(env, me, 'restored', id, row.title, [{ f: 'From', t: 'text', a: row.archive_reason || 'archived' }]),
  ]);
  const fresh = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  return { item: itemOut(fresh) };
}

async function listArchived(env) {
  const { results } = await env.DB.prepare('SELECT * FROM items WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 500').all();
  return { items: results.map(itemOut) };
}

// ---------------------------------------------------------------------------
// Custom field values
// ---------------------------------------------------------------------------
async function mergeCustom(env, current, incoming) {
  const out = { ...current };
  if (incoming === undefined || incoming === null) return out;
  if (typeof incoming !== 'object' || Array.isArray(incoming)) fail(400, 'bad_input');
  const keys = Object.keys(incoming);
  if (!keys.length) return out;

  const [fieldsRes, peopleRes] = await env.DB.batch([
    env.DB.prepare('SELECT id, type, options_json, hidden_at FROM fields'),
    env.DB.prepare('SELECT id FROM people'),
  ]);
  const fields = new Map(fieldsRes.results.map((f) => [f.id, f]));
  const peopleIds = new Set(peopleRes.results.map((p) => p.id));

  for (const key of keys) {
    const field = fields.get(key);
    // Unknown or hidden fields are skipped quietly. A field can get hidden
    // while someone has the edit screen open, and that shouldn't block a save.
    if (!field || field.hidden_at) continue;
    const v = cleanValue(field, incoming[key], peopleIds);
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  return out;
}

// Returns undefined for "empty", a clean value, or throws bad_input.
function cleanValue(field, v, peopleIds) {
  if (v === null || v === undefined || v === '') return undefined;
  switch (field.type) {
    case 'text': {
      if (typeof v !== 'string') fail(400, 'bad_input');
      const s = v.trim().slice(0, LIMITS.text);
      return s || undefined;
    }
    case 'link': {
      if (typeof v !== 'string') fail(400, 'bad_input');
      let s = v.trim().slice(0, LIMITS.text);
      if (!s) return undefined;
      if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
      let u;
      try {
        u = new URL(s);
      } catch {
        fail(400, 'bad_link');
      }
      if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) fail(400, 'bad_link');
      return u.toString();
    }
    case 'number':
    case 'price': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) fail(400, 'bad_number');
      return field.type === 'price' ? Math.round(n * 100) / 100 : n;
    }
    case 'date': {
      if (typeof v !== 'string' || !DATE_RE.test(v)) fail(400, 'bad_input');
      return v;
    }
    case 'dropdown': {
      const opts = safeParse(field.options_json, []);
      if (typeof v !== 'string' || !opts.includes(v)) fail(400, 'bad_input');
      return v;
    }
    case 'checkbox': {
      if (typeof v !== 'boolean') fail(400, 'bad_input');
      return v ? true : undefined;
    }
    case 'person': {
      const n = Number(v);
      if (!peopleIds.has(n)) fail(400, 'bad_input');
      return n;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Admin: fields
// ---------------------------------------------------------------------------
async function createField(env, me, body) {
  const label = cleanText(body.label, LIMITS.label);
  if (!label) fail(400, 'need_label');
  if (!FIELD_TYPES.includes(body.type)) fail(400, 'bad_input');
  const options = body.type === 'dropdown' ? cleanOptions(body.options) : [];
  if (body.type === 'dropdown' && !options.length) fail(400, 'need_options');
  const id = 'f_' + randomHex(6);
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM fields').first();
  await env.DB.prepare('INSERT INTO fields (id, label, type, options_json, sort_order) VALUES (?, ?, ?, ?, ?)')
    .bind(id, label, body.type, JSON.stringify(options), max.m + 1)
    .run();
  await log(env, me, 'field_added', null, null, [{ f: label, t: body.type }]);
  return { field: fieldOut(await env.DB.prepare('SELECT * FROM fields WHERE id = ?').bind(id).first()) };
}

async function updateField(env, me, id, body) {
  const field = await env.DB.prepare('SELECT * FROM fields WHERE id = ?').bind(id).first();
  if (!field) fail(404, 'not_found');

  if (body.label !== undefined) {
    const label = cleanText(body.label, LIMITS.label);
    if (!label) fail(400, 'need_label');
    await env.DB.prepare('UPDATE fields SET label = ? WHERE id = ?').bind(label, id).run();
    if (label !== field.label) {
      await log(env, me, 'field_renamed', null, null, [{ f: 'Field', t: 'text', a: field.label, b: label }]);
    }
  }
  if (body.options !== undefined) {
    if (field.type !== 'dropdown') fail(400, 'bad_input');
    const options = cleanOptions(body.options);
    if (!options.length) fail(400, 'need_options');
    await env.DB.prepare('UPDATE fields SET options_json = ? WHERE id = ?').bind(JSON.stringify(options), id).run();
    await log(env, me, 'field_choices', null, null, [{ f: field.label, t: 'text', b: options.join(', ') }]);
  }
  if (body.hidden !== undefined) {
    // Hiding never touches stored values on items.
    await env.DB.prepare('UPDATE fields SET hidden_at = ? WHERE id = ?').bind(body.hidden ? Date.now() : null, id).run();
    if (!!body.hidden !== !!field.hidden_at) {
      await log(env, me, body.hidden ? 'field_hidden' : 'field_shown', null, null, [{ f: field.label, t: field.type }]);
    }
  }
  if (body.move === 'up' || body.move === 'down') {
    const { results } = await env.DB.prepare('SELECT id, sort_order FROM fields ORDER BY sort_order, id').all();
    const i = results.findIndex((f) => f.id === id);
    const j = body.move === 'up' ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < results.length) {
      // Renumber everything so ties can't get stuck.
      const order = results.map((f) => f.id);
      [order[i], order[j]] = [order[j], order[i]];
      await env.DB.batch(order.map((fid, n) => env.DB.prepare('UPDATE fields SET sort_order = ? WHERE id = ?').bind(n + 1, fid)));
    }
  }
  return { field: fieldOut(await env.DB.prepare('SELECT * FROM fields WHERE id = ?').bind(id).first()) };
}

function cleanOptions(list) {
  if (!Array.isArray(list)) fail(400, 'bad_input');
  const seen = new Set();
  const out = [];
  for (const o of list) {
    const s = cleanText(o, LIMITS.option);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out.slice(0, LIMITS.options);
}

// ---------------------------------------------------------------------------
// Admin: people
// ---------------------------------------------------------------------------
async function regenerateKey(env, me, personId) {
  const person = await env.DB.prepare('SELECT id, name FROM people WHERE id = ?').bind(personId).first();
  if (!person) fail(404, 'not_found');
  const key = randomToken(32);
  // Replacing the hash kills the old link on the very next request.
  await env.DB.batch([
    env.DB.prepare('UPDATE people SET key_hash = ?, revoked_at = NULL WHERE id = ?').bind(await sha256hex(key), personId),
    logStmt(env, me, 'new_link', null, null, [{ f: 'Person', t: 'text', b: person.name }]),
  ]);
  // The raw key leaves the Worker exactly once, in this response.
  return { key };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '7200',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function withHeaders(res, extra) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'too_big');
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(400, 'bad_input');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'bad_input');
  return body;
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanNote(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(400, 'bad_input');
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, LIMITS.note);
}

function cleanDue(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) fail(400, 'bad_input');
  return v;
}

function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
