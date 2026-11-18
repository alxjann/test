'use strict';

/* Playtopia Proxy — renderer (vanilla JS).
 * All traffic content is untrusted: it is only ever written with textContent. */

const api = window.proxyAPI;
const $ = (id) => document.getElementById(id);

const RULES_KEY = 'playtopia.rules.v1';
const MAX_LOG = 3000;
const NO_TRAFFIC_HINT_MS = 60000;

const state = {
  rules: loadRules(),
  stats: {}, // rule id -> { hits, lastMiss }
  backendRuleIds: null, // from backend 'state' events
  paused: false,
  connected: false,
  status: null,
  schema: null,
  diag: null,
  filter: { text: '', kinds: new Set(['rest', 'ws', 'rule', 'error']) },
  entries: [],
  trafficSeen: false,
  connectedAt: 0,
  editingId: null,
  dismissed: new Set(),
};

// ===================================================================== utils

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtTime(ts) {
  const d = new Date((ts || Date.now() / 1000) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function fmtBytes(n) {
  if (n == null) return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function pretty(text) {
  if (text == null || text === '') return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text); }
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ===================================================================== persistence

function loadRules() {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    const rules = raw ? JSON.parse(raw) : [];
    return Array.isArray(rules) ? rules.filter((r) => r && typeof r.id === 'string') : [];
  } catch {
    return [];
  }
}

function saveRules() {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(state.rules)); } catch { /* storage unavailable */ }
}

// ===================================================================== backend sync

function send(cmd) { api.sendCommand(cmd); }

function syncAll() {
  send({ type: 'clear_rules' });
  for (const r of state.rules) send({ type: 'set_rule', rule: r });
  send({ type: 'set_paused', paused: state.paused });
}

function isWildcard(rule) {
  const m = rule.match || {};
  const relevant = rule.target === 'rest'
    ? ['method', 'path_contains', 'direction', 'contains']
    : ['event', 'path_contains', 'direction', 'contains'];
  return !relevant.some((k) => m[k]);
}

// ===================================================================== JSON-schema validation
// Supports the subset used by shared/rules_schema.json.

function typeOk(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}

function validate(schema, v, p = 'rule', errs = []) {
  if (!schema || schema === true) return errs;
  if ('const' in schema && !deepEqual(v, schema.const)) errs.push(`${p} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, v))) errs.push(`${p} must be one of: ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeOk(t, v))) { errs.push(`${p} must be ${types.join(' or ')}`); return errs; }
  }
  if (typeof v === 'string' && schema.minLength != null && v.length < schema.minLength) errs.push(`${p} must not be empty`);
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${p} needs at least ${schema.minItems} item(s)`);
    if (schema.items) v.forEach((x, i) => validate(schema.items, x, `${p}[${i}]`, errs));
  }
  if (typeOk('object', v)) {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${p}.${r} is required`);
    const props = schema.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) validate(props[k], x, `${p}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${p}.${k} is not allowed`);
    }
  }
  for (const sub of schema.allOf || []) {
    if (sub.if) {
      const branch = validate(sub.if, v, p, []).length === 0 ? sub.then : sub.else;
      if (branch) validate(branch, v, p, errs);
    } else {
      validate(sub, v, p, errs);
    }
  }
  return [...new Set(errs)];
}

// ===================================================================== traffic log

const logEl = $('log');
let pendingRows = [];
let flushScheduled = false;

function kindOf(ev) {
  switch (ev.type) {
    case 'rest': return 'rest';
    case 'ws': case 'ws_lifecycle': return 'ws';
    case 'rule_applied': return 'rule';
    case 'error': case 'tls_error': return 'error';
    default: return 'log';
  }
}

