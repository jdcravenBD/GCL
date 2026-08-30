/* GCL — guitar parts board.
   Free-form canvas of part cards. Each card can pull its images from a
   product URL via /api/scrape, and cycle through the candidates. */

(function () {
  'use strict';

  var KEY = 'gcl.board.v1';
  // Starting size for a new block; cards are resizable from any edge or corner.
  var CARD_W = 400;
  var CARD_H = 340;
  var MIN_W = 320;   // below this the type/name/price/qty row stops fitting
  var MIN_H = 240;   // leaves the photo roughly 80px once the rows are placed
  var MAX_W = 1000;
  var MAX_H = 1000;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  var stage = document.getElementById('stage');
  var world = document.getElementById('world');
  var emptyHint = document.getElementById('empty');
  var tpl = document.getElementById('card-tpl');
  var totalEl = document.getElementById('total');
  var importFile = document.getElementById('import-file');
  var undoBtn = document.getElementById('undo');
  var redoBtn = document.getElementById('redo');
  var totalWrap = document.querySelector('.total');
  var budgetInput = document.getElementById('budget');
  var budgetFill = document.getElementById('budget-fill');

  var state = {
    name: '', budget: '', blocks: [], links: [],
    view: { x: 60, y: 40, s: 1 }, seq: 1
  };
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
        state.budget = typeof data.budget === 'string' ? data.budget : '';
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
    saveTimer = setTimeout(writeNow, 250);
    scheduleCommit();
  }

  function writeNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save board:', e);
    }
    // Rides the existing save debounce, so the panel tracks edits without
    // rebuilding its list on every keystroke.
    if (summaryOpen) renderSummary();
  }

  /* --------------------------------------------------------------- history */

  // Snapshot-based undo. The view (pan/zoom) is deliberately left out — moving
  // the camera isn't an edit, and shouldn't consume an undo step.
  var undoStack = [];
  var redoStack = [];
  var lastSnap = null;
  var commitTimer = null;
  var MAX_HISTORY = 80;

  function snapshot() {
    return JSON.stringify({
      name: state.name,
      budget: state.budget,
      blocks: state.blocks,
      links: state.links,
      seq: state.seq
    });
  }

  /** Records the current state as an undo step, if anything actually changed. */
  function commitNow() {
    clearTimeout(commitTimer);
    var next = snapshot();
    if (lastSnap === null || next === lastSnap) {
      lastSnap = next;
      return;
    }
    undoStack.push(lastSnap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    lastSnap = next;
    refreshHistoryButtons();
  }

  // Delayed so a burst of typing collapses into one undo step rather than one
  // per keystroke. Discrete actions all route through save() too, so they land
  // as their own step once the user pauses.
  function scheduleCommit() {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commitNow, 650);
  }

  function applySnapshot(json) {
    var d = JSON.parse(json);
    nodes.forEach(function (n) { n.el.remove(); });
    nodes.clear();
    state.name = d.name;
    state.budget = d.budget || '';
    state.blocks = d.blocks;
    state.links = d.links;
    state.seq = d.seq;
    boardNameInput.value = state.name || '';
    budgetInput.value = state.budget || '';
    state.blocks.forEach(mountBlock);
    refreshEmptyHint();
    recomputeTotal();
    renderWires();
    writeNow();
  }

  function undo() {
    commitNow(); // fold in anything still pending before stepping back
    if (!undoStack.length) return;
    redoStack.push(lastSnap);
    applySnapshot(undoStack.pop());
    lastSnap = snapshot();
    refreshHistoryButtons();
  }

  function redo() {
    clearTimeout(commitTimer);
    if (!redoStack.length) return;
    undoStack.push(lastSnap);
    applySnapshot(redoStack.pop());
    lastSnap = snapshot();
    refreshHistoryButtons();
  }

  function refreshHistoryButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
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

  // How far outside a block a wire can be released and still land on it.
  var SNAP = 70;

  /**
   * Where a wire released at this point should connect. An exact hit on a dot
   * wins; otherwise it falls back to the nearest block within reach and picks
   * that block's nearest free side, so dropping anywhere along an edge works.
   * `fromId` is excluded so a block can't wire to itself.
   */
  function portTargetAt(clientX, clientY, fromId) {
    var exact = portUnder(clientX, clientY);
    if (exact) {
      if (exact.id === fromId || linkIndexAt(exact.id, exact.side) >= 0) return null;
      return exact;
    }

    var p = toWorld(clientX, clientY);
    var best = null;
    var bestDist = Infinity;

    state.blocks.forEach(function (b) {
      if (b.id === fromId) return;
      // Distance from the point to the block's rectangle; 0 when inside it.
      var dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
      var dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = b; }
    });

    if (!best || bestDist > SNAP) return null;

    var sides = [
      { side: 'l', d: Math.abs(p.x - best.x) },
      { side: 'r', d: Math.abs(p.x - (best.x + best.w)) },
      { side: 't', d: Math.abs(p.y - best.y) },
      { side: 'b', d: Math.abs(p.y - (best.y + best.h)) }
    ].sort(function (a, b) { return a.d - b.d; });

    // Nearest side first, but fall through to the next if it's already taken.
    for (var i = 0; i < sides.length; i++) {
      if (linkIndexAt(best.id, sides[i].side) < 0) {
        return { id: best.id, side: sides[i].side };
      }
    }
    return null;
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

  /** Re-draws a dropped wire and dissolves it, so it doesn't just blink out. */
  function fadeOutWire(d) {
    var ghost = document.createElementNS(SVG_NS, 'path');
    ghost.setAttribute('d', d);
    ghost.setAttribute('class', 'wire wire-pending wire-fade');
    wires.appendChild(ghost);

    // Force a layout pass so the browser has a "from" value to animate off.
    void ghost.getBoundingClientRect();
    ghost.classList.add('gone');

    setTimeout(function () {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }, 220);
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
          // portTargetAt already rules out taken sockets and self-links, so
          // whatever comes back is somewhere the wire can actually land.
          pending.target = portTargetAt(ev.clientX, ev.clientY, pending.id);
          renderWires();
        }

        function onUp(ev) {
          try { dot.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
          dot.removeEventListener('pointermove', onMove);
          dot.removeEventListener('pointerup', onUp);
          dot.removeEventListener('pointercancel', onUp);

          var t = portTargetAt(ev.clientX, ev.clientY, pending.id);
          var landed = !!t;
          if (landed) {
            state.links.push({
              a: { id: pending.id, side: pending.side },
              b: { id: t.id, side: t.side }
            });
          }

          // Keep the loose wire's shape so it can dissolve instead of
          // vanishing; renderWires is about to clear the live one.
          var ghost = wires.querySelector('.wire-pending');
          var ghostD = ghost && !landed ? ghost.getAttribute('d') : null;

          pending = null;
          renderWires();
          if (ghostD) fadeOutWire(ghostD);
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

  function boardTotal() {
    var sum = 0;
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      sum += parseMoney(b.price) * parseQty(b.qty);
    }
    return sum;
  }

  function recomputeTotal() {
    var sum = boardTotal();
    totalEl.textContent = money(sum);

    var budget = parseMoney(state.budget);
    var hasBudget = budget > 0;
    var over = hasBudget && sum > budget;

    totalWrap.classList.toggle('has-budget', hasBudget);
    totalWrap.classList.toggle('over', over);

    if (hasBudget) {
      budgetFill.style.width = (Math.min(1, sum / budget) * 100).toFixed(1) + '%';
      totalWrap.title = over
        ? money(sum - budget) + ' over budget'
        : money(budget - sum) + ' left of ' + money(budget);
    } else {
      budgetFill.style.width = '0%';
      totalWrap.title = 'Sum of all part prices';
    }
    if (summaryOpen) renderBudgetStat(sum, budget);
  }

  /** Mirrors the header gauge as a figure in the summary panel. */
  function renderBudgetStat(sum, budget) {
    var stat = document.getElementById('sum-left-stat');
    if (!(budget > 0)) {
      stat.hidden = true;
      return;
    }
    var over = sum > budget;
    stat.hidden = false;
    stat.classList.toggle('over', over);
    document.getElementById('sum-left-k').textContent = over ? 'Over' : 'Left';
    document.getElementById('sum-left').textContent =
      money(Math.abs(budget - sum));
  }

  /* --------------------------------------------------------------- budget */

  function commitBudget() {
    var raw = budgetInput.value.trim();
    if (!raw) {
      state.budget = '';
      budgetInput.value = '';
    } else if (!/\d/.test(raw)) {
      // Not a number at all — put back whatever was there rather than clearing.
      budgetInput.value = state.budget || '';
      return;
    } else {
      state.budget = money(parseMoney(raw));
      budgetInput.value = state.budget;
    }
    recomputeTotal();
    save();
  }

  budgetInput.addEventListener('blur', commitBudget);
  budgetInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitBudget();
      budgetInput.blur();
    }
  });

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

  // The build total is a plain sum and assumes one currency, so a symbol here
  // is a label rather than a conversion.
  var CURRENCY = {
    USD: '$', CAD: '$', AUD: '$', NZD: '$',
    GBP: '£', EUR: '€', JPY: '¥'
  };

  function currencySymbol(code) {
    if (!code) return '$';
    return CURRENCY[String(code).toUpperCase()] || '';
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
    // Only fill a price the user hasn't set, so a hand-entered figure or one
    // from a previous fetch is never overwritten.
    if (!String(block.price || '').trim() && data.price != null) {
      block.price = currencySymbol(data.currency) + Number(data.price).toFixed(2);
      refs.price.value = block.price;
      recomputeTotal();
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
        type: DEFAULT_TYPE,
        status: DEFAULT_STATUS,
        url: '',
        title: '',
        price: '',
        qty: '1',
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
      type: el.querySelector('.f-type'),
      typeText: el.querySelector('.ft-text'),
      status: el.querySelector('.status'),
      title: el.querySelector('.f-title'),
      price: el.querySelector('.f-price'),
      qty: el.querySelector('.f-qty'),
      url: el.querySelector('.f-url'),
      msg: el.querySelector('.msg'),
      notes: el.querySelector('.f-notes'),
      open: el.querySelector('.open'),
      manual: el.querySelector('.manual'),
      del: el.querySelector('.del'),
      ports: {
        l: el.querySelector('.port.pl'),
        r: el.querySelector('.port.pr'),
        t: el.querySelector('.port.pt'),
        b: el.querySelector('.port.pb')
      },
      grips: {
        n: el.querySelector('.rz-n'), s: el.querySelector('.rz-s'),
        w: el.querySelector('.rz-w'), e: el.querySelector('.rz-e'),
        nw: el.querySelector('.rz-nw'), ne: el.querySelector('.rz-ne'),
        sw: el.querySelector('.rz-sw'), se: el.querySelector('.rz-se')
      }
    };

    el.dataset.id = block.id;
    // Cards are resizable again; only fill in or clamp what's missing or
    // out of range rather than forcing every block to one size.
    block.w = clamp(block.w || CARD_W, MIN_W, MAX_W);
    block.h = clamp(block.h || CARD_H, MIN_H, MAX_H);
    place(el, block);

    refs.title.value = block.title || '';
    refs.price.value = block.price || '';
    // Quantity is a real value, not a placeholder, so an existing board with a
    // blank qty is brought up to the default on load.
    if (!block.qty) block.qty = '1';
    refs.qty.value = block.qty;
    // Boards saved before part types and statuses existed take the defaults.
    if (!block.type) block.type = DEFAULT_TYPE;
    refs.typeText.textContent = block.type;
    // "Installed" was dropped; boards holding it land on the furthest state
    // that still exists rather than resetting to the start.
    if (block.status === 'Installed') block.status = 'Arrived';
    if (STATUSES.indexOf(block.status) === -1) block.status = DEFAULT_STATUS;
    refs.status.dataset.status = block.status;
    refs.status.textContent = block.status;
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

    function addImage(url) {
      block.images = (block.images || []).concat([url]);
      block.imgIndex = block.images.length - 1;
      showImage(block, refs);
      save();
    }
    refs.addImage = addImage;

    refs.manual.addEventListener('click', function () {
      askPasteUrl(refs.manual, addImage);
    });

    refs.type.addEventListener('click', function () {
      openTypePicker(block, refs);
    });

    refs.status.addEventListener('click', function () {
      openStatusPicker(block, refs);
    });

    // Delete asks first, via the shared popup anchored under this button.
    refs.del.addEventListener('click', function () {
      askConfirm(refs.del, function () { removeBlock(block.id); });
    });

    // Right-click anywhere on the block that isn't a field or a button. Over
    // those, the browser's own menu is left alone so copy/paste still works.
    el.addEventListener('contextmenu', function (e) {
      if (e.target.closest(NO_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(block, el);
      closeConfirm();

      var items = [
        { label: 'Duplicate', run: function () { duplicateBlock(block); } },
        { label: 'Paste image URL…', prompt: true, run: refs.addImage }
      ];
      if (block.url) {
        items.push({
          label: 'Open product page',
          run: function () { window.open(block.url, '_blank', 'noopener'); }
        });
      }
      if ((block.images || []).length) {
        items.push({
          label: 'Clear image',
          run: function () {
            block.images = [];
            block.imgIndex = 0;
            showImage(block, refs);
            save();
          }
        });
      }
      items.push('-');
      items.push({
        label: 'Delete part',
        danger: true,
        confirm: true,
        run: function () { removeBlock(block.id); }
      });

      openCtx(e.clientX, e.clientY, items);
    });

    dragBehaviour(el, block, refs);
    resizeBehaviour(el, block, refs);
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

  function bringToFront(block, el) {
    block.z = ++state.seq;
    el.style.zIndex = block.z;
  }

  /* ------------------------------------------------------------- resizing */

  var RESIZE_DIRS = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];

  function resizeBehaviour(el, block, refs) {
    RESIZE_DIRS.forEach(function (dir) {
      var grip = refs.grips[dir];

      grip.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation(); // never let this become a card drag
        bringToFront(block, el);
        closeConfirm();

        var startX = e.clientX;
        var startY = e.clientY;
        var o = { x: block.x, y: block.y, w: block.w, h: block.h };
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

        function onMove(ev) {
          var dx = (ev.clientX - startX) / state.view.s;
          var dy = (ev.clientY - startY) / state.view.s;
          var w = o.w, h = o.h, x = o.x, y = o.y;

          if (dir.indexOf('e') > -1) w = clamp(o.w + dx, MIN_W, MAX_W);
          if (dir.indexOf('s') > -1) h = clamp(o.h + dy, MIN_H, MAX_H);
          // Dragging a top or left edge moves the block as well as sizing it,
          // so the opposite edge stays put.
          if (dir.indexOf('w') > -1) { w = clamp(o.w - dx, MIN_W, MAX_W); x = o.x + (o.w - w); }
          if (dir.indexOf('n') > -1) { h = clamp(o.h - dy, MIN_H, MAX_H); y = o.y + (o.h - h); }

          block.x = Math.round(x);
          block.y = Math.round(y);
          block.w = Math.round(w);
          block.h = Math.round(h);
          place(el, block);
          renderWires(); // sockets move with the edges
        }

        function onUp(ev) {
          try { grip.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
          grip.removeEventListener('pointermove', onMove);
          grip.removeEventListener('pointerup', onUp);
          grip.removeEventListener('pointercancel', onUp);
          save();
        }

        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
        grip.addEventListener('pointercancel', onUp);
      });
    });
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
      closeConfirm();

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

  // Right-click on bare canvas.
  stage.addEventListener('contextmenu', function (e) {
    if (e.target !== stage && e.target !== world && e.target !== emptyHint) return;
    e.preventDefault();
    closeConfirm();

    // Remember where the click landed so a new part lands there too.
    var spot = toWorld(e.clientX, e.clientY);
    openCtx(e.clientX, e.clientY, [
      {
        label: '+ Add part',
        // Top-left corner lands on the cursor, not the block's centre.
        run: function () {
          createBlock({ x: Math.round(spot.x), y: Math.round(spot.y) });
        }
      },
      { label: 'Reset view', run: resetView },
      '-',
      { label: 'Clear board', danger: true, confirm: true, run: clearBoard }
    ]);
  });

  var marquee = document.getElementById('marquee');

  /** Draws the selection rectangle. Purely visual at this stage. */
  function startMarquee(e) {
    var box = stage.getBoundingClientRect();
    var x0 = e.clientX - box.left;
    var y0 = e.clientY - box.top;

    marquee.classList.add('on');
    marquee.style.left = x0 + 'px';
    marquee.style.top = y0 + 'px';
    marquee.style.width = '0px';
    marquee.style.height = '0px';

    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }

    function onMove(ev) {
      var x1 = ev.clientX - box.left;
      var y1 = ev.clientY - box.top;
      marquee.style.left = Math.min(x0, x1) + 'px';
      marquee.style.top = Math.min(y0, y1) + 'px';
      marquee.style.width = Math.abs(x1 - x0) + 'px';
      marquee.style.height = Math.abs(y1 - y0) + 'px';
    }

    function onUp(ev) {
      try { stage.releasePointerCapture(ev.pointerId); } catch (err) { /* never captured */ }
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
      marquee.classList.remove('on');
    }

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  }

  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target !== stage && e.target !== world && e.target !== emptyHint) return;

    // Touching the background drops focus out of whatever field was being
    // typed in — a card's, or the board name in the header. preventDefault
    // below would otherwise keep the caret blinking there. For the URL field
    // this is also what triggers its image fetch.
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      active.blur();
    }
    closeConfirm();
    closeCtx();

    e.preventDefault();

    // Ctrl or Shift turns the drag into a selection marquee instead of a pan.
    // It only draws for now — nothing is selected by it yet.
    if (e.button === 0 && (e.ctrlKey || e.shiftKey)) {
      startMarquee(e);
      return;
    }

    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    stage.classList.add('panning');

    // Panning is applied incrementally, from the previous pointer position
    // rather than from where the drag began. Anchoring to the start point
    // meant a wheel-zoom mid-drag — which moves view.x/y to keep the cursor
    // pinned — was undone by the next pointermove, and the view lurched.
    var lastX = e.clientX;
    var lastY = e.clientY;

    function onMove(ev) {
      state.view.x += ev.clientX - lastX;
      state.view.y += ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
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
  document.getElementById('zoom-reset').addEventListener('click', resetView);

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z). Skipped while a field has focus so the
  // browser's own text undo keeps working inside inputs.
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

    var key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });

  /* ---------------------------------------------------------- confirmation */

  var confirmEl = document.getElementById('confirm');
  var pastePop = document.getElementById('paste-pop');
  var pasteInput = pastePop.querySelector('.pp-input');
  var confirmAction = null;
  var pasteAction = null;

  /**
   * Position a popup against `anchor`. With `overlap` it is raised by a third
   * of its height so its top sits over the anchor — used from the context
   * menu, where it should read as belonging to the row it came from.
   */
  function placePopup(el, anchor, overlap, alignLeft) {
    // visibility:hidden still lays out, so it measures before being shown.
    el.style.left = '0px';
    el.style.top = '0px';
    var w = el.offsetWidth;
    var h = el.offsetHeight;

    var r = anchor.getBoundingClientRect();
    // Right-aligned by default, which throws a wide popup far to the left of a
    // narrow anchor. alignLeft starts it at the anchor instead.
    var left = alignLeft ? r.left : r.right - w;
    left = Math.min(left, window.innerWidth - w - 8);
    var top = overlap ? r.bottom - Math.round(h / 3) : r.bottom + 5;
    if (top + h > window.innerHeight - 8) top = r.top - h - 5; // flip above

    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
  }

  function closeConfirm() {
    confirmEl.classList.remove('show');
    confirmAction = null;
    undimCtx();
  }

  function closePaste() {
    pastePop.classList.remove('show');
    pasteInput.classList.remove('bad');
    pasteAction = null;
    undimCtx();
  }

  /** Drop the shared "Are you sure?" against `anchor`, running `onYes` if taken. */
  function askConfirm(anchor, onYes, overlap) {
    closePaste();
    confirmAction = onYes;
    placePopup(confirmEl, anchor, overlap);
    confirmEl.classList.add('show');
  }

  /** Ask for an image address, handing the trimmed URL to `onSubmit`. */
  function askPasteUrl(anchor, onSubmit, overlap) {
    closeConfirm();
    pasteAction = onSubmit;
    pasteInput.value = '';
    pasteInput.classList.remove('bad');
    placePopup(pastePop, anchor, overlap, true);
    pastePop.classList.add('show');
    setTimeout(function () { pasteInput.focus(); }, 20);
  }

  confirmEl.querySelector('.confirm-yes').addEventListener('click', function () {
    var run = confirmAction;
    closeConfirm();
    closeCtx();
    if (run) run();
  });
  confirmEl.querySelector('.confirm-no').addEventListener('click', closeConfirm);

  function submitPaste() {
    var value = pasteInput.value.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) {
      pasteInput.classList.add('bad');
      pasteInput.focus();
      return;
    }
    var run = pasteAction;
    closePaste();
    closeCtx();
    if (run) run(value);
  }

  pastePop.querySelector('.pp-add').addEventListener('click', submitPaste);
  pastePop.querySelector('.pp-cancel').addEventListener('click', closePaste);
  pasteInput.addEventListener('input', function () {
    pasteInput.classList.remove('bad');
  });
  pasteInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitPaste(); }
    if (e.key === 'Escape') { e.preventDefault(); closePaste(); closeCtx(); }
  });

  /* --------------------------------------------------------- context menu */

  var ctx = document.getElementById('ctx');

  function closeCtx() {
    ctx.classList.remove('show');
    ctx.classList.remove('dimmed');
    ctx.classList.remove('picker');
  }
  function dimCtx() { ctx.classList.add('dimmed'); }
  function undimCtx() { ctx.classList.remove('dimmed'); }

  /**
   * items: array of { label, run, danger } or the string '-' for a separator.
   * Placed at the cursor, nudged back inside the window if it would overflow.
   */
  function openCtx(clientX, clientY, items) {
    ctx.innerHTML = '';
    items.forEach(function (item) {
      if (item === '-') {
        var sep = document.createElement('div');
        sep.className = 'sep';
        ctx.appendChild(sep);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      if (item.danger) b.className = 'danger';
      if (item.on) b.classList.add('on');
      b.addEventListener('click', function () {
        // The menu stays open behind these, dimmed, with the popup straddling
        // the row so the two read as one control. Dim *after* opening: each
        // opener closes the other popup first, and closing undims.
        if (item.confirm) {
          askConfirm(b, item.run, true);
          dimCtx();
          return;
        }
        if (item.prompt) {
          askPasteUrl(b, item.run, true);
          dimCtx();
          return;
        }
        closeCtx();
        item.run();
      });
      ctx.appendChild(b);
    });

    // visibility:hidden still lays out, so it can be measured before showing.
    ctx.style.left = '0px';
    ctx.style.top = '0px';
    var w = ctx.offsetWidth;
    var h = ctx.offsetHeight;
    ctx.style.left = Math.max(8, Math.min(clientX, window.innerWidth - w - 8)) + 'px';
    ctx.style.top = Math.max(8, Math.min(clientY, window.innerHeight - h - 8)) + 'px';
    ctx.classList.add('show');
  }

  // Any press outside the menu dismisses it. Right-clicks land here first and
  // the contextmenu event that follows reopens it in the new place.
  document.addEventListener('pointerdown', function (e) {
    // Let the popups' own controls handle their clicks.
    if (confirmEl.contains(e.target) || pastePop.contains(e.target)) return;
    if (!ctx.contains(e.target)) closeCtx();
    closeConfirm();
    closePaste();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeCtx(); closeConfirm(); closePaste(); }
  });
  window.addEventListener('blur', function () {
    closeCtx(); closeConfirm(); closePaste();
  });

  /* --------------------------------------------------------- summary panel */

  var summaryEl = document.getElementById('summary');
  var sumList = document.getElementById('sum-list');
  var summaryOpen = false;
  var groupMode = 'vendor';

  /** Store name from the product URL — no extra field for the user to fill. */
  function vendorOf(block) {
    var u = String(block.url || '').trim();
    if (!u) return 'No vendor';
    try {
      return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
    } catch (e) {
      return 'No vendor';
    }
  }

  function groupKeyFor(block) {
    if (groupMode === 'type') return block.type || DEFAULT_TYPE;
    if (groupMode === 'status') return block.status || DEFAULT_STATUS;
    return vendorOf(block);
  }

  function lineTotal(block) {
    return parseMoney(block.price) * parseQty(block.qty);
  }

  function money(n) {
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * Blocks bucketed by the current grouping. Vendors sort by spend — the store
   * you owe the most to first — while type and status keep their own running
   * order so the list reads like a build rather than an alphabet.
   */
  function buildGroups() {
    var map = new Map();
    state.blocks.forEach(function (b) {
      var key = groupKeyFor(b);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(b);
    });

    var groups = [];
    map.forEach(function (items, key) {
      groups.push({
        key: key,
        items: items,
        subtotal: items.reduce(function (sum, b) { return sum + lineTotal(b); }, 0),
        units: items.reduce(function (sum, b) { return sum + parseQty(b.qty); }, 0)
      });
    });

    var order = groupMode === 'type' ? PART_TYPES
      : groupMode === 'status' ? STATUSES
      : null;

    groups.sort(function (a, b) {
      if (order) {
        var ai = order.indexOf(a.key);
        var bi = order.indexOf(b.key);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      }
      if (b.subtotal !== a.subtotal) return b.subtotal - a.subtotal;
      return a.key.localeCompare(b.key);
    });
    return groups;
  }

  function renderSummary() {
    var groups = buildGroups();
    var units = 0;
    var total = 0;
    state.blocks.forEach(function (b) {
      units += parseQty(b.qty);
      total += lineTotal(b);
    });

    document.getElementById('sum-parts').textContent = state.blocks.length;
    document.getElementById('sum-items').textContent = units;
    document.getElementById('sum-total').textContent = money(total);
    renderBudgetStat(total, parseMoney(state.budget));

    sumList.innerHTML = '';
    if (!state.blocks.length) {
      var empty = document.createElement('p');
      empty.className = 'sum-empty';
      empty.textContent = 'Nothing on the board yet.';
      sumList.appendChild(empty);
      return;
    }

    groups.forEach(function (g) {
      var wrap = document.createElement('div');
      wrap.className = 'sum-group';

      var head = document.createElement('div');
      head.className = 'sum-group-head';
      var name = document.createElement('span');
      name.className = 'sum-group-name';
      name.textContent = g.key;
      var count = document.createElement('span');
      count.className = 'sum-group-count';
      count.textContent = g.items.length + (g.items.length === 1 ? ' part' : ' parts');
      var sub = document.createElement('span');
      sub.className = 'sum-group-sub';
      sub.textContent = money(g.subtotal);
      head.appendChild(name);
      head.appendChild(count);
      head.appendChild(sub);
      wrap.appendChild(head);

      g.items.forEach(function (b) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'sum-row';

        var label = document.createElement('span');
        label.className = 'sum-row-name';
        if (b.title) {
          label.textContent = b.title;
        } else {
          label.textContent = 'Untitled ' + (b.type || DEFAULT_TYPE).toLowerCase();
          label.classList.add('untitled');
        }

        var qty = document.createElement('span');
        qty.className = 'sum-row-qty';
        var q = parseQty(b.qty);
        qty.textContent = q > 1 ? '×' + q : '';

        var price = document.createElement('span');
        price.className = 'sum-row-price';
        var value = lineTotal(b);
        if (value > 0) {
          price.textContent = money(value);
        } else {
          price.textContent = '—';
          price.classList.add('none');
        }

        row.appendChild(label);
        row.appendChild(qty);
        row.appendChild(price);
        row.addEventListener('click', function () { focusBlock(b.id); });
        wrap.appendChild(row);
      });

      sumList.appendChild(wrap);
    });
  }

  /** Centre the canvas on a block and pulse it, so a row points somewhere. */
  function focusBlock(id) {
    var b = findBlock(id);
    if (!b) return;
    var v = state.view;
    // Aim at the middle of what's actually visible beside the open panel.
    var usableW = stage.clientWidth - (summaryOpen ? summaryEl.offsetWidth + 20 : 0);
    v.x = usableW / 2 - (b.x + b.w / 2) * v.s;
    v.y = stage.clientHeight / 2 - (b.y + b.h / 2) * v.s;
    applyView();

    var entry = nodes.get(id);
    if (entry) {
      bringToFront(b, entry.el);
      entry.el.classList.add('flash');
      setTimeout(function () { entry.el.classList.remove('flash'); }, 850);
    }
    save();
  }

  function setSummaryOpen(open) {
    summaryOpen = open;
    summaryEl.classList.toggle('show', open);
    document.getElementById('summary-toggle').classList.toggle('primary', open);
    if (open) renderSummary();
  }

  document.getElementById('summary-toggle').addEventListener('click', function () {
    setSummaryOpen(!summaryOpen);
  });
  document.getElementById('sum-close').addEventListener('click', function () {
    setSummaryOpen(false);
  });

  document.getElementById('sum-group').addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn) return;
    groupMode = btn.dataset.group;
    [].forEach.call(this.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('on', b === btn);
    });
    renderSummary();
  });

  /* ------------------------------------------------------------ list export */

  function boardTitle() {
    return (state.name || '').trim() || 'Untitled board';
  }

  function summaryAsMarkdown() {
    var lines = ['# ' + boardTitle(), ''];
    var total = 0;
    buildGroups().forEach(function (g) {
      lines.push('## ' + g.key + ' — ' + g.items.length +
        (g.items.length === 1 ? ' part' : ' parts') + ' — ' + money(g.subtotal));
      lines.push('');
      g.items.forEach(function (b) {
        var q = parseQty(b.qty);
        var bits = [b.title || 'Untitled ' + (b.type || DEFAULT_TYPE).toLowerCase()];
        bits.push(b.type || DEFAULT_TYPE);
        if (q > 1) bits.push('×' + q);
        if (lineTotal(b) > 0) bits.push(money(lineTotal(b)));
        bits.push(b.status || DEFAULT_STATUS);
        var line = '- [ ] ' + bits.join(' — ');
        if (b.url) line += '  \n  ' + b.url;
        lines.push(line);
        total += lineTotal(b);
      });
      lines.push('');
    });
    lines.push('**Build total: ' + money(total) + '**');
    return lines.join('\n');
  }

  function summaryAsCsv() {
    var rows = [['Type', 'Name', 'Vendor', 'Qty', 'Unit price', 'Line total', 'Status', 'URL']];
    // Quote every field and double any inner quotes, so names containing
    // commas or quotes survive the round trip into a spreadsheet.
    var esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    buildGroups().forEach(function (g) {
      g.items.forEach(function (b) {
        rows.push([
          b.type || DEFAULT_TYPE,
          b.title || '',
          vendorOf(b),
          parseQty(b.qty),
          parseMoney(b.price).toFixed(2),
          lineTotal(b).toFixed(2),
          b.status || DEFAULT_STATUS,
          b.url || ''
        ]);
      });
    });
    return rows.map(function (r) { return r.map(esc).join(','); }).join('\r\n');
  }

  function download(text, mime, extension) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename(extension);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  document.querySelector('.sum-exports').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-export]');
    if (!btn) return;
    var kind = btn.dataset.export;

    if (kind === 'md') {
      download(summaryAsMarkdown(), 'text/markdown;charset=utf-8', 'md');
    } else if (kind === 'csv') {
      download(summaryAsCsv(), 'text/csv;charset=utf-8', 'csv');
    } else if (kind === 'copy') {
      var original = btn.textContent;
      var done = function (ok) {
        btn.textContent = ok ? 'Copied' : 'Failed';
        setTimeout(function () { btn.textContent = original; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(summaryAsMarkdown()).then(
          function () { done(true); },
          function () { done(false); }
        );
      } else {
        done(false);
      }
    }
  });

  /* ----------------------------------------------------------- part types */

  // Ordered roughly the way a guitar goes together, so the menu reads like a
  // build rather than an alphabetical list. "Part" is the untyped default.
  var PART_TYPES = [
    'Part',
    'Body', 'Neck', 'Fretboard', 'Frets', 'Nut',
    'Pickups', 'Electronics', 'Knobs', 'Switch', 'Jack',
    'Bridge', 'Tailpiece', 'Tuners', 'Pickguard', 'Hardware',
    'Strings', 'Finish', 'Tools', 'Other'
  ];
  var DEFAULT_TYPE = 'Part';

  // Where a part is in the process of actually getting onto the guitar.
  var STATUSES = ['Wishlist', 'Ordered', 'Arrived'];
  var DEFAULT_STATUS = 'Wishlist';

  /** Opens a list under `anchor`, marking the current value. */
  function openPicker(anchor, options, current, choose) {
    var r = anchor.getBoundingClientRect();
    openCtx(r.left, r.bottom + 4, options.map(function (name) {
      return {
        label: name,
        on: current === name,
        run: function () { choose(name); }
      };
    }));
    ctx.classList.add('picker');
  }

  function openTypePicker(block, refs) {
    openPicker(refs.type, PART_TYPES, block.type || DEFAULT_TYPE, function (name) {
      block.type = name;
      refs.typeText.textContent = name;
      save();
    });
  }

  function openStatusPicker(block, refs) {
    openPicker(refs.status, STATUSES, block.status || DEFAULT_STATUS, function (name) {
      block.status = name;
      refs.status.dataset.status = name;
      refs.status.textContent = name;
      save();
    });
  }

  function duplicateBlock(block) {
    var copy = JSON.parse(JSON.stringify(block));
    copy.id = 'b' + state.seq++;
    copy.x = block.x + 26;
    copy.y = block.y + 26;
    copy.z = state.seq;
    state.blocks.push(copy);
    mountBlock(copy);
    refreshEmptyHint();
    recomputeTotal();
    save();
  }

  function resetView() {
    state.view = { x: 60, y: 40, s: 1 };
    applyView();
    save();
  }

  /** Empties the board but keeps its name. Callers ask for confirmation. */
  function clearBoard() {
    resetBoard({
      name: state.name, budget: state.budget, blocks: [], links: [],
      view: { x: 60, y: 40, s: 1 }, seq: 1
    });
  }

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
  function exportFilename(extension) {
    var base = (state.name || '').trim()
      .replace(/[\\/:*?"<>|]+/g, '')  // characters filesystems reject
      .replace(/\s+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 60);
    return (base || 'gcl-board') + '.' + (extension || 'json');
  }

  document.getElementById('export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], {
      type: 'application/json'
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename('json');
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

  // Shares clearBoard with the canvas context menu; both confirm first.
  var clearBtn = document.getElementById('clear');
  clearBtn.addEventListener('click', function () {
    if (!state.blocks.length) return;
    askConfirm(clearBtn, clearBoard);
  });

  function resetBoard(data) {
    nodes.forEach(function (n) { n.el.remove(); });
    nodes.clear();
    state.name = typeof data.name === 'string' ? data.name : '';
    boardNameInput.value = state.name;
    state.budget = typeof data.budget === 'string' ? data.budget : '';
    budgetInput.value = state.budget;
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
  budgetInput.value = state.budget || '';
  state.blocks.forEach(mountBlock);
  applyView();
  refreshEmptyHint();
  recomputeTotal();
  renderWires();

  // Baseline for the history stack: the board as it was loaded.
  lastSnap = snapshot();
  refreshHistoryButtons();
})();
