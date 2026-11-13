// GCS Studio Build: front end.
// Plain JS, no build step. Never shows technical errors to the person using it.
(function () {
  'use strict';

  var API = String((window.GCS_CONFIG && window.GCS_CONFIG.apiBase) || '').replace(/\/+$/, '');
  var POLL_MS = 25000;
  var LS_KEY = 'gcs_studio_key';
  var LS_COLLAPSED = 'gcs_studio_collapsed';
  var DESKTOP = window.matchMedia('(min-width: 900px) and (pointer: fine)');

  var MSG = {
    offline: "Can't reach the board right now. Check your internet and try again.",
    server: 'Something went wrong on our end. Give it a minute and try again.',
    slow_down: 'Too many tries from here. Wait 15 minutes, then try again.',
    bad_input: "That didn't save. Check what you typed and try again.",
    bad_link: "That link doesn't look right. Try copying it again.",
    bad_number: 'Numbers only there, like 2 or 19.99.',
    need_title: 'Give it a name first.',
    need_label: 'Give the field a name first.',
    need_options: 'Add at least one choice, one per line.',
    gone: 'Someone archived that item, so it is off the board now.',
    not_found: "Couldn't find that one. It may have been archived.",
    not_allowed: 'Only Yeti can do that.',
    too_late: 'Too late to undo that one. Ask Yeti to bring it back.',
    too_big: "That's too much text for one item. Try making it shorter.",
  };
  var BAD_LINK_TEXT = "This link isn't valid. Ask Yeti for yours.";

  var FIELD_TYPE_NAMES = {
    text: 'Text',
    link: 'Link',
    number: 'Number',
    price: 'Price',
    date: 'Date',
    dropdown: 'Dropdown (pick one)',
    checkbox: 'Checkbox (yes or no)',
    person: 'Person (Greg, Chris or Yeti)',
  };

  var state = {
    key: null,
    keyFromLink: false,
    me: null,
    people: [],
    statuses: [],
    fields: [],
    items: [],
    view: 'board',
    adminTab: 'people',
    archived: null,
    sig: '',
    renderPending: false,
    dragging: false,
    savingIds: {},
    offline: false,
    started: false,
    lastRefresh: 0,
  };
  state.collapsed = loadCollapsed();

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  // -------------------------------------------------------------------------
  // Tiny DOM helper. Everything goes through textContent, never innerHTML.
  // -------------------------------------------------------------------------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // -------------------------------------------------------------------------
  // Key handling
  // -------------------------------------------------------------------------
  function readKey() {
    var m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]+)/);
    if (m) return { key: m[1], fromLink: true };
    try {
      var k = localStorage.getItem(LS_KEY);
      if (k) return { key: k, fromLink: false };
    } catch (e) { /* storage blocked */ }
    return null;
  }
  function saveKey(k) { try { localStorage.setItem(LS_KEY, k); } catch (e) { /* fine */ } }
  function forgetKey() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* fine */ } }

  function loadCollapsed() {
    try { return JSON.parse(localStorage.getItem(LS_COLLAPSED)) || {}; } catch (e) { return {}; }
  }
  function saveCollapsed() {
    try { localStorage.setItem(LS_COLLAPSED, JSON.stringify(state.collapsed)); } catch (e) { /* fine */ }
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  function AppError(code, status, data) {
    this.code = code;
    this.status = status || 0;
    this.data = data || null;
  }
  function friendly(err) {
    var code = err && err.code;
    return MSG[code] || MSG.server;
  }

  function api(method, path, body) {
    var headers = { Authorization: 'Bearer ' + state.key };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }).then(
      function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new AppError((data && data.error) || 'server', res.status, data);
          return data || {};
        });
      },
      function () { throw new AppError('offline'); }
    );
  }

  // -------------------------------------------------------------------------
  // Start up
  // -------------------------------------------------------------------------
  function start() {
    var found = readKey();
    if (!found) return showGate(BAD_LINK_TEXT);
    if (!API || /YOUR-ACCOUNT/.test(API)) {
      return showGate("The board isn't hooked up yet. Ask Yeti.");
    }
    state.key = found.key;
    state.keyFromLink = found.fromLink;
    showGate('Loading the board...', null, true);

    api('GET', '/api/board').then(
      function (data) {
        saveKey(state.key);
        applyBoard(data, true);
        if (!state.started) {
          state.started = true;
          startPolling();
        }
      },
      function (err) {
        if (err.code === 'bad_key') {
          if (!state.keyFromLink) forgetKey();
          showGate(BAD_LINK_TEXT);
        } else {
          showGate(friendly(err), start);
        }
      }
    );
  }

  function showGate(text, retry, quiet) {
    clear(app);
    app.appendChild(
      h('div', { class: 'gate' },
        h('div', { class: 'gate-card' },
          h('h1', { text: 'GCS Studio Build' }),
          h('p', { class: quiet ? 'loading' : null, text: text }),
          retry ? h('button', { class: 'btn btn-primary btn-wide', type: 'button', onclick: retry, text: 'Try again' }) : null
        )
      )
    );
  }

  // -------------------------------------------------------------------------
  // Keeping in sync: refetch on focus and every 25 seconds while visible
  // -------------------------------------------------------------------------
  function startPolling() {
    setInterval(function () {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
    window.addEventListener('focus', function () { refresh(); });
    // If a re-render was put off while someone was using a dropdown, do it now.
    document.addEventListener('focusout', function () {
      setTimeout(function () { if (state.renderPending && !isBusy()) render(); }, 50);
    });
  }

  function refresh() {
    if (!state.me) return Promise.resolve();
    var now = Date.now();
    if (now - state.lastRefresh < 2000) return Promise.resolve();
    state.lastRefresh = now;
    return api('GET', '/api/board').then(
      function (data) {
        if (state.offline) { state.offline = false; showBanner(null); }
        applyBoard(data, false);
      },
      function (err) {
        if (err.code === 'bad_key') {
          // Their link was replaced while the page was open.
          if (!state.keyFromLink) forgetKey();
          state.me = null;
          closeOverlays();
          showGate(BAD_LINK_TEXT);
          return;
        }
        state.offline = true;
        showBanner(friendly(err));
      }
    );
  }

  function applyBoard(data, force) {
    var sig = JSON.stringify([data.items, data.fields, data.people, data.statuses, data.me]);
    var changed = sig !== state.sig;
    state.sig = sig;
    state.me = data.me;
    state.people = data.people || [];
    state.statuses = data.statuses || [];
    state.fields = data.fields || [];
    state.items = data.items || [];
    if (force || !app.querySelector('.top')) return render();
    if (!changed) return;
    if (state.view !== 'board') return; // admin screen redraws itself
    if (isBusy()) state.renderPending = true;
    else render();
  }

  function isBusy() {
    if (state.dragging) return true;
    var a = document.activeElement;
    return !!(a && app.contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName));
  }

  // -------------------------------------------------------------------------
  // Lookups and formatting
  // -------------------------------------------------------------------------
  function personName(id) {
    for (var i = 0; i < state.people.length; i++) if (state.people[i].id === id) return state.people[i].name;
    return 'Someone';
  }
  function statusLabel(id) {
    for (var i = 0; i < state.statuses.length; i++) if (state.statuses[i].id === id) return state.statuses[i].label;
    return id;
  }
  function visibleFields() { return state.fields.filter(function (f) { return !f.hidden; }); }
  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function money(n) {
    return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function niceDate(s) {
    var p = String(s).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (isNaN(d)) return s;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function linkText(url) {
    try {
      var u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch (e) { return url; }
  }
  function safeUrl(url) {
    try {
      var u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch (e) { return null; }
  }

  // Shows a custom field value on a card. Returns a node or null when empty.
  function showValue(field, v) {
    if (v === undefined || v === null || v === '') return null;
    switch (field.type) {
      case 'link': {
        var u = safeUrl(v);
        if (!u) return null;
        return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: linkText(u) + ' ↗' });
      }
      case 'price': return money(v);
      case 'number': return Number(v).toLocaleString();
      case 'date': return niceDate(v);
      case 'checkbox': return v ? 'Yes' : null;
      case 'person': return personName(Number(v));
      default: return String(v);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  function render() {
    state.renderPending = false;
    var y = window.scrollY;
    clear(app);
    app.appendChild(renderTop());
    app.appendChild(h('div', { id: 'banner-slot' }));
    var main = h('main', { id: 'main' });
    app.appendChild(main);
    if (state.view === 'admin' && state.me.role === 'admin') renderAdmin(main);
    else {
      state.view = 'board';
      renderBoard(main);
    }
    if (state.offline) showBanner(MSG.offline);
    window.scrollTo(0, y);
  }

  function renderTop() {
    var isAdmin = state.me.role === 'admin';
    return h('header', { class: 'top' },
      h('div', { class: 'brand', text: 'GCS Studio Build' }),
      h('div', { class: 'hello', text: 'Hi ' + state.me.name }),
      isAdmin && state.view === 'board'
        ? h('button', { class: 'btn', type: 'button', onclick: function () { openAdmin('people'); }, text: 'Admin' })
        : null
    );
  }

  function showBanner(text) {
    var slot = document.getElementById('banner-slot');
    if (!slot) return;
    clear(slot);
    if (!text) return;
    slot.appendChild(
      h('div', { class: 'banner', role: 'alert' },
        h('p', { text: text }),
        h('button', {
          class: 'btn', type: 'button', text: 'Try again',
          onclick: function () { state.lastRefresh = 0; refresh(); },
        })
      )
    );
  }

  function renderBoard(main) {
    main.appendChild(
      h('div', { class: 'add-row' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { openEditor(null); }, text: '+ Add an item' })
      )
    );
    var board = h('div', { class: 'board', id: 'board' });
    state.statuses.forEach(function (st) {
      var items = state.items.filter(function (it) { return it.status === st.id; });
      var collapsed = !!state.collapsed[st.id];
      var body = h('div', { class: 'col-body' });
      if (!items.length) body.appendChild(h('p', { class: 'empty', text: 'Nothing here yet' }));
      items.forEach(function (it) { body.appendChild(renderCard(it)); });

      var col = h('section', { class: 'col' + (collapsed ? ' collapsed' : ''), 'data-status': st.id },
        h('button', {
          class: 'col-head', type: 'button', 'aria-expanded': collapsed ? 'false' : 'true',
          onclick: function () {
            if (DESKTOP.matches) return;
            state.collapsed[st.id] = !state.collapsed[st.id];
            saveCollapsed();
            col.classList.toggle('collapsed');
            this.setAttribute('aria-expanded', state.collapsed[st.id] ? 'false' : 'true');
          },
        },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { text: st.label }),
          h('span', { class: 'count', text: String(items.length), 'aria-label': items.length + ' items' }),
          h('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' })
        ),
        body
      );
      wireDrop(col, st.id);
      board.appendChild(col);
    });
    main.appendChild(board);
  }

  function renderCard(it) {
    var fieldRows = [];
    visibleFields().forEach(function (f) {
      var shown = showValue(f, it.custom[f.id]);
      if (shown !== null) fieldRows.push(h('dt', { text: f.label }), h('dd', null, shown));
    });

    var select = h('select', {
      'aria-label': 'Status for ' + it.title,
      disabled: !!state.savingIds[it.id],
      onchange: function () { changeStatus(it.id, this.value); },
    });
    state.statuses.forEach(function (st) {
      select.appendChild(h('option', { value: st.id, selected: st.id === it.status, text: st.label }));
    });

    var meta = 'Added by ' + personName(it.createdBy);
    if (it.updatedAt !== it.createdAt || it.updatedBy !== it.createdBy) {
      meta += '. Changed by ' + personName(it.updatedBy) + ' ' + ago(it.updatedAt) + '.';
    } else {
      meta += ' ' + ago(it.createdAt) + '.';
    }

    var card = h('article', {
      class: 'card' + (state.savingIds[it.id] ? ' saving' : ''),
      'data-status': it.status,
      'data-id': String(it.id),
    },
      h('h3', { class: 'card-title', text: it.title }),
      it.note ? h('p', { class: 'card-note', text: it.note }) : null,
      fieldRows.length ? h('dl', { class: 'card-fields' }, fieldRows) : null,
      h('label', { class: 'status-pick' }, h('span', { class: 'label', text: 'Status' }), select),
      h('div', { class: 'card-meta', text: meta }),
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn', type: 'button', onclick: function () { openEditor(it.id); }, text: 'Open / edit' })
      )
    );
    wireDrag(card, it.id);
    return card;
  }

  // -------------------------------------------------------------------------
  // Desktop drag and drop
  // -------------------------------------------------------------------------
  function wireDrag(card, id) {
    if (!DESKTOP.matches) return;
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', function (e) {
      if (/^(SELECT|INPUT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName)) return;
      state.dragging = true;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
    });
    card.addEventListener('dragend', function () {
      state.dragging = false;
      card.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach(function (c) { c.classList.remove('drop-target'); });
      if (state.renderPending) setTimeout(render, 0);
    });
  }

  function wireDrop(col, statusId) {
    col.addEventListener('dragover', function (e) {
      if (!state.dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drop-target');
    });
    col.addEventListener('dragleave', function (e) {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drop-target');
    });
    col.addEventListener('drop', function (e) {
      e.preventDefault();
      col.classList.remove('drop-target');
      var id = Number(e.dataTransfer.getData('text/plain'));
      state.dragging = false;
      var it = findItem(id);
      if (it && it.status !== statusId) changeStatus(id, statusId);
    });
  }

  // -------------------------------------------------------------------------
  // Status change (dropdown on card, or drag)
  // -------------------------------------------------------------------------
  function changeStatus(id, statusId) {
    var it = findItem(id);
    if (!it || state.savingIds[id]) return;
    var before = it.status;
    it.status = statusId; // move it right away so it feels instant
    state.savingIds[id] = true;
    blurActive();
    render();

    api('PATCH', '/api/items/' + id, { base: it.updatedAt, status: statusId }).then(
      function (data) {
        delete state.savingIds[id];
        replaceItem(data.item);
        render();
        flashCard(id);
      },
      function (err) {
        delete state.savingIds[id];
        if (err.code === 'conflict' && err.data && err.data.item) {
          replaceItem(err.data.item);
          render();
          flashCard(id);
          toast(err.data.by + ' just changed this. Here’s the latest. Try again if you still want to move it.', null, 9000);
        } else if (err.code === 'gone' || err.code === 'not_found') {
          removeItem(id);
          render();
          toast(friendly(err));
        } else {
          it.status = before;
          render();
          toast(friendly(err));
        }
      }
    );
  }

  function replaceItem(item) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === item.id) { state.items[i] = item; return; }
    }
    state.items.unshift(item);
  }
  function removeItem(id) {
    state.items = state.items.filter(function (x) { return x.id !== id; });
  }
  function flashCard(id) {
    var el = app.querySelector('.card[data-id="' + id + '"]');
    if (el) el.classList.add('flash');
  }
  function blurActive() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // -------------------------------------------------------------------------
  // Add / edit sheet
  // -------------------------------------------------------------------------
  var overlay = null;
  function closeOverlays() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.style.overflow = '';
  }
  function openOverlay(content, onBackdrop) {
    closeOverlays();
    overlay = h('div', {
      class: 'backdrop',
      onclick: function (e) { if (e.target === overlay && onBackdrop) onBackdrop(); },
    }, content);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    return overlay;
  }

  function openEditor(id) {
    var item = id ? findItem(id) : null;
    if (id && !item) return toast(MSG.not_found);
    var base = item ? item.updatedAt : null;
    var saving = false;

    var notice = h('div', { class: 'notice', hidden: true });
    var titleIn = h('input', { type: 'text', maxlength: '200', autocomplete: 'off', placeholder: 'Like "Overhead lights"' });
    var titleErr = h('div', { class: 'error', hidden: true });
    var noteIn = h('textarea', { maxlength: '5000', placeholder: 'Anything worth remembering' });
    var statusIn = h('select');
    state.statuses.forEach(function (st) { statusIn.appendChild(h('option', { value: st.id, text: st.label })); });

    var inputs = visibleFields().map(function (f) { return makeFieldInput(f); });
    var saveBtn = h('button', { class: 'btn btn-primary', type: 'submit', text: item ? 'Save' : 'Add it' });

    function fill(src) {
      titleIn.value = src ? src.title : '';
      noteIn.value = src ? src.note : '';
      statusIn.value = src ? src.status : state.statuses[0].id;
      inputs.forEach(function (fi) { fi.set(src ? src.custom[fi.field.id] : undefined); });
    }
    fill(item);

    function setNotice(lines, typed) {
      clear(notice);
      lines.forEach(function (l) { notice.appendChild(h('p', { text: l })); });
      if (typed) {
        notice.appendChild(h('p', { text: 'What you typed, so nothing is lost:' }));
        notice.appendChild(h('textarea', { readonly: true, value: typed }));
      }
      notice.hidden = false;
      notice.scrollIntoView({ block: 'nearest' });
    }

    function submit(e) {
      e.preventDefault();
      if (saving) return;
      titleErr.hidden = true;
      var title = titleIn.value.trim();
      if (!title) {
        titleErr.textContent = MSG.need_title;
        titleErr.hidden = false;
        titleIn.focus();
        return;
      }
      var custom = {};
      var bad = false;
      inputs.forEach(function (fi) {
        var r = fi.get();
        if (r.error) bad = true;
        else custom[fi.field.id] = r.value;
      });
      if (bad) return;

      var body = { title: title, note: noteIn.value, status: statusIn.value, custom: custom };
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      var req = item
        ? api('PATCH', '/api/items/' + item.id, Object.assign({ base: base }, body))
        : api('POST', '/api/items', body);

      req.then(
        function (data) {
          replaceItem(data.item);
          closeOverlays();
          render();
          flashCard(data.item.id);
          toast(item ? 'Saved.' : 'Added "' + data.item.title + '".');
        },
        function (err) {
          saving = false;
          saveBtn.disabled = false;
          saveBtn.textContent = item ? 'Save' : 'Add it';
          if (err.code === 'conflict' && err.data && err.data.item) {
            var latest = err.data.item;
            var typed = [];
            if (title !== latest.title) typed.push(title);
            if (noteIn.value.trim() && noteIn.value.trim() !== latest.note) typed.push(noteIn.value.trim());
            replaceItem(latest);
            item = latest;
            base = latest.updatedAt;
            fill(latest);
            setNotice(
              [err.data.by + ' just changed this. Here’s the latest.', 'Your changes weren’t saved yet. Make them again and tap Save.'],
              typed.join('\n\n')
            );
            render();
          } else if (err.code === 'gone' || err.code === 'not_found') {
            removeItem(item.id);
            closeOverlays();
            render();
            toast(friendly(err));
          } else if (err.code === 'need_title') {
            titleErr.textContent = MSG.need_title;
            titleErr.hidden = false;
          } else {
            setNotice([friendly(err)]);
          }
        }
      );
    }

    var form = h('form', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': item ? 'Edit item' : 'Add an item', onsubmit: submit, novalidate: true },
      h('h2', { text: item ? 'Edit item' : 'Add an item' }),
      notice,
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'What is it?' }), titleIn, titleErr),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Notes' }), noteIn),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Status' }), statusIn),
      inputs.map(function (fi) { return fi.el; }),
      h('div', { class: 'sheet-actions' },
        saveBtn,
        h('button', { class: 'btn', type: 'button', onclick: closeOverlays, text: 'Cancel' })
      ),
      item
        ? h('div', { class: 'sheet-extra' },
            h('p', { class: 'sheet-meta', text: 'Added by ' + personName(item.createdBy) + ' ' + ago(item.createdAt) + '. Last changed by ' + personName(item.updatedBy) + ' ' + ago(item.updatedAt) + '.' }),
            h('button', { class: 'btn btn-danger btn-wide', type: 'button', onclick: function () { archive(item.id, item.title); }, text: 'Archive (take it off the board)' })
          )
        : null
    );
    openOverlay(form, null);
    if (!item) setTimeout(function () { titleIn.focus(); }, 50);
  }

  // One input per custom field. get() returns { value } or { error: true }.
  function makeFieldInput(f) {
    var err = h('div', { class: 'error', hidden: true });
    var input;
    var wrap;
    function showErr(t) { err.textContent = t; err.hidden = false; }
    function ok(v) { err.hidden = true; return { value: v }; }

    switch (f.type) {
      case 'checkbox': {
        input = h('input', { type: 'checkbox' });
        wrap = h('div', { class: 'field' },
          h('span', { class: 'label', text: f.label }),
          h('label', { class: 'check' }, input, h('span', { text: 'Yes' }))
        );
        return {
          field: f, el: wrap,
          set: function (v) { input.checked = !!v; },
          get: function () { return ok(input.checked ? true : null); },
        };
      }
      case 'dropdown':
      case 'person': {
        input = h('select', null, h('option', { value: '', text: 'Not set' }));
        var opts = f.type === 'person'
          ? state.people.map(function (p) { return { v: String(p.id), t: p.name }; })
          : f.options.map(function (o) { return { v: o, t: o }; });
        opts.forEach(function (o) { input.appendChild(h('option', { value: o.v, text: o.t })); });
        break;
      }
      case 'date':
        input = h('input', { type: 'date' });
        break;
      case 'number':
      case 'price':
        input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: f.type === 'price' ? '0.00' : '' });
        break;
      case 'link':
        input = h('input', { type: 'text', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', placeholder: 'Paste a link' });
        break;
      default:
        input = h('input', { type: 'text', maxlength: '2000', autocomplete: 'off' });
    }

    var openLink = null;
    if (f.type === 'link') {
      openLink = h('a', { class: 'hint', target: '_blank', rel: 'noopener noreferrer', hidden: true, text: 'Open this link ↗' });
    }
    var control = f.type === 'price' ? h('div', { class: 'price-wrap' }, h('span', { text: '$' }), input) : input;
    wrap = h('label', { class: 'field' }, h('span', { class: 'label', text: f.label }), control, err, openLink);

    return {
      field: f,
      el: wrap,
      set: function (v) {
        input.value = v === undefined || v === null ? '' : String(v);
        if (openLink) {
          var u = v ? safeUrl(v) : null;
          openLink.hidden = !u;
          if (u) openLink.href = u;
        }
      },
      get: function () {
        var raw = input.value.trim();
        if (!raw) return ok(null);
        if (f.type === 'number' || f.type === 'price') {
          var n = Number(raw.replace(/[$,\s]/g, ''));
          if (!isFinite(n)) { showErr(MSG.bad_number); return { error: true }; }
          return ok(n);
        }
        if (f.type === 'person') return ok(Number(raw));
        if (f.type === 'link') {
          var withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
          var u = safeUrl(withScheme);
          if (!u || u.indexOf('.') === -1) { showErr(MSG.bad_link); return { error: true }; }
          return ok(withScheme);
        }
        return ok(raw);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Archive with undo
  // -------------------------------------------------------------------------
  function archive(id, title) {
    api('POST', '/api/items/' + id + '/archive').then(
      function () {
        removeItem(id);
        closeOverlays();
        render();
        toast('Archived "' + title + '".', {
          label: 'Undo',
          run: function () {
            api('POST', '/api/items/' + id + '/restore').then(
              function (data) {
                replaceItem(data.item);
                render();
                flashCard(id);
                toast('It’s back on the board.');
              },
              function (err) { toast(friendly(err)); }
            );
          },
        }, 10000);
      },
      function (err) {
        if (err.code === 'gone') {
          removeItem(id);
          closeOverlays();
          render();
        }
        toast(friendly(err));
      }
    );
  }

  // -------------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------------
  var toastTimer = null;
  function toast(text, action, ms) {
    clearTimeout(toastTimer);
    clear(toastEl);
    toastEl.appendChild(h('p', { text: text }));
    if (action) {
      toastEl.appendChild(h('button', {
        class: 'btn', type: 'button', text: action.label,
        onclick: function () { hideToast(); action.run(); },
      }));
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, ms || 4000);
  }
  function hideToast() { toastEl.hidden = true; clear(toastEl); }

  // -------------------------------------------------------------------------
  // Small dialogs (instead of browser pop-ups)
  // -------------------------------------------------------------------------
  function confirmBox(title, body, okLabel, onOk) {
    var box = h('div', { class: 'sheet dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { text: title }),
      h('p', { text: body }),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: okLabel, onclick: function () { closeOverlays(); onOk(); } }),
        h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeOverlays })
      )
    );
    openOverlay(box, closeOverlays);
  }

  function askText(title, label, value, multiline, onOk) {
    var input = multiline ? h('textarea', { value: value }) : h('input', { type: 'text', value: value, maxlength: '60' });
    var err = h('div', { class: 'error', hidden: true });
    var btn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' });
    var form = h('form', {
      class: 'sheet dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, novalidate: true,
      onsubmit: function (e) {
        e.preventDefault();
        btn.disabled = true;
        onOk(input.value, function (msg) {
          btn.disabled = false;
          if (msg) { err.textContent = msg; err.hidden = false; } else closeOverlays();
        });
      },
    },
      h('h2', { text: title }),
      h('label', { class: 'field' }, h('span', { class: 'label', text: label }), input, err),
      h('div', { class: 'sheet-actions' }, btn, h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeOverlays }))
    );
    openOverlay(form, null);
    setTimeout(function () { input.focus(); }, 50);
  }

  // -------------------------------------------------------------------------
  // Admin (Yeti only; the Worker checks this too)
  // -------------------------------------------------------------------------
  function openAdmin(tab) {
    if (state.me.role !== 'admin') return;
    state.view = 'admin';
    state.adminTab = tab || state.adminTab;
    render();
    window.scrollTo(0, 0);
    if (state.adminTab === 'archived') loadArchived();
  }

  function renderAdmin(main) {
    var tabs = [['people', 'People'], ['fields', 'Fields'], ['archived', 'Archived']];
    var wrap = h('div', { class: 'admin' },
      h('button', {
        class: 'btn back', type: 'button', text: '← Back to the board',
        onclick: function () { state.view = 'board'; render(); state.lastRefresh = 0; refresh(); },
      }),
      h('h2', { text: 'Admin' }),
      h('div', { class: 'tabs' }, tabs.map(function (t) {
        return h('button', {
          class: 'btn', type: 'button', 'aria-pressed': state.adminTab === t[0] ? 'true' : 'false', text: t[1],
          onclick: function () { openAdmin(t[0]); },
        });
      }))
    );
    var body = h('div');
    wrap.appendChild(body);
    main.appendChild(wrap);
    if (state.adminTab === 'people') adminPeople(body);
    else if (state.adminTab === 'fields') adminFields(body);
    else adminArchived(body);
  }

  function adminPeople(body) {
    body.appendChild(h('p', { text: 'Everyone has their own private link. Making a new one kills the old one right away.' }));
    state.people.forEach(function (p) {
      body.appendChild(h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('strong', { text: p.name }), h('span', { text: p.role === 'admin' ? 'Admin' : 'Member' })),
        h('div', { class: 'row-btns' },
          h('button', {
            class: 'btn', type: 'button', text: 'Make a new link',
            onclick: function () {
              var self = p.id === state.me.id;
              confirmBox(
                'New link for ' + p.name + '?',
                self
                  ? 'Your old link will stop working right away. This page will switch to the new one.'
                  : p.name + '’s old link will stop working right away. You’ll need to send them the new one.',
                'Make new link',
                function () { regenerate(p, self); }
              );
            },
          })
        )
      ));
    });
  }

  function boardUrlFor(key) {
    return location.origin + location.pathname + '#k=' + key;
  }

  function regenerate(p, self) {
    api('POST', '/api/admin/people/' + p.id + '/regenerate').then(
      function (data) {
        var link = boardUrlFor(data.key);
        if (self) {
          state.key = data.key;
          state.keyFromLink = true;
          saveKey(data.key);
          try { history.replaceState(null, '', '#k=' + data.key); } catch (e) { /* fine */ }
        }
        var copyBtn = h('button', {
          class: 'btn btn-primary', type: 'button', text: 'Copy link',
          onclick: function () {
            var b = this;
            copyText(link).then(function (ok) { b.textContent = ok ? 'Copied' : 'Select it and copy'; });
          },
        });
        var box = h('div', { class: 'sheet dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New link for ' + p.name },
          h('h2', { text: 'New link for ' + p.name }),
          h('p', { text: 'This is the only time you’ll see it. Copy it and send it to ' + (self ? 'yourself' : p.name) + ' now.' }),
          h('div', { class: 'linkbox', text: link }),
          h('div', { class: 'sheet-actions' }, copyBtn, h('button', { class: 'btn', type: 'button', text: 'Done', onclick: closeOverlays }))
        );
        openOverlay(box, null);
      },
      function (err) { toast(friendly(err)); }
    );
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  function adminFields(body) {
    body.appendChild(h('p', { text: 'Fields show up on every card. They’re always optional. Hiding a field keeps whatever people already typed in it.' }));
    var shown = state.fields.filter(function (f) { return !f.hidden; });
    var hidden = state.fields.filter(function (f) { return f.hidden; });

    shown.forEach(function (f, i) {
      body.appendChild(fieldRow(f, i === 0, i === shown.length - 1));
    });
    if (!shown.length) body.appendChild(h('p', { class: 'empty', text: 'No fields yet.' }));

    if (hidden.length) {
      body.appendChild(h('h3', { text: 'Hidden fields' }));
      hidden.forEach(function (f) {
        body.appendChild(h('div', { class: 'row' },
          h('div', { class: 'row-main' }, h('strong', { text: f.label }), h('span', { text: FIELD_TYPE_NAMES[f.type] || f.type })),
          h('div', { class: 'row-btns' },
            h('button', { class: 'btn', type: 'button', text: 'Show again', onclick: function () { patchField(f.id, { hidden: false }); } })
          )
        ));
      });
    }
    body.appendChild(addFieldForm());
  }

  function fieldRow(f, first, last) {
    return h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('strong', { text: f.label }),
        h('span', { text: FIELD_TYPE_NAMES[f.type] + (f.type === 'dropdown' ? ': ' + f.options.join(', ') : '') })
      ),
      h('div', { class: 'row-btns' },
        h('button', {
          class: 'btn', type: 'button', text: 'Rename',
          onclick: function () {
            askText('Rename field', 'New name', f.label, false, function (v, done) {
              patchField(f.id, { label: v }, done);
            });
          },
        }),
        f.type === 'dropdown'
          ? h('button', {
              class: 'btn', type: 'button', text: 'Edit choices',
              onclick: function () {
                askText('Choices for ' + f.label, 'One choice per line', f.options.join('\n'), true, function (v, done) {
                  patchField(f.id, { options: v.split('\n') }, done);
                });
              },
            })
          : null,
        h('button', { class: 'btn', type: 'button', text: '↑ Up', 'aria-label': 'Move ' + f.label + ' up', disabled: first, onclick: function () { patchField(f.id, { move: 'up' }); } }),
        h('button', { class: 'btn', type: 'button', text: '↓ Down', 'aria-label': 'Move ' + f.label + ' down', disabled: last, onclick: function () { patchField(f.id, { move: 'down' }); } }),
        h('button', {
          class: 'btn btn-danger', type: 'button', text: 'Hide',
          onclick: function () {
            confirmBox('Hide "' + f.label + '"?', 'It disappears from every card. Nothing is deleted, and you can show it again any time.', 'Hide it', function () {
              patchField(f.id, { hidden: true });
            });
          },
        })
      )
    );
  }

  function patchField(id, body, done) {
    api('PATCH', '/api/admin/fields/' + id, body).then(
      function () {
        if (done) done();
        reloadThenRender();
      },
      function (err) {
        if (done) done(friendly(err));
        else toast(friendly(err));
      }
    );
  }

  function reloadThenRender() {
    api('GET', '/api/board').then(
      function (data) { applyBoard(data, true); },
      function (err) { toast(friendly(err)); }
    );
  }

  function addFieldForm() {
    var name = h('input', { type: 'text', maxlength: '60', placeholder: 'Like "Where to buy"' });
    var type = h('select');
    Object.keys(FIELD_TYPE_NAMES).forEach(function (t) { type.appendChild(h('option', { value: t, text: FIELD_TYPE_NAMES[t] })); });
    var choices = h('textarea', { placeholder: 'One choice per line' });
    var choicesWrap = h('label', { class: 'field', hidden: true }, h('span', { class: 'label', text: 'Choices' }), choices);
    var err = h('div', { class: 'error', hidden: true });
    var btn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Add field' });
    type.addEventListener('change', function () { choicesWrap.hidden = type.value !== 'dropdown'; });

    return h('form', {
      class: 'panel', novalidate: true,
      onsubmit: function (e) {
        e.preventDefault();
        err.hidden = true;
        if (!name.value.trim()) { err.textContent = MSG.need_label; err.hidden = false; return; }
        btn.disabled = true;
        var payload = { label: name.value, type: type.value };
        if (type.value === 'dropdown') payload.options = choices.value.split('\n');
        api('POST', '/api/admin/fields', payload).then(
          function () { toast('Field added.'); reloadThenRender(); },
          function (er) { btn.disabled = false; err.textContent = friendly(er); err.hidden = false; }
        );
      },
    },
      h('h3', { text: 'Add a field', style: 'margin-top:0' }),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Name' }), name),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Type' }), type),
      choicesWrap,
      err,
      btn
    );
  }

  function loadArchived() {
    state.archived = null;
    api('GET', '/api/admin/archived').then(
      function (data) {
        state.archived = data.items;
        if (state.view === 'admin' && state.adminTab === 'archived') render();
      },
      function (err) {
        state.archived = [];
        toast(friendly(err));
        if (state.view === 'admin' && state.adminTab === 'archived') render();
      }
    );
  }

  function adminArchived(body) {
    body.appendChild(h('p', { text: 'Archived items are off the board but kept here. Bring one back if it was archived by mistake.' }));
    if (state.archived === null) return body.appendChild(h('p', { class: 'loading', text: 'Loading...' }));
    if (!state.archived.length) return body.appendChild(h('p', { class: 'empty', text: 'Nothing archived.' }));
    state.archived.forEach(function (it) {
      body.appendChild(h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('strong', { text: it.title }),
          h('span', { text: statusLabel(it.status) + '. Archived by ' + personName(it.archivedBy) + ' ' + ago(it.archivedAt) + '.' })
        ),
        h('div', { class: 'row-btns' },
          h('button', {
            class: 'btn', type: 'button', text: 'Bring it back',
            onclick: function () {
              this.disabled = true;
              api('POST', '/api/items/' + it.id + '/restore').then(
                function (data) {
                  replaceItem(data.item);
                  state.archived = state.archived.filter(function (x) { return x.id !== it.id; });
                  render();
                  toast('"' + it.title + '" is back on the board.');
                },
                function (err) { toast(friendly(err)); render(); }
              );
            },
          })
        )
      ));
    });
  }

  // -------------------------------------------------------------------------
  // Safety net: no blank screens, no stack traces
  // -------------------------------------------------------------------------
  function oops() {
    if (state.me && app.querySelector('.top')) {
      toast('Something hiccuped. If the board looks off, pull down to refresh.', null, 6000);
    } else {
      showGate('Something hiccuped loading the board.', function () { location.reload(); });
    }
  }
  window.addEventListener('error', oops);
  window.addEventListener('unhandledrejection', function (e) { if (e && e.preventDefault) e.preventDefault(); oops(); });

  // If the page is opened with a different link in the same tab, start over.
  window.addEventListener('hashchange', function () {
    var m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]+)/);
    if (m && m[1] !== state.key) { state.me = null; closeOverlays(); start(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay) closeOverlays();
  });

  // Re-render when switching between phone and desktop layouts (drag on/off).
  if (DESKTOP.addEventListener) DESKTOP.addEventListener('change', function () { if (state.me && state.view === 'board' && !isBusy()) render(); });

  start();
})();