function describe(ev) {
  switch (ev.type) {
    case 'rest': {
      const isReq = ev.direction === 'request';
      const bits = isReq
        ? [`${ev.method} ${ev.path}`]
        : [`${ev.status} ${ev.method} ${ev.path}`, ev.duration_ms != null ? `${ev.duration_ms} ms` : null, ev.body ? fmtBytes(ev.body.length) : null];
      return { badge: 'REST', dir: isReq ? '→' : '←', dirTitle: isReq ? 'request (client→server)' : 'response (server→client)', summary: bits.filter(Boolean).join(' · '), status: ev.status };
    }
    case 'ws': {
      const out = ev.direction === 'client';
      let summary;
      if (ev.is_binary) summary = `binary frame · ${fmtBytes(ev.length)}`;
      else if (ev.event) summary = `${ev.topic} · ${ev.event}${ev.ref != null ? ` · ref ${ev.ref}` : ''} · ${fmtBytes(ev.length)}${ev.phx_version ? ` · ${ev.phx_version}` : ''}`;
      else summary = `${(ev.text || '').slice(0, 120)} · ${fmtBytes(ev.length)}`;
      return { badge: 'WS', dir: out ? '→' : '←', dirTitle: out ? 'client→server' : 'server→client', summary };
    }
    case 'ws_lifecycle':
      return { badge: 'WS', dir: '•', dirTitle: 'lifecycle', summary: `WebSocket ${ev.state} ${ev.path || ''}${ev.close_code != null ? ` (code ${ev.close_code})` : ''}` };
    case 'rule_applied':
      return { badge: 'RULE', dir: '✎', dirTitle: 'rule fired', summary: `${ev.rule_id}${ev.action ? ` [${ev.action}]` : ''} → ${ev.flow_summary}` };
    case 'tls_error':
      return { badge: 'TLS', dir: '!', dirTitle: 'TLS failure', summary: ev.message };
    case 'error':
      return { badge: 'ERR', dir: '!', dirTitle: 'error', summary: ev.message };
    case 'hello':
      return { badge: 'LOG', dir: '•', dirTitle: '', summary: `Backend ${ev.version || ''} connected · intercepting ${ev.target_host}` };
    case 'backend_log':
      return { badge: 'LOG', dir: ev.stream === 'stderr' ? '!' : '•', dirTitle: ev.stream, summary: ev.line };
    default:
      return { badge: 'LOG', dir: '•', dirTitle: '', summary: JSON.stringify(ev).slice(0, 300) };
  }
}

function addEntry(ev) {
  const kind = kindOf(ev);
  const d = describe(ev);
  const search = [d.summary, ev.body, ev.text, ev.topic, ev.event, ev.path, ev.message]
    .filter(Boolean).join('\n').toLowerCase();
  const entry = { ev, kind, d, search, node: null };
  state.entries.push(entry);
  pendingRows.push(entry);
  if (!flushScheduled) { flushScheduled = true; requestAnimationFrame(flushRows); }
}

