/* GCL — guitar parts board.
   Free-form canvas of part cards. Each card can pull its images from a
   product URL via /api/scrape, and cycle through the candidates. */

(function () {
  'use strict';

  var KEY = 'gcl.board.v1';
  // Fixed landscape blocks. Resizing is off for now, so every card carries
  // these dimensions and older saved boards get normalised to them on load.
  var CARD_W = 400;
  var CARD_H = 340;

  var stage = document.getElementById('stage');
  var world = document.getElementById('world');
  var emptyHint = document.getElementById('empty');
  var tpl = document.getElementById('card-tpl');
  var totalEl = document.getElementById('total');
  var importFile = document.getElementById('import-file');

  var state = { name: '', blocks: [], links: [], view: { x: 60, y: 40, s: 1 }, seq: 1 };
  var nodes = new Map(); // block.id -> { el, refs }
  var pending = null;    // connection being dragged, or null

  /* ---------------------------------------------------------------- store */

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && Array.isArray(data.blocks)) {
        state.name = typeof data.name === 'string' ? data.name : '';
        state.blocks = data.blocks;
        state.links = Array.isArray(data.links) ? data.links : [];
        state.view = data.view || state.view;
        state.seq = data.seq || state.blocks.length + 1;
      }
    } catch (e) {
      console.warn('Could not read saved board:', e);
    }
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        console.warn('Could not save board:', e);
      }
    }, 250);
  }

  /* ----------------------------------------------------------------- view */

  var CELL = 44; // must match --cell in styles.css

  function applyView() {
    var v = state.view;
    world.style.transform =
      'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';

    // Drag the plus field along with the cards, and scale it with the zoom,
    // so the canvas reads as one surface rather than a fixed backdrop.
    var cell = CELL * v.s;
    stage.style.backgroundSize = cell + 'px ' + cell + 'px';
    stage.style.backgroundPosition = v.x + 'px ' + v.y + 'px';

    document.getElementById('zoom-reset').textContent =
      Math.round(v.s * 100) + '%';
  }

  function zoomAt(screenX, screenY, factor) {
    var v = state.view;
    var next = Math.min(2.5, Math.max(0.25, v.s * factor));
    if (next === v.s) return;
    var rect = stage.getBoundingClientRect();
    var px = screenX - rect.left;
    var py = screenY - rect.top;
    // Keep the world point under the cursor pinned in place.
    v.x = px - (px - v.x) * (next / v.s);
    v.y = py - (py - v.y) * (next / v.s);
    v.s = next;
    applyView();
    save();
  }

  /* ---------------------------------------------------------------- wires */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var wires = document.getElementById('wires');
  var SIDES = ['l', 'r', 't', 'b'];

  // Outward direction of each side, used to aim the curve's control points so
  // a wire leaves its socket perpendicular to the card, the way Blender's do.
  var NORMAL = {
    l: { x: -1, y: 0 },
    r: { x: 1, y: 0 },
    t: { x: 0, y: -1 },
    b: { x: 0, y: 1 }
  };

  function findBlock(id) {
    for (var i = 0; i < state.blocks.length; i++) {
      if (state.blocks[i].id === id) return state.blocks[i];
    }
    return null;
  }

  function portPoint(id, side) {
    var b = findBlock(id);
    if (!b) return null;
    if (side === 'l') return { x: b.x, y: b.y + b.h / 2 };
    if (side === 'r') return { x: b.x + b.w, y: b.y + b.h / 2 };
    if (side === 't') return { x: b.x + b.w / 2, y: b.y };
    return { x: b.x + b.w / 2, y: b.y + b.h };
  }

  /** Index of the link touching this socket, or -1. One wire per dot. */
  function linkIndexAt(id, side) {
    for (var i = 0; i < state.links.length; i++) {
      var l = state.links[i];
      if (l.a.id === id && l.a.side === side) return i;
      if (l.b.id === id && l.b.side === side) return i;
    }
    return -1;
  }

  function toWorld(clientX, clientY) {
    var r = stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - state.view.x) / state.view.s,
      y: (clientY - r.top - state.view.y) / state.view.s
    };
  }

  function portUnder(clientX, clientY) {
    var el = document.elementFromPoint(clientX, clientY);
    if (!el || !el.classList || !el.classList.contains('port')) return null;
    var card = el.closest('.card');
    if (!card) return null;
    return { id: card.dataset.id, side: el.dataset.side };
  }

  /** Cubic bezier that leaves both ends along their outward normals. */
  function wirePath(p1, n1, p2, n2) {
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    // Slack scales with distance, so short hops don't loop and long runs bow.
    var k = Math.max(45, Math.min(Math.sqrt(dx * dx + dy * dy) * 0.45, 220));
    return 'M ' + p1.x + ' ' + p1.y +
      ' C ' + (p1.x + n1.x * k) + ' ' + (p1.y + n1.y * k) +
      ' ' + (p2.x + n2.x * k) + ' ' + (p2.y + n2.y * k) +
      ' ' + p2.x + ' ' + p2.y;
  }

  function addPath(d, cls) {
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    wires.appendChild(path);
  }

  function renderWires() {
    while (wires.firstChild) wires.removeChild(wires.firstChild);

    state.links.forEach(function (l) {
      var p1 = portPoint(l.a.id, l.a.side);
      var p2 = portPoint(l.b.id, l.b.side);
      if (p1 && p2) addPath(wirePath(p1, NORMAL[l.a.side], p2, NORMAL[l.b.side]), 'wire');
    });

    if (pending && pending.cursor) {
      var from = portPoint(pending.id, pending.side);
      var n = NORMAL[pending.side];
      if (from) {
        // The loose end curves back toward the socket it came from.
        addPath(
          wirePath(from, n, pending.cursor, { x: -n.x, y: -n.y }),
          'wire wire-pending'
        );
      }
    }

    refreshPorts();
  }

  function refreshPorts() {
    nodes.forEach(function (entry, id) {
      SIDES.forEach(function (side) {
        var live =
          linkIndexAt(id, side) >= 0 ||
          (pending && pending.id === id && pending.side === side) ||
          (pending && pending.target &&
            pending.target.id === id && pending.target.side === side);
        entry.refs.ports[side].classList.toggle('live', !!live);
      });
    });
  }

  function dropLinksFor(id) {
    state.links = state.links.filter(function (l) {
      return l.a.id !== id && l.b.id !== id;
    });
  }

  function bindPorts(el, block, refs) {
    SIDES.forEach(function (side) {
      var dot = refs.ports[side];

      dot.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation(); // don't let the card start a drag
        bringToFront(block, el);

        // Grabbing a connected dot picks its wire back up, so dragging off
        // into empty space is how you disconnect.
        var existing = linkIndexAt(block.id, side);
        if (existing >= 0) state.links.splice(existing, 1);

        pending = {
          id: block.id,
          side: side,
          cursor: portPoint(block.id, side),
          target: null
        };
        // Capture keeps the drag alive once the cursor leaves the dot. Some
        // browsers throw for a pointer they no longer consider active, and the
        // drag still works without it, so a failure here is not fatal.
        try { dot.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
        renderWires();

        function onMove(ev) {
          pending.cursor = toWorld(ev.clientX, ev.clientY);
          var t = portUnder(ev.clientX, ev.clientY);
          // Only highlight somewhere the wire could actually land.
          pending.target =
            t && t.id !== pending.id && linkIndexAt(t.id, t.side) < 0 ? t : null;
          renderWires();
        }

        function onUp(ev) {
          try { dot.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
          dot.removeEventListener('pointermove', onMove);
          dot.removeEventListener('pointerup', onUp);
          dot.removeEventListener('pointercancel', onUp);

          var t = portUnder(ev.clientX, ev.clientY);
          if (t && t.id !== pending.id && linkIndexAt(t.id, t.side) < 0) {
            state.links.push({
              a: { id: pending.id, side: pending.side },
              b: { id: t.id, side: t.side }
            });
          }
          pending = null;
          renderWires();
          save();
        }

        dot.addEventListener('pointermove', onMove);
        dot.addEventListener('pointerup', onUp);
        dot.addEventListener('pointercancel', onUp);
      });
    });
  }

  /* ---------------------------------------------------------------- money */

  function parseMoney(str) {
    var n = parseFloat(String(str == null ? '' : str).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  function parseQty(str) {
    var n = parseInt(String(str == null ? '' : str).replace(/[^0-9]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : 1;
  }

  function recomputeTotal() {
    var sum = 0;
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      sum += parseMoney(b.price) * parseQty(b.qty);
    }
    totalEl.textContent =
      '$' + sum.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function refreshEmptyHint() {
    emptyHint.hidden = state.blocks.length > 0;
  }

  /* --------------------------------------------------------------- images */

  function showImage(block, refs) {
    var list = block.images || [];
    var emptyLabel = refs.empty.querySelector('span');

    if (!list.length) {
      refs.shot.hidden = true;
      refs.shot.removeAttribute('src');
      refs.empty.hidden = false;
      emptyLabel.textContent = 'No image yet';
      refs.prev.hidden = refs.next.hidden = refs.counter.hidden = true;
      return;
    }

    var i = Math.min(Math.max(block.imgIndex || 0, 0), list.length - 1);
    block.imgIndex = i;

    refs.empty.hidden = true;
    refs.shot.hidden = false;
    refs.shot.dataset.origin = list[i];
    refs.shot.dataset.proxied = '';
    refs.shot.src = list[i];

    var multi = list.length > 1;
    refs.prev.hidden = refs.next.hidden = refs.counter.hidden = !multi;
    refs.counter.textContent = i + 1 + ' / ' + list.length;
  }

  function step(block, refs, delta) {
    var list = block.images || [];
    if (list.length < 2) return;
    block.imgIndex = (block.imgIndex + delta + list.length) % list.length;
    showImage(block, refs);
    save();
  }

  function setMsg(refs, text, kind) {
    if (!text) {
      refs.msg.hidden = true;
      refs.msg.textContent = '';
      return;
    }
    refs.msg.hidden = false;
    refs.msg.textContent = text;
    refs.msg.className = 'msg ' + (kind || '');
  }

  function normalizeUrl(raw) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  async function pullImages(block, refs) {
    var url = normalizeUrl(block.url);
    if (!url) return;

    if (url !== block.url) {
      block.url = url;
      refs.url.value = url;
    }

    // Recorded before the request so that blurring the field again doesn't
    // re-fetch the same page. Enter always refetches, which is the retry path.
    block.fetchedUrl = url;

    setMsg(refs, '');
    refs.status.hidden = false;
    refs.status.textContent = 'Reading the page…';

    var data;
    try {
      var res = await fetch('/api/scrape?url=' + encodeURIComponent(url));
      data = await res.json();
      if (!res.ok) {
        refs.status.hidden = true;
        setMsg(
          refs,
          (data && data.error) ||
            'That page could not be read. Use “Paste image URL” instead.',
          'err'
        );
        return;
      }
    } catch (e) {
      refs.status.hidden = true;
      setMsg(
        refs,
        'Scraper unreachable — is the dev server running? (npm run dev)',
        'err'
      );
      return;
    }

    refs.status.hidden = true;

    if (!data.images || !data.images.length) {
      setMsg(refs, 'No usable images found. Try “Paste image URL”.', 'err');
      return;
    }

    block.images = data.images;
    block.imgIndex = 0;
    if (!block.title && data.title) {
      block.title = data.title.split(/\s+[|–—-]\s+/)[0].slice(0, 70);
      refs.title.value = block.title;
    }
    refs.open.hidden = false;
    refs.open.href = block.url;

    showImage(block, refs);
    setMsg(
      refs,
      data.images.length +
        ' image' +
        (data.images.length === 1 ? '' : 's') +
        ' found' +
        (data.images.length > 1 ? ' — use ‹ › to cycle' : ''),
      'ok'
    );
    setTimeout(function () {
      setMsg(refs, '');
    }, 4000);
    save();
  }

  /* ---------------------------------------------------------------- cards */

  function createBlock(partial) {
    var v = state.view;
    // Drop new cards near the middle of whatever the user is looking at.
    var cx = (stage.clientWidth / 2 - v.x) / v.s - CARD_W / 2;
    var cy = (stage.clientHeight / 2 - v.y) / v.s - CARD_H / 2;
    var jitter = (state.blocks.length % 6) * 26;

    var block = Object.assign(
      {
        id: 'b' + state.seq++,
        x: Math.round(cx + jitter),
        y: Math.round(cy + jitter),
        w: CARD_W,
        h: CARD_H,
        z: state.seq,
        url: '',
        title: '',
        price: '',
        qty: '',
        notes: '',
        images: [],
        imgIndex: 0
      },
      partial || {}
    );

    state.blocks.push(block);
    mountBlock(block);
    refreshEmptyHint();
    recomputeTotal();
    save();
    return block;
  }

  function mountBlock(block) {
    var el = tpl.content.firstElementChild.cloneNode(true);
    var refs = {
      thumb: el.querySelector('.thumb'),
      shot: el.querySelector('.shot'),
      empty: el.querySelector('.thumb-empty'),
      status: el.querySelector('.thumb-status'),
      prev: el.querySelector('.prev'),
      next: el.querySelector('.next'),
      counter: el.querySelector('.counter'),
      title: el.querySelector('.f-title'),
      price: el.querySelector('.f-price'),
      qty: el.querySelector('.f-qty'),
      url: el.querySelector('.f-url'),
      msg: el.querySelector('.msg'),
      notes: el.querySelector('.f-notes'),
      open: el.querySelector('.open'),
      manual: el.querySelector('.manual'),
      del: el.querySelector('.del'),
      confirm: el.querySelector('.confirm'),
      confirmYes: el.querySelector('.confirm-yes'),
      confirmNo: el.querySelector('.confirm-no'),
      ports: {
        l: el.querySelector('.port.pl'),
        r: el.querySelector('.port.pr'),
        t: el.querySelector('.port.pt'),
        b: el.querySelector('.port.pb')
      }
    };

    el.dataset.id = block.id;
    // Cards are a fixed size now, so any board saved under the old resizable
    // layout gets pulled back to the current dimensions.
    block.w = CARD_W;
    block.h = CARD_H;
    place(el, block);

    refs.title.value = block.title || '';
    refs.price.value = block.price || '';
    refs.qty.value = block.qty || '';
    refs.url.value = block.url || '';
    refs.notes.value = block.notes || '';
    if (block.url) {
      refs.open.hidden = false;
      refs.open.href = block.url;
      // A restored card that already has images counts as fetched, so merely
      // clicking through its URL field won't hit the network again.
      if (!block.fetchedUrl && (block.images || []).length) {
        block.fetchedUrl = normalizeUrl(block.url);
      }
    }

    // Direct load first (costs us nothing); fall back to the proxy only when
    // the CDN refuses the hotlink.
    refs.shot.addEventListener('error', function () {
      var origin = refs.shot.dataset.origin;
      if (origin && !refs.shot.dataset.proxied) {
        refs.shot.dataset.proxied = '1';
        refs.shot.src = '/api/img?url=' + encodeURIComponent(origin);
        return;
      }
      refs.shot.hidden = true;
      refs.empty.hidden = false;
      refs.empty.querySelector('span').textContent = 'Image blocked';
    });

    refs.prev.addEventListener('click', function () { step(block, refs, -1); });
    refs.next.addEventListener('click', function () { step(block, refs, 1); });

    // Clicking away from the URL field is the trigger; there is no Get button.
    // Only a URL that hasn't already been fetched starts a request, so tabbing
    // through a finished card stays quiet.
    refs.url.addEventListener('blur', function () {
      var next = normalizeUrl(refs.url.value);
      if (!next || next === block.fetchedUrl) return;
      pullImages(block, refs);
    });
    refs.url.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        // pullImages stamps fetchedUrl synchronously, so the blur it triggers
        // sees the URL as already handled and doesn't fire a second request.
        pullImages(block, refs); // unconditional, so Enter doubles as retry
        refs.url.blur();
      }
    });

    // A committed price is reformatted as currency. parseMoney strips the
    // symbol back out, so the running total is unaffected by the prefix.
    function commitPrice() {
      var raw = refs.price.value.trim();
      if (!raw || !/\d/.test(raw)) return;
      var formatted = '$' + parseMoney(raw).toFixed(2);
      if (formatted === refs.price.value) return;
      refs.price.value = formatted;
      block.price = formatted;
      recomputeTotal();
      save();
    }

    // Enter commits an edit and leaves the field. Deliberately not wired to
    // the notes textarea, where Enter has to keep meaning "new line".
    // commitPrice is called outright rather than left to the blur that follows,
    // so the formatting never depends on that event actually arriving.
    [refs.title, refs.price, refs.qty].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (input === refs.price) commitPrice();
        input.blur();
      });
    });

    refs.price.addEventListener('blur', commitPrice);

    bindField(refs.title, block, 'title');
    bindField(refs.url, block, 'url', function () {
      refs.open.hidden = !block.url;
      if (block.url) refs.open.href = block.url;
    });
    bindField(refs.notes, block, 'notes');
    bindField(refs.price, block, 'price', recomputeTotal);
    bindField(refs.qty, block, 'qty', recomputeTotal);

    refs.manual.addEventListener('click', function () {
      var entered = window.prompt('Image URL (right-click the photo on the store page → Copy image address):');
      if (!entered) return;
      entered = entered.trim();
      if (!/^https?:\/\//i.test(entered)) {
        setMsg(refs, 'That is not a valid image URL.', 'err');
        return;
      }
      block.images = (block.images || []).concat([entered]);
      block.imgIndex = block.images.length - 1;
      showImage(block, refs);
      save();
    });

    // Delete asks first. The popup is toggled rather than opened, so a second
    // click on Delete dismisses it.
    refs.del.addEventListener('click', function () {
      var opening = !refs.confirm.classList.contains('show');
      closeConfirms();
      if (opening) refs.confirm.classList.add('show');
    });
    refs.confirmYes.addEventListener('click', function () {
      removeBlock(block.id);
    });
    refs.confirmNo.addEventListener('click', function () {
      refs.confirm.classList.remove('show');
    });

    dragBehaviour(el, block, refs);
    bindPorts(el, block, refs);

    world.appendChild(el);
    nodes.set(block.id, { el: el, refs: refs });
    showImage(block, refs);
    renderWires();
  }

  function bindField(input, block, key, after) {
    input.addEventListener('input', function () {
      block[key] = input.value;
      if (after) after();
      save();
    });
  }

  function place(el, block) {
    el.style.left = block.x + 'px';
    el.style.top = block.y + 'px';
    el.style.width = block.w + 'px';
    el.style.height = block.h + 'px';
    el.style.zIndex = block.z || 1;
  }

  function removeBlock(id) {
    var entry = nodes.get(id);
    if (entry) entry.el.remove();
    nodes.delete(id);
    state.blocks = state.blocks.filter(function (b) { return b.id !== id; });
    dropLinksFor(id); // a deleted card takes its wires with it
    refreshEmptyHint();
    recomputeTotal();
    renderWires();
    save();
  }

  /** Dismiss every open delete confirmation. */
  function closeConfirms() {
    nodes.forEach(function (n) {
      n.refs.confirm.classList.remove('show');
    });
  }

  function bringToFront(block, el) {
    block.z = ++state.seq;
    el.style.zIndex = block.z;
  }

  /* -------------------------------------------------------------- dragging */

  var NO_DRAG = 'INPUT,TEXTAREA,BUTTON,A,SELECT';

  function dragBehaviour(el, block, refs) {
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      bringToFront(block, el);

      // Returns above for buttons and fields, so this only fires on a genuine
      // card drag — clicking Delete itself won't close its own popup.
      if (e.target.closest(NO_DRAG)) return;
      closeConfirms();

      e.preventDefault();
      e.stopPropagation();
      // Same caveat as the connector drag: capture is an optimisation, and a
      // browser refusing it must not abort the drag.
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
      el.classList.add('dragging');

      var startX = e.clientX;
      var startY = e.clientY;
      var origin = { x: block.x, y: block.y };

      function onMove(ev) {
        block.x = Math.round(origin.x + (ev.clientX - startX) / state.view.s);
        block.y = Math.round(origin.y + (ev.clientY - startY) / state.view.s);
        place(el, block);
        renderWires(); // wires follow the card as it moves
      }

      function onUp(ev) {
        try { el.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        save();
      }

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  /* -------------------------------------------------------- canvas panning */

  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target !== stage && e.target !== world && e.target !== emptyHint) return;

    // Touching the background drops focus out of whatever field was being
    // typed in. preventDefault below would otherwise keep the caret blinking
    // there. For the URL field this is also what triggers its image fetch.
    var active = document.activeElement;
    if (active && active.closest && active.closest('.card')) active.blur();
    closeConfirms();

    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');

    var startX = e.clientX;
    var startY = e.clientY;
    var ox = state.view.x;
    var oy = state.view.y;

    function onMove(ev) {
      state.view.x = ox + (ev.clientX - startX);
      state.view.y = oy + (ev.clientY - startY);
      applyView();
    }
    function onUp(ev) {
      try { stage.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      save();
    }

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  });

  // The wheel zooms outright. Panning is dragging the background, so there is
  // nothing for a plain scroll to do otherwise.
  stage.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );

  /* -------------------------------------------------------------- toolbar */

  document.getElementById('add').addEventListener('click', function () {
    createBlock();
  });

  document.getElementById('zoom-in').addEventListener('click', function () {
    zoomAt(stage.clientWidth / 2, stage.clientHeight / 2 + 56, 1.15);
  });
  document.getElementById('zoom-out').addEventListener('click', function () {
    zoomAt(stage.clientWidth / 2, stage.clientHeight / 2 + 56, 1 / 1.15);
  });
  document.getElementById('zoom-reset').addEventListener('click', function () {
    state.view = { x: 60, y: 40, s: 1 };
    applyView();
    save();
  });

  /* ---------------------------------------------------------- header size */

  // The header wraps onto extra rows on a narrow window. Publishing its real
  // height as --bar-h keeps the canvas tucked underneath instead of being
  // covered by the overflow.
  var barEl = document.querySelector('.bar');

  function syncBarHeight() {
    document.documentElement.style.setProperty(
      '--bar-h', barEl.offsetHeight + 'px'
    );
  }

  // Both: the observer catches content changes, the resize listener covers the
  // ordinary window-resize case even where observer delivery is throttled.
  if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(barEl);
  window.addEventListener('resize', syncBarHeight);
  syncBarHeight();

  /* ------------------------------------------------------------ board name */

  var boardNameInput = document.getElementById('board-name');

  boardNameInput.addEventListener('input', function () {
    state.name = boardNameInput.value;
    save();
  });
  boardNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      boardNameInput.blur();
    }
  });

  /** Board name reduced to something safe to use as a filename. */
  function exportFilename() {
    var base = (state.name || '').trim()
      .replace(/[\\/:*?"<>|]+/g, '')  // characters filesystems reject
      .replace(/\s+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 60);
    return (base || 'gcl-board') + '.json';
  }

  document.getElementById('export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], {
      type: 'application/json'
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename();
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  document.getElementById('import').addEventListener('click', function () {
    importFile.click();
  });

  importFile.addEventListener('change', async function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;
    try {
      var data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.blocks)) throw new Error('bad file');
      resetBoard(data);
    } catch (e) {
      alert('That file is not a GCL board export.');
    }
    importFile.value = '';
  });

  document.getElementById('clear').addEventListener('click', function () {
    if (!state.blocks.length) return;
    if (!confirm('Delete all ' + state.blocks.length + ' parts from this board?')) return;
    // Clearing empties the board but keeps what it's called.
    resetBoard({ name: state.name, blocks: [], links: [], view: { x: 60, y: 40, s: 1 }, seq: 1 });
  });

  function resetBoard(data) {
    nodes.forEach(function (n) { n.el.remove(); });
    nodes.clear();
    state.name = typeof data.name === 'string' ? data.name : '';
    boardNameInput.value = state.name;
    state.blocks = data.blocks || [];
    state.links = Array.isArray(data.links) ? data.links : [];
    state.view = data.view || { x: 60, y: 40, s: 1 };
    state.seq = data.seq || state.blocks.length + 1;
    state.blocks.forEach(mountBlock);
    applyView();
    refreshEmptyHint();
    recomputeTotal();
    renderWires();
    save();
  }

  /* ------------------------------------------------------------ typeface */

  var FONT_KEY = 'gcl.font';
  var fontButtons = [].slice.call(document.querySelectorAll('.font-btn'));

  function setFont(id, persist) {
    document.documentElement.setAttribute('data-font', id);
    fontButtons.forEach(function (b) {
      b.classList.toggle('on', b.dataset.font === id);
    });
    if (persist) {
      try {
        localStorage.setItem(FONT_KEY, id);
      } catch (e) {
        console.warn('Could not save font choice:', e);
      }
    }
  }

  fontButtons.forEach(function (b) {
    b.addEventListener('click', function () { setFont(b.dataset.font, true); });
  });

  /* ----------------------------------------------------------------- boot */

  var savedFont = 'ui';
  try {
    savedFont = localStorage.getItem(FONT_KEY) || 'ui';
  } catch (e) {
    // storage unavailable; stay on the default
  }
  setFont(savedFont, false);

  load();
  boardNameInput.value = state.name || '';
  state.blocks.forEach(mountBlock);
  applyView();
  refreshEmptyHint();
  recomputeTotal();
  renderWires();
})();