function flushRows() {
  flushScheduled = false;
  const stick = $('autoscroll').checked;
  const frag = document.createDocumentFragment();
  for (const entry of pendingRows) {
    entry.node = renderRow(entry);
    entry.node.hidden = !matchesFilter(entry);
    frag.append(entry.node);
  }
  pendingRows = [];
  logEl.append(frag);
  while (state.entries.length > MAX_LOG) {
    const old = state.entries.shift();
    if (old.node) old.node.remove();
  }
  $('log-count').textContent = `${state.entries.length} entries`;
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function renderRow(entry) {
  const { ev, kind, d } = entry;
  const modified = (ev.rules_applied && ev.rules_applied.length) || ev.original_body || ev.original_text;
  const row = el('div', { class: `row k-${kind}${ev.type === 'tls_error' ? ' k-tls' : ''}`, 'data-kind': kind },
    el('div', { class: 'row-line', role: 'button', tabindex: '0' },
      el('span', { class: 'time', text: fmtTime(ev.timestamp) }),
      el('span', { class: 'badge', text: d.badge }),
      el('span', { class: 'dir', title: d.dirTitle, text: d.dir }),
      el('span', { class: `summary${d.status >= 400 ? ' bad-status' : ''}`, text: d.summary }),
      ev.dropped ? el('span', { class: 'tag tag-drop', text: 'dropped' }) : null,
      modified ? el('span', { class: 'tag tag-mod', text: 'modified' }) : null,
    ));
  const line = row.firstChild;
  const toggle = () => toggleDetail(entry);
  line.addEventListener('click', toggle);
  line.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return row;
}

function toggleDetail(entry) {
  const existing = entry.node.querySelector('.detail');
  if (existing) { existing.remove(); entry.node.classList.remove('open'); return; }
  entry.node.classList.add('open');
  entry.node.append(renderDetail(entry.ev));
}

function renderDetail(ev) {
  const body = ev.type === 'ws' ? ev.text : ev.body;
  const original = ev.type === 'ws' ? ev.original_text : ev.original_body;
  const meta = [];
  if (ev.host) meta.push(['host', ev.host]);
  if (ev.path) meta.push(['path', ev.path]);
  if (ev.type === 'ws') {
    meta.push(['direction', ev.direction === 'client' ? 'client → server' : 'server → client']);
    if (ev.phx_version) meta.push(['phoenix', `${ev.phx_version} · topic ${ev.topic} · event ${ev.event} · ref ${ev.ref}`]);
    if (ev.is_binary) meta.push(['binary', 'hex preview of the first 1024 bytes']);
  }
  if (ev.rules_applied && ev.rules_applied.length) meta.push(['rules', ev.rules_applied.join(', ')]);

  const detail = el('div', { class: 'detail' },
    meta.length ? el('dl', { class: 'meta' }, meta.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])) : null,
    body ? el('div', { class: 'section-title', text: original ? 'Body (after rules)' : 'Body' }) : null,
    body ? el('pre', { class: 'body', text: pretty(body) }) : null,
    original ? el('div', { class: 'section-title', text: 'Original body (before rules)' }) : null,
    original ? el('pre', { class: 'body original', text: pretty(original) }) : null,
  );
  if (ev.headers && Object.keys(ev.headers).length) {
    const det = el('details', {}, el('summary', { text: `Headers (${Object.keys(ev.headers).length})` }),
      el('pre', { class: 'body', text: Object.entries(ev.headers).map(([k, v]) => `${k}: ${v}`).join('\n') }));
    detail.append(det);
  }
  const actions = el('div', { class: 'detail-actions' });
  if (ev.type === 'rest' || (ev.type === 'ws' && !ev.is_binary)) {
    actions.append(el('button', { class: 'primary small', text: 'Create rule from this', onclick: (e) => { e.stopPropagation(); openRuleModal(null, prefillFrom(ev)); } }));
  }
  if (body) actions.append(el('button', { class: 'small', text: 'Copy body', onclick: (e) => { e.stopPropagation(); api.copyText(pretty(body)); } }));
  actions.append(el('button', { class: 'small', text: 'Copy event JSON', onclick: (e) => { e.stopPropagation(); api.copyText(JSON.stringify(ev, null, 2)); } }));
  detail.append(actions);
  return detail;
}

function matchesFilter(entry) {
  if (!state.filter.kinds.has(entry.kind)) return false;
  const t = state.filter.text;
  return !t || entry.search.includes(t);
}

function applyFilter() {
  for (const e of state.entries) if (e.node) e.node.hidden = !matchesFilter(e);
}

// ===================================================================== rules panel

function renderRules() {
  const list = $('rule-list');
  list.replaceChildren();
  $('rules-empty').hidden = state.rules.length > 0;
  for (const rule of state.rules) list.append(renderRuleCard(rule));
  renderSyncStatus();
}

function matchSummary(rule) {
  const m = rule.match || {};
  const parts = [];
  if (rule.target === 'rest' && m.method) parts.push(m.method);
  if (rule.target === 'ws' && m.event) parts.push(`event=${m.event}`);
  if (m.direction) parts.push(m.direction === 'client' ? 'client→server' : 'server→client');
  if (m.path_contains) parts.push(`path∋"${m.path_contains}"`);
  if (m.contains) parts.push(`body∋"${m.contains}"`);
  return parts.length ? parts.join(' · ') : 'anything (wildcard)';
}

function actionSummary(a) {
  if (!a) return '';
  if (a.type === 'replace_json_field') return `set ${JSON.stringify(a.path)} = ${JSON.stringify(a.value)}`;
  if (a.type === 'string_replace') return `replace "${a.from}" → "${a.to}"`;
  if (a.type === 'drop') return 'drop frame';
  return a.type;
}

function renderRuleCard(rule) {
  const st = state.stats[rule.id] || { hits: 0 };
  const enabled = rule.enabled !== false;
  const onBackend = state.backendRuleIds ? state.backendRuleIds.includes(rule.id) : null;
  const card = el('div', { class: `rule${enabled ? '' : ' disabled'}` },
    el('div', { class: 'rule-top' },
      el('label', { class: 'switch', title: enabled ? 'Disable rule' : 'Enable rule' },
        el('input', { type: 'checkbox', checked: enabled, 'aria-label': `Enable rule ${rule.id}`, onchange: (e) => setEnabled(rule.id, e.target.checked) }),
        el('span', { class: 'slider' })),
      el('span', { class: `badge t-${rule.target}`, text: rule.target === 'rest' ? 'REST' : 'WS' }),
      el('span', { class: 'rule-id', text: rule.id, title: rule.id }),
      el('span', { class: 'hits', title: 'times this rule modified traffic', text: `${st.hits} hit${st.hits === 1 ? '' : 's'}` }),
      onBackend === false && state.connected ? el('span', { class: 'tag tag-warn', text: 'not on backend' }) : null,
      el('button', { class: 'small', text: 'Edit', onclick: () => openRuleModal(rule) }),
      el('button', { class: 'small danger', text: 'Delete', 'aria-label': `Delete rule ${rule.id}`, onclick: () => deleteRule(rule.id) }),
    ),
    el('div', { class: 'rule-line' }, el('span', { class: 'k', text: 'match' }), el('span', { text: matchSummary(rule) })),
    el('div', { class: 'rule-line' }, el('span', { class: 'k', text: 'action' }), el('span', { text: actionSummary(rule.action) })),
    isWildcard(rule) ? el('div', { class: 'rule-warn', text: `⚠ Wildcard: applies to every ${rule.target === 'rest' ? 'REST request and response' : 'WebSocket frame'}.` }) : null,
    st.lastMiss ? el('div', { class: 'rule-miss', text: `last match without change: ${st.lastMiss}` }) : null,
  );
  return card;
}

function renderSyncStatus() {
  const s = $('sync-status');
  if (!state.connected) { s.textContent = 'Backend offline: rules will be sent when it connects.'; return; }
  if (state.backendRuleIds == null) { s.textContent = 'Syncing rules…'; return; }
  const ok = state.rules.filter((r) => state.backendRuleIds.includes(r.id)).length;
  s.textContent = `Backend has ${ok}/${state.rules.length} rule(s)${state.paused ? ' · paused' : ''}`;
}

function upsertRule(rule, previousId) {
  if (previousId && previousId !== rule.id) {
    state.rules = state.rules.filter((r) => r.id !== previousId);
    send({ type: 'delete_rule', id: previousId });
  }
  const i = state.rules.findIndex((r) => r.id === rule.id);
  if (i >= 0) state.rules[i] = rule; else state.rules.push(rule);
  saveRules();
  send({ type: 'set_rule', rule });
  renderRules();
}

function setEnabled(id, enabled) {
  const r = state.rules.find((x) => x.id === id);
  if (!r) return;
  r.enabled = enabled;
  saveRules();
  send({ type: 'set_rule', rule: r });
  renderRules();
}

function deleteRule(id) {
  state.rules = state.rules.filter((r) => r.id !== id);
  delete state.stats[id];
  saveRules();
  send({ type: 'delete_rule', id });
  renderRules();
}

// ===================================================================== rule modal

const ruleModal = $('rule-modal');

function formTarget() { return document.querySelector('input[name="target"]:checked').value; }

function updateFormVisibility() {
  const target = formTarget();
  ruleModal.querySelectorAll('.only-rest').forEach((n) => { n.hidden = target !== 'rest'; });
  ruleModal.querySelectorAll('.only-ws').forEach((n) => { n.hidden = target !== 'ws'; });
  const dropOpt = ruleModal.querySelector('.only-ws-opt');
  dropOpt.disabled = target !== 'ws';
  if (target !== 'ws' && $('f-action').value === 'drop') $('f-action').value = 'replace_json_field';
  const action = $('f-action').value;
  ruleModal.querySelectorAll('[data-action]').forEach((n) => { n.hidden = n.dataset.action !== action; });
  const draft = readForm(true);
  $('wildcard-warning').classList.toggle('hidden', !isWildcard(draft));
  $('wildcard-target').textContent = target === 'rest' ? 'REST' : 'WebSocket';
  updateValuePreview();
}

function parseValue(raw) {
  const t = raw.trim();
  if (t === '') return { value: '', note: 'empty string' };
  try {
    const v = JSON.parse(t);
    const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    return { value: v, note: `${kind}` };
  } catch {
    return { value: raw, note: 'string (not valid JSON, used as text)' };
  }
}

function updateValuePreview() {
  const { value, note } = parseValue($('f-value').value);
  $('value-preview').textContent = `→ ${note}: ${JSON.stringify(value)}`;
}

function parsePath(raw) {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    const v = JSON.parse(t); // throws -> reported as error
    if (!Array.isArray(v)) throw new Error('JSON path must be an array');
    return v;
  }
  return t.split('.').map((s) => s.trim()).filter((s) => s !== '').map((s) => (/^-?\d+$/.test(s) ? Number(s) : s));
}

function readForm(lenient = false) {
  const target = formTarget();
  const match = {};
  const set = (k, v) => { if (v && v.trim()) match[k] = v.trim(); };
  if (target === 'rest') set('method', $('f-method').value);
  if (target === 'ws') set('event', $('f-event').value);
  set('direction', $('f-direction').value);
  set('path_contains', $('f-path').value);
  set('contains', $('f-contains').value);

  const type = $('f-action').value;
  const action = { type };
  if (type === 'replace_json_field') {
    try { action.path = parsePath($('f-jpath').value); } catch (e) { if (!lenient) throw new Error(`JSON path: ${e.message}`); action.path = []; }
    action.value = parseValue($('f-value').value).value;
  } else if (type === 'string_replace') {
    action.from = $('f-from').value;
    action.to = $('f-to').value;
  }
  const id = $('f-id').value.trim() || state.editingId || `rule-${Date.now().toString(36)}`;
  return { id, enabled: $('f-enabled').checked, target, match, action };
}

function prefillFrom(ev) {
  if (ev.type === 'rest') {
    return {
      target: 'rest',
      match: { method: ev.method, path_contains: (ev.path || '').split('?')[0], direction: ev.direction === 'request' ? 'client' : 'server' },
      action: { type: 'replace_json_field', path: [], value: '' },
    };
  }
  return {
    target: 'ws',
    match: { event: ev.event || undefined, direction: ev.direction },
    action: { type: 'replace_json_field', path: ['payload'], value: '' },
  };
}

function openRuleModal(rule, prefill) {
  state.editingId = rule ? rule.id : null;
  const r = rule || { enabled: true, target: 'rest', match: {}, action: { type: 'replace_json_field', path: [], value: '' }, ...prefill };
  const m = r.match || {};
  const a = r.action || {};
  $('rule-modal-title').textContent = rule ? `Edit Rule: ${rule.id}` : 'Add Rule';
  $('f-id').value = rule ? rule.id : '';
  document.querySelector(`input[name="target"][value="${r.target === 'ws' ? 'ws' : 'rest'}"]`).checked = true;
  $('f-method').value = m.method || '';
  $('f-event').value = m.event || '';
  $('f-direction').value = m.direction || '';
  $('f-path').value = m.path_contains || '';
  $('f-contains').value = m.contains || '';
  $('f-action').value = a.type || 'replace_json_field';
  $('f-jpath').value = a.path && a.path.length ? JSON.stringify(a.path) : '';
  $('f-value').value = a.type === 'replace_json_field' && rule ? JSON.stringify(a.value) : '';
  $('f-from').value = a.from || '';
  $('f-to').value = a.to || '';
  $('f-enabled').checked = r.enabled !== false;
  $('rule-errors').replaceChildren();
  updateFormVisibility();
  ruleModal.showModal();
  (rule ? $('f-id') : $('f-path')).focus();
}

function saveFromForm(e) {
  e.preventDefault();
  const errorsEl = $('rule-errors');
  errorsEl.replaceChildren();
  let rule;
  try { rule = readForm(); } catch (err) { errorsEl.append(el('li', { text: err.message })); return; }

  const errors = state.schema ? validate(state.schema, rule) : [];
  if (rule.action.type === 'replace_json_field' && (!rule.action.path || !rule.action.path.length)) errors.push('JSON path is required');
  if (rule.action.type === 'string_replace' && !rule.action.from) errors.push('"Find" must not be empty');
  if (rule.id !== state.editingId && state.rules.some((r) => r.id === rule.id)) errors.push(`A rule with id "${rule.id}" already exists`);
  if (errors.length) { errorsEl.append(...errors.map((m) => el('li', { text: m }))); return; }

  upsertRule(rule, state.editingId);
  ruleModal.close();
}

// ===================================================================== banners

function setBanner(id, level, message, actions = []) {
  let node = document.querySelector(`[data-banner="${id}"]`);
  if (!message || state.dismissed.has(id)) { if (node) node.remove(); return; }
  const content = [
    el('span', { class: 'banner-text', text: message }),
    ...actions.map(([label, fn]) => el('button', { class: 'small', text: label, onclick: fn })),
    el('button', { class: 'small ghost', text: 'Dismiss', onclick: () => { state.dismissed.add(id); setBanner(id, null, null); } }),
  ];
  if (!node) { node = el('div', { class: `banner b-${level}`, 'data-banner': id, role: 'alert' }); $('banners').append(node); }
  node.className = `banner b-${level}`;
  node.replaceChildren(...content);
}

async function refreshDiagnostics() {
  try { state.diag = await api.getDiagnostics(); } catch { return; }
  const d = state.diag;
  if (!d.certExists) {
    setBanner('cert', 'error', 'mitmproxy CA certificate not generated yet. It is created the first time the backend starts.', [['Certificate Setup', openCertModal]]);
  } else if (!d.certInstalled) {
    setBanner('cert', 'error', 'CA certificate is NOT trusted by Windows. HTTPS interception will fail and you will see no game traffic.', [['Install now', installCert], ['Certificate Setup', openCertModal]]);
  } else {
    setBanner('cert', null, null);
  }
  if (!d.systemProxyOk) {
    setBanner('proxy', 'warn', `System proxy is not set to ${d.proxyAddress}. Game traffic will bypass the proxy.`, [['Enable proxy', () => toggleProxy(true)], ['Setup', openCertModal]]);
  } else {
    setBanner('proxy', null, null);
  }
  if ($('cert-modal').open) renderCertModal();
}

function checkNoTraffic() {
  const show = state.connected && !state.paused && !state.trafficSeen && state.connectedAt && Date.now() - state.connectedAt > NO_TRAFFIC_HINT_MS;
  setBanner('notraffic', 'info', show ? 'No Playtopia traffic seen yet. Is the game running (restarted after setup), the certificate installed, and the system proxy set?' : null, [['Certificate Setup', openCertModal]]);
}

// ===================================================================== certificate modal

const certModal = $('cert-modal');

function renderCertModal() {
  const d = state.diag;
  if (!d) return;
  const certOk = d.certInstalled;
  $('cert-state').textContent = certOk ? '✓' : '✗';
  $('cert-state').className = `step-state ${certOk ? 'ok' : 'bad'}`;
  $('cert-path').textContent = d.certExists ? d.certPath : `${d.certPath} (not generated yet: start the backend once)`;
  $('cert-cmd').textContent = d.installCommand;
  $('uninstall-cmd').textContent = d.uninstallCommand;
  $('btn-install-cert').disabled = !d.certExists;
  if (certOk) $('cert-msg').textContent = `Trusted (${[d.certInMachineStore && 'machine', d.certInUserStore && 'user'].filter(Boolean).join(' + ')} Root store).`;

  $('proxy-state').textContent = d.systemProxyOk ? '✓' : '✗';
  $('proxy-state').className = `step-state ${d.systemProxyOk ? 'ok' : 'bad'}`;
  $('proxy-addr-2').textContent = d.proxyAddress;
  const p = d.systemProxy;
  $('proxy-current').textContent = p.enabled ? `enabled → ${p.server || '(no server)'}` : `disabled${p.server ? ` (server set to ${p.server})` : ''}`;
}

async function openCertModal() {
  await refreshDiagnostics();
  renderCertModal();
  if (!certModal.open) certModal.showModal();
}

async function installCert() {
  $('cert-msg').textContent = 'Waiting for the administrator prompt…';
  const r = await api.installCertificate();
  $('cert-msg').textContent = r.message;
  await refreshDiagnostics();
}

async function toggleProxy(on) {
  state.diag = await api.setSystemProxy(on);
  await refreshDiagnostics();
}

// ===================================================================== status / events

function renderStatus() {
  const s = state.status || {};
  const node = $('status');
  let text; let st;
  if (state.connected) { text = 'Backend: connected'; st = 'up'; }
  else if (s.backendState === 'starting' || s.backendState === 'running') { text = 'Backend: starting…'; st = 'wait'; }
  else { text = 'Backend: disconnected'; st = 'down'; }
  if (!state.connected && s.lastError) text += `: ${s.lastError}`;
  node.dataset.state = st;
  $('status-text').textContent = text;
  $('status').title = s.pid ? `pid ${s.pid} · ${s.mode}` : (s.mode || '');
  $('proxy-addr').textContent = `proxy 127.0.0.1:${s.proxyPort || 8080}`;
  $('btn-restart').classList.toggle('hidden', state.connected || s.spawnBackend === false || s.backendState === 'starting');
  $('btn-pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('btn-pause').classList.toggle('active', state.paused);
  $('paused-chip').classList.toggle('hidden', !state.paused);
}

function setConnected(connected) {
  if (connected === state.connected) return;
  state.connected = connected;
  state.connectedAt = connected ? Date.now() : 0;
  if (!connected) state.backendRuleIds = null;
  renderStatus();
  renderRules();
}

function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'backend_status': {
      const wasRunning = state.status && state.status.backendState === 'running';
      state.status = ev;
      setConnected(ev.bridgeConnected);
      renderStatus();
      if (ev.backendState === 'running' && !wasRunning) refreshDiagnostics();
      return;
    }
    case 'hello':
      setConnected(true);
      syncAll();
      addEntry(ev);
      refreshDiagnostics();
      return;
    case 'state':
      state.backendRuleIds = ev.rule_ids || [];
      renderRules();
      return;
    case 'rule_applied': {
      const st = state.stats[ev.rule_id] || (state.stats[ev.rule_id] = { hits: 0 });
      st.hits++;
      st.lastMiss = null;
      scheduleRulesRender();
      addEntry(ev);
      return;
    }
    case 'rule_noop': {
      const st = state.stats[ev.rule_id] || (state.stats[ev.rule_id] = { hits: 0 });
      st.lastMiss = `${ev.reason} (${ev.flow_summary})`;
      scheduleRulesRender();
      return;
    }
    case 'tls_error':
      setBanner('tls', 'error', `TLS interception failed for ${ev.host}. The game does not trust the mitmproxy certificate. Install it, then restart the game.`, [['Certificate Setup', openCertModal]]);
      addEntry(ev);
      return;
    case 'rest': case 'ws':
      if (!state.trafficSeen) { state.trafficSeen = true; checkNoTraffic(); }
      addEntry(ev);
      return;
    default:
      addEntry(ev);
  }
}

let rulesRenderTimer = null;
function scheduleRulesRender() {
  if (rulesRenderTimer) return;
  rulesRenderTimer = setTimeout(() => { rulesRenderTimer = null; renderRules(); }, 250);
}

// ===================================================================== wiring

function wire() {
  $('btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    send({ type: 'set_paused', paused: state.paused });
    renderStatus();
    renderSyncStatus();
  });
  $('btn-restart').addEventListener('click', async () => {
    $('btn-restart').classList.add('hidden');
    state.status = await api.restartBackend();
    renderStatus();
  });
  $('btn-cert').addEventListener('click', openCertModal);

  $('filter-text').addEventListener('input', (e) => { state.filter.text = e.target.value.trim().toLowerCase(); applyFilter(); });
  document.querySelectorAll('.toggle').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.kind;
    const on = !state.filter.kinds.has(k);
    if (on) state.filter.kinds.add(k); else state.filter.kinds.delete(k);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    applyFilter();
  }));
  $('btn-clear-log').addEventListener('click', () => {
    state.entries = [];
    logEl.replaceChildren();
    $('log-count').textContent = '0 entries';
  });

  $('btn-add-rule').addEventListener('click', () => openRuleModal(null));
  $('btn-clear-rules').addEventListener('click', () => {
    if (!state.rules.length) return;
    if (!confirm(`Delete all ${state.rules.length} rule(s)?`)) return;
    state.rules = [];
    state.stats = {};
    saveRules();
    send({ type: 'clear_rules' });
    renderRules();
  });

  $('rule-form').addEventListener('submit', saveFromForm);
  $('rule-cancel').addEventListener('click', () => ruleModal.close());
  ruleModal.addEventListener('input', (e) => { if (e.target.id !== 'f-id') updateFormVisibility(); });
  ruleModal.addEventListener('change', updateFormVisibility);

  $('cert-close').addEventListener('click', () => certModal.close());
  $('btn-recheck').addEventListener('click', refreshDiagnostics);
  $('btn-install-cert').addEventListener('click', installCert);
  $('btn-open-cert-folder').addEventListener('click', () => api.openCertFolder());
  $('btn-proxy-on').addEventListener('click', () => toggleProxy(true));
  $('btn-proxy-off').addEventListener('click', () => toggleProxy(false));
  certModal.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    api.copyText($(b.dataset.copy).textContent);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  }));
}

async function init() {
  wire();
  renderRules();
  renderStatus();
  api.onEvent(handleEvent);
  try { state.schema = await api.getRulesSchema(); } catch { state.schema = null; }
  const s = await api.getBackendStatus();
  state.status = s;
  setConnected(s.bridgeConnected);
  if (s.bridgeConnected) syncAll(); // backend connected before this page loaded
  renderStatus();
  refreshDiagnostics();
  setInterval(checkNoTraffic, 5000);
}

init();
