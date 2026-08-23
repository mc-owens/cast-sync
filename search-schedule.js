document.addEventListener('DOMContentLoaded', async () => {

  // ── Constants ──────────────────────────────────────────────────────────────
  const startHour  = 8;
  const endHour    = 23;
  const increment  = 15;
  const slotHeight = 12.5;
  const DAYS       = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const DAYS_SHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const DAY_ORDER  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const MINI_START = 8 * 60;
  const MINI_END   = 23 * 60;
  const MINI_RANGE = MINI_END - MINI_START;

  // ── State ──────────────────────────────────────────────────────────────────
  let _pieces             = [];
  let _allBlocks          = [];
  let _availFull          = [];
  let _availPartial       = [];
  let _availNone          = [];
  let _availPieceId       = null;
  let _sortMode           = 'rated';
  let _gridReady          = false;
  let _liveCastMembers    = new Map(); // userId -> display name
  let _liveCastUnderstudies = new Map();
  let _auditData          = {};  // userId -> { hasNote, notes, pieceRatings }
  let _comparePieceId        = null;
  let _compareAvailFull      = [];
  let _compareAvailPartial   = [];
  let _compareAvailNone      = [];
  let _compareAuditData      = {};
  let _compareLiveCastMbrs   = new Map();
  let _compareLiveCastUds    = new Map();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function timeStringToMinutes(timeStr) {
    const [time, ampm] = timeStr.trim().split(' ');
    const [h, m]       = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }

  function timeStringToTopPx(timeStr) {
    return ((timeStringToMinutes(timeStr) - startHour * 60) / increment) * slotHeight;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function formatTime(h, m) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr   = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showErrorToast(msg) {
    document.getElementById('error-toast-body').textContent = msg;
    new bootstrap.Toast(document.getElementById('error-toast')).show();
  }

  // ── Piece selector ─────────────────────────────────────────────────────────

  function initPieceSelector(pieces) {
    const sel = document.getElementById('piece-select');
    pieces.forEach(p => {
      const opt       = document.createElement('option');
      opt.value       = String(p.id);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => selectPiece(sel.value));

    const selB = document.getElementById('piece-select-b');
    selB.addEventListener('change', () => {
      if (selB.value) {
        document.getElementById('clear-compare-btn').style.display = '';
        selectComparePiece(selB.value);
      } else {
        clearCompare();
      }
    });
    document.getElementById('clear-compare-btn').addEventListener('click', () => {
      selB.value = '';
      clearCompare();
    });

    // Restore last-viewed piece on page load
    const saved = localStorage.getItem('search_selected_piece');
    if (saved && pieces.some(p => String(p.id) === saved)) {
      sel.value = saved;
      selectPiece(saved);
    }
  }

  async function selectPiece(pieceId) {
    const contentEl  = document.getElementById('analysis-content');
    const loadingEl  = document.getElementById('analysis-loading');
    if (!pieceId) {
      contentEl.style.display = 'none';
      document.getElementById('compare-selector-wrapper').style.display = 'none';
      localStorage.removeItem('search_selected_piece');
      return;
    }

    loadingEl.style.display = '';
    contentEl.style.display = 'none';

    try {
      const res  = await fetch(`/api/availability/piece/${pieceId}`);
      const data = await res.json();
      if (!res.ok) { showErrorToast(data.error || 'Could not load availability.'); return; }

      document.getElementById('piece-color-swatch').style.background = data.piece.color || '#6366f1';
      document.getElementById('piece-name-display').textContent      = data.piece.name;
      clearCompare();
      populateCompareSelector(pieceId);
      document.getElementById('compare-selector-wrapper').style.display = 'flex';
      localStorage.setItem('search_selected_piece', pieceId);

      renderRequirements(data.requirements);

      _availFull    = data.fully_available    || [];
      _availPartial = data.partially_available || [];
      _availNone    = data.not_available       || [];
      _availPieceId = pieceId;

      initLiveCast([..._availFull, ..._availPartial, ..._availNone]);

      // Fetch audition day data (note dots + P/HP ratings) in background — non-blocking
      _auditData = {};
      fetch(`/api/audition-casting/${pieceId}`)
        .then(r => r.ok ? r.json() : {})
        .then(d => { _auditData = d || {}; renderDancerSections(); })
        .catch(() => {});

      setSortMode('rated');
      contentEl.style.display = '';
    } catch (err) {
      showErrorToast('Could not load availability data.');
      console.error(err);
    } finally {
      loadingEl.style.display = 'none';
    }
  }

  // ── Requirements card ──────────────────────────────────────────────────────

  function renderRequirements(requirements) {
    const listEl = document.getElementById('requirements-list');

    if (!requirements || requirements.length === 0) {
      listEl.innerHTML = '<span style="font-size:13px;color:#9ca3af;">No rehearsal blocks scheduled for this piece yet.</span>';
      return;
    }

    listEl.innerHTML = requirements.map(r => {
      const groups = {};
      r.blocks.forEach(b => {
        const key = `${b.start_time}|||${b.end_time}`;
        if (!groups[key]) groups[key] = { days: [], start: b.start_time, end: b.end_time };
        groups[key].days.push(b.day);
      });
      const blockStr = Object.values(groups).map(g => {
        g.days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
        return `${g.days.join(', ')} ${g.start} – ${g.end}`;
      }).join(' &nbsp;&middot;&nbsp; ');

      if (r.date_label) {
        return `<div style="display:flex;gap:20px;align-items:baseline;padding:2px 0;font-size:13px;">
          <span style="color:#374151;font-weight:600;min-width:130px;flex-shrink:0;">${escapeHtml(r.date_label)}</span>
          <span style="color:#6b7280;">${blockStr}</span>
        </div>`;
      }
      return `<div style="font-size:13px;color:#6b7280;">${blockStr}</div>`;
    }).join('');
  }

  // ── Dancer sorting ─────────────────────────────────────────────────────────

  function auditRank(dancer) {
    const a = _auditData[dancer.id] || {};
    const ratings = a.pieceRatings || [];
    if (ratings.some(r => r.level === 'high_priority')) return 0;
    if (ratings.some(r => r.level === 'priority'))      return 1;
    if (a.hasNote)                                       return 2;
    return 3;
  }

  function sortDancers(arr) {
    return [...arr].sort((a, b) => {
      if (_sortMode === 'rated') {
        const ra = auditRank(a), rb = auditRank(b);
        if (ra !== rb) return ra - rb;
      }
      if (_sortMode === 'num') {
        const an = a.audition_number != null ? Number(a.audition_number) : Infinity;
        const bn = b.audition_number != null ? Number(b.audition_number) : Infinity;
        if (an !== bn) return an - bn;
      }
      const lc = (a.last_name || '').localeCompare(b.last_name || '');
      return lc !== 0 ? lc : (a.first_name || '').localeCompare(b.first_name || '');
    });
  }

  function setSortMode(mode) {
    _sortMode = mode;
    ['sort-ratings','sort-abc','sort-num'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const active = (id === 'sort-ratings' && mode === 'rated') ||
                     (id === 'sort-abc'     && mode === 'abc')   ||
                     (id === 'sort-num'     && mode === 'num');
      el.className = active ? 'btn btn-sm btn-secondary' : 'btn btn-sm btn-outline-secondary';
      el.style.fontSize = '12px';
    });
    renderDancerSections();
    if (_comparePieceId) renderCompareSections();
  }

  document.getElementById('sort-abc').addEventListener('click', () => setSortMode('abc'));
  document.getElementById('sort-num').addEventListener('click', () => setSortMode('num'));
  document.getElementById('sort-ratings')?.addEventListener('click', () => setSortMode('rated'));

  // ── Live cast panel ────────────────────────────────────────────────────────

  function initLiveCast(allDancers) {
    _liveCastMembers.clear();
    _liveCastUnderstudies.clear();
    allDancers.forEach(d => {
      if (!d.cast_role) return;
      const name = `${d.first_name} ${d.last_name}`;
      if (d.cast_role === 'member')    _liveCastMembers.set(d.id, name);
      if (d.cast_role === 'understudy') _liveCastUnderstudies.set(d.id, name);
    });
    renderLiveCast();
  }

  function renderLiveCast() {
    const el = document.getElementById('live-cast-panel');
    if (!el) return;
    const mCount = _liveCastMembers.size;
    const uCount = _liveCastUnderstudies.size;
    if (mCount + uCount === 0) {
      el.innerHTML = '<p style="font-size:12.5px;color:#9ca3af;margin:0;">No one added yet.</p>';
      return;
    }
    let html = '';
    if (mCount > 0) {
      html += `<div class="live-cast-row">
        <span class="live-cast-label">Cast (${mCount})</span>
        ${[..._liveCastMembers.values()].map(n => `<span class="live-cast-chip member">${escapeHtml(n)}</span>`).join('')}
      </div>`;
    }
    if (uCount > 0) {
      html += `<div class="live-cast-row">
        <span class="live-cast-label">Understudies (${uCount})</span>
        ${[..._liveCastUnderstudies.values()].map(n => `<span class="live-cast-chip understudy">${escapeHtml(n)}</span>`).join('')}
      </div>`;
    }
    el.innerHTML = html;
  }

  // ── Dancer sections ────────────────────────────────────────────────────────

  function renderDancerSections() {
    const fullyList   = document.getElementById('fully-available-list');
    const partialList = document.getElementById('partially-available-list');
    const noneList    = document.getElementById('not-available-list');

    fullyList.innerHTML   = '';
    partialList.innerHTML = '';
    noneList.innerHTML    = '';

    const full    = sortDancers(_availFull);
    const partial = sortDancers(_availPartial);
    const unavail = sortDancers(_availNone);

    document.getElementById('fully-count').textContent   = `(${full.length})`;
    document.getElementById('partial-count').textContent = `(${partial.length})`;
    document.getElementById('none-count').textContent    = `(${unavail.length})`;

    document.getElementById('no-full').style.display    = full.length    === 0 ? '' : 'none';
    document.getElementById('no-partial').style.display = partial.length === 0 ? '' : 'none';
    document.getElementById('no-none').style.display    = unavail.length === 0 ? '' : 'none';

    full.forEach(d    => appendDancerItem(fullyList,   d, _availPieceId, []));
    partial.forEach(d => appendDancerItem(partialList, d, _availPieceId, d.conflicts || []));
    unavail.forEach(d => appendDancerItem(noneList,    d, _availPieceId, d.conflicts || []));
  }

  // ── Compare piece functions ─────────────────────────────────────────────────

  function populateCompareSelector(excludePieceId) {
    const sel = document.getElementById('piece-select-b');
    sel.innerHTML = '<option value="">Compare with...</option>';
    _pieces.filter(p => String(p.id) !== String(excludePieceId)).forEach(p => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }

  async function selectComparePiece(pieceId) {
    if (!pieceId) { clearCompare(); return; }
    try {
      const res  = await fetch(`/api/availability/piece/${pieceId}`);
      const data = await res.json();
      if (!res.ok) { showErrorToast(data.error || 'Could not load comparison piece.'); return; }

      _comparePieceId      = pieceId;
      _compareAvailFull    = data.fully_available    || [];
      _compareAvailPartial = data.partially_available || [];
      _compareAvailNone    = data.not_available       || [];

      _compareLiveCastMbrs.clear();
      _compareLiveCastUds.clear();
      [..._compareAvailFull, ..._compareAvailPartial, ..._compareAvailNone].forEach(d => {
        const name = `${d.first_name} ${d.last_name}`;
        if (d.cast_role === 'member')    _compareLiveCastMbrs.set(d.id, name);
        if (d.cast_role === 'understudy') _compareLiveCastUds.set(d.id, name);
      });

      document.getElementById('piece-color-swatch-b').style.background = data.piece.color || '#6366f1';
      document.getElementById('piece-name-display-b').textContent       = data.piece.name;
      renderRequirementsB(data.requirements);
      renderLiveCastB();

      _compareAuditData = {};
      fetch(`/api/audition-casting/${pieceId}`)
        .then(r => r.ok ? r.json() : {})
        .then(d => { _compareAuditData = d || {}; renderCompareSections(); })
        .catch(() => {});

      enterCompareMode();
      renderCompareSections();
    } catch (err) {
      showErrorToast('Could not load comparison piece.');
    }
  }

  function clearCompare() {
    _comparePieceId = null;
    _compareAvailFull = []; _compareAvailPartial = []; _compareAvailNone = [];
    _compareAuditData = {};
    _compareLiveCastMbrs.clear(); _compareLiveCastUds.clear();
    document.getElementById('clear-compare-btn').style.display = 'none';
    const selB = document.getElementById('piece-select-b');
    if (selB) selB.value = '';
    exitCompareMode();
  }

  function enterCompareMode() {
    document.getElementById('dancer-columns').classList.add('compare-active');
    document.getElementById('centering-wrapper').style.maxWidth = '1300px';
    document.getElementById('panel-b').style.display = '';
  }

  function exitCompareMode() {
    document.getElementById('dancer-columns').classList.remove('compare-active');
    document.getElementById('centering-wrapper').style.maxWidth = '760px';
    document.getElementById('panel-b').style.display = 'none';
  }

  function renderCompareSections() {
    const opts = {
      auditData: _compareAuditData,
      castMbrs:  _compareLiveCastMbrs,
      castUds:   _compareLiveCastUds,
      onCastChange: renderLiveCastB,
    };
    const full    = sortDancers(_compareAvailFull);
    const partial = sortDancers(_compareAvailPartial);
    const unavail = sortDancers(_compareAvailNone);

    document.getElementById('fully-count-b').textContent   = `(${full.length})`;
    document.getElementById('partial-count-b').textContent = `(${partial.length})`;
    document.getElementById('none-count-b').textContent    = `(${unavail.length})`;

    document.getElementById('no-full-b').style.display    = full.length    === 0 ? '' : 'none';
    document.getElementById('no-partial-b').style.display = partial.length === 0 ? '' : 'none';
    document.getElementById('no-none-b').style.display    = unavail.length === 0 ? '' : 'none';

    const fullyListB   = document.getElementById('fully-available-list-b');
    const partialListB = document.getElementById('partially-available-list-b');
    const noneListB    = document.getElementById('not-available-list-b');
    fullyListB.innerHTML = partialListB.innerHTML = noneListB.innerHTML = '';

    full.forEach(d    => appendDancerItem(fullyListB,   d, _comparePieceId, [], opts));
    partial.forEach(d => appendDancerItem(partialListB, d, _comparePieceId, d.conflicts || [], opts));
    unavail.forEach(d => appendDancerItem(noneListB,    d, _comparePieceId, d.conflicts || [], opts));
  }

  function renderRequirementsB(requirements) {
    const listEl = document.getElementById('requirements-list-b');
    if (!listEl) return;
    if (!requirements || requirements.length === 0) {
      listEl.innerHTML = '<span style="font-size:13px;color:#9ca3af;">No rehearsal blocks scheduled for this piece yet.</span>';
      return;
    }
    listEl.innerHTML = requirements.map(r => {
      const groups = {};
      r.blocks.forEach(b => {
        const key = `${b.start_time}|||${b.end_time}`;
        if (!groups[key]) groups[key] = { days: [], start: b.start_time, end: b.end_time };
        groups[key].days.push(b.day);
      });
      const blockStr = Object.values(groups).map(g => {
        g.days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
        return `${g.days.join(', ')} ${g.start} – ${g.end}`;
      }).join(' &nbsp;&middot;&nbsp; ');
      if (r.date_label) {
        return `<div style="display:flex;gap:20px;align-items:baseline;padding:2px 0;font-size:13px;">
          <span style="color:#374151;font-weight:600;min-width:130px;flex-shrink:0;">${escapeHtml(r.date_label)}</span>
          <span style="color:#6b7280;">${blockStr}</span>
        </div>`;
      }
      return `<div style="font-size:13px;color:#6b7280;">${blockStr}</div>`;
    }).join('');
  }

  function renderLiveCastB() {
    const el = document.getElementById('live-cast-panel-b');
    if (!el) return;
    const mCount = _compareLiveCastMbrs.size;
    const uCount = _compareLiveCastUds.size;
    if (!mCount && !uCount) {
      el.innerHTML = '<p style="font-size:12.5px;color:#9ca3af;margin:0;">No one added yet.</p>';
      return;
    }
    let html = '';
    if (mCount > 0) html += `<div class="live-cast-row">
      <span class="live-cast-label">Cast (${mCount})</span>
      ${[..._compareLiveCastMbrs.values()].map(n => `<span class="live-cast-chip member">${escapeHtml(n)}</span>`).join('')}
    </div>`;
    if (uCount > 0) html += `<div class="live-cast-row">
      <span class="live-cast-label">Understudies (${uCount})</span>
      ${[..._compareLiveCastUds.values()].map(n => `<span class="live-cast-chip understudy">${escapeHtml(n)}</span>`).join('')}
    </div>`;
    el.innerHTML = html;
  }

  // ── Dancer row ─────────────────────────────────────────────────────────────

  function appendDancerItem(listEl, dancer, pieceId, scheduleConflicts, opts = {}) {
    const castMbrs     = opts.castMbrs     || _liveCastMembers;
    const castUds      = opts.castUds      || _liveCastUnderstudies;
    const auditDataMap = opts.auditData    || _auditData;
    const onCastChange = opts.onCastChange || renderLiveCast;

    const li = document.createElement('li');
    li.className = 'avail-dancer-row';

    const isAlreadyCast = !!dancer.conflict_piece_name;
    const baseName = (_sortMode === 'num' && dancer.audition_number)
      ? `#${dancer.audition_number} ${dancer.first_name} ${dancer.last_name}`
      : `${dancer.first_name} ${dancer.last_name}`;

    // Left gutter: fixed-width so all names align regardless of indicators
    const auditCol = document.createElement('div');
    auditCol.style.cssText = 'width:50px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-end;gap:3px;flex-wrap:wrap;';

    const audit = auditDataMap[dancer.id];
    if (audit) {
      const ratings = audit.pieceRatings || [];
      const hasHP   = ratings.some(r => r.level === 'high_priority');
      const hasP    = ratings.some(r => r.level === 'priority');

      if (audit.hasNote) {
        const dot = document.createElement('span');
        const notes = audit.notes || [];
        const noteText = notes.length > 1
          ? notes.map(n => `${n.rater}: ${n.body}`).join('\n\n')
          : notes[0]?.body || 'Has audition note';
        dot.setAttribute('data-bs-toggle', 'tooltip');
        dot.setAttribute('data-bs-placement', 'right');
        dot.setAttribute('title', noteText);
        dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#bbb;flex-shrink:0;display:inline-block;cursor:pointer;';
        if (window.bootstrap) new bootstrap.Tooltip(dot);
        auditCol.appendChild(dot);
      }
      if (hasHP) {
        const chip = document.createElement('span');
        chip.textContent = 'HP';
        chip.style.cssText = 'font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;background:#c9a84c;color:#fff;';
        chip.title = 'High Priority: ' + ratings.filter(r => r.level === 'high_priority').map(r => r.rater).join(', ');
        auditCol.appendChild(chip);
      }
      if (hasP) {
        const chip = document.createElement('span');
        chip.textContent = 'P';
        chip.style.cssText = 'font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;background:rgba(201,168,76,.18);color:#8a6820;border:1px solid rgba(201,168,76,.35);';
        chip.title = 'Priority: ' + ratings.filter(r => r.level === 'priority').map(r => r.rater).join(', ');
        auditCol.appendChild(chip);
      }
    }

    const nameDiv  = document.createElement('div');
    nameDiv.style.cssText = 'flex-shrink:0;max-width:50%;margin-left:6px;';

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'avail-dancer-name' + (isAlreadyCast ? ' conflicted' : '');
    nameSpan.textContent = isAlreadyCast
      ? `${baseName} (already cast in "${dancer.conflict_piece_name}")`
      : baseName;
    nameSpan.title = isAlreadyCast
      ? `Already cast in "${dancer.conflict_piece_name}" at an overlapping time. Click to view schedule.`
      : 'Click to view schedule';
    nameSpan.addEventListener('click', () => openDancerModal(dancer.id));
    nameDiv.appendChild(nameSpan);

    // Conflict detail line for partial / not available
    if (scheduleConflicts && scheduleConflicts.length > 0) {
      const grouped = {};
      scheduleConflicts.forEach(c => {
        const key = `${c.day}|${c.start_time}|${c.end_time}`;
        if (!grouped[key]) grouped[key] = { day: c.day, start_time: c.start_time, end_time: c.end_time, dateLabels: [] };
        if (c.date_label) grouped[key].dateLabels.push(c.date_label);
      });
      const conflictStrs = Object.values(grouped).map(g => {
        const timeStr = `${g.day}s ${g.start_time} – ${g.end_time}`;
        return g.dateLabels.length > 0 ? `${timeStr} (${g.dateLabels.join(', ')})` : timeStr;
      });
      const conflictEl       = document.createElement('div');
      conflictEl.className   = 'avail-conflict-detail';
      conflictEl.textContent = `Unavailable: ${conflictStrs.join('; ')}`;
      nameDiv.appendChild(conflictEl);
    }

    // Cast / Understudy buttons
    let currentRole   = dancer.cast_role;
    let currentCastId = dancer.cast_id;

    const castBtn      = document.createElement('button');
    castBtn.style.cssText = 'font-size:11px;padding:1px 7px;line-height:1.5;';
    const understudyBtn   = document.createElement('button');
    understudyBtn.style.cssText = 'font-size:11px;padding:1px 7px;line-height:1.5;';
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
    btnGroup.appendChild(castBtn);
    btnGroup.appendChild(understudyBtn);

    function renderBtns() {
      if (currentRole === 'member') {
        castBtn.textContent       = '✓ Cast';
        castBtn.className         = 'btn btn-success';
        castBtn.title             = 'Click to remove from cast';
        castBtn.onclick           = removeFromCast;
        understudyBtn.textContent = '→ Understudy';
        understudyBtn.className   = 'btn btn-outline-warning';
        understudyBtn.title       = 'Switch to understudy';
        understudyBtn.onclick     = () => setCast('understudy');
      } else if (currentRole === 'understudy') {
        castBtn.textContent       = '→ Cast';
        castBtn.className         = 'btn btn-outline-primary';
        castBtn.title             = 'Switch to cast member';
        castBtn.onclick           = () => setCast('member');
        understudyBtn.textContent = '✓ Understudy';
        understudyBtn.className   = 'btn btn-warning';
        understudyBtn.title       = 'Click to remove from understudies';
        understudyBtn.onclick     = removeFromCast;
      } else {
        castBtn.textContent       = '+ Cast';
        castBtn.className         = 'btn btn-outline-primary';
        castBtn.title             = '';
        castBtn.onclick           = () => setCast('member');
        understudyBtn.textContent = '+ Understudy';
        understudyBtn.className   = 'btn btn-outline-warning';
        understudyBtn.title       = '';
        understudyBtn.onclick     = () => setCast('understudy');
      }
    }

    async function setCast(role) {
      castBtn.disabled = true; understudyBtn.disabled = true;
      try {
        const res = await fetch('/api/piece-casts', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ piece_id: parseInt(pieceId), user_id: dancer.id, cast_role: role }),
        });
        if (!res.ok) { const d = await res.json(); showErrorToast(d.error || 'Failed to update cast.'); return; }
        const data    = await res.json();
        currentRole   = role;
        currentCastId = data.id;
        const dName = `${dancer.first_name} ${dancer.last_name}`;
        castMbrs.delete(dancer.id);
        castUds.delete(dancer.id);
        if (role === 'member') castMbrs.set(dancer.id, dName);
        else castUds.set(dancer.id, dName);
        onCastChange();
        renderBtns();
      } catch (err) {
        console.error(err);
        showErrorToast('Failed to update cast.');
      } finally {
        castBtn.disabled = false; understudyBtn.disabled = false;
      }
    }

    async function removeFromCast() {
      if (!currentCastId) return;
      castBtn.disabled = true; understudyBtn.disabled = true;
      try {
        const res = await fetch(`/api/piece-casts/${currentCastId}`, { method: 'DELETE' });
        if (!res.ok) { showErrorToast('Could not remove dancer.'); return; }
        currentRole   = null;
        currentCastId = null;
        castMbrs.delete(dancer.id);
        castUds.delete(dancer.id);
        onCastChange();
        renderBtns();
      } catch (err) {
        console.error(err);
      } finally {
        castBtn.disabled = false; understudyBtn.disabled = false;
      }
    }

    const leader = document.createElement('span');
    leader.style.cssText = 'flex:1;min-width:12px;height:1px;border-bottom:2px dotted #e5e7eb;align-self:center;margin-bottom:2px;';

    renderBtns();
    li.appendChild(auditCol);
    li.appendChild(nameDiv);
    li.appendChild(leader);
    li.appendChild(btnGroup);
    listEl.appendChild(li);
  }

  // ── Dancer profile modal ───────────────────────────────────────────────────

  const CATEGORY_COLORS = {
    academic_class: '#3498db', dance_class: '#9b59b6', work: '#e67e22',
    available: '#2ecc71', other: '#95a5a6',
  };
  const CATEGORY_LABELS = {
    academic_class: 'Academic Class', dance_class: 'Dance Class', work: 'Work',
    available: 'Available To Rehearse', other: 'Other',
  };

  async function openDancerModal(id) {
    try {
      const res    = await fetch(`/api/dancers/${id}`);
      const dancer = await res.json();
      document.getElementById('dancer-modal-name').textContent =
        `${dancer.first_name} ${dancer.last_name}`;
      renderMiniSchedule(dancer.availability || []);
      renderScheduleBreakdown(dancer.availability || []);
      populateDancerDetails(dancer);
      document.getElementById('dancer-full-profile').classList.remove('show');
      new bootstrap.Modal(document.getElementById('dancerModal')).show();
    } catch (err) {
      console.error(err);
      alert('Could not load dancer profile.');
    }
  }

  function renderMiniSchedule(availability) {
    const container = document.getElementById('mini-schedule-container');
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;height:180px;border:1px solid #ddd;border-radius:4px;overflow:hidden;background:#fafafa;';

    DAYS.forEach((day, i) => {
      const col = document.createElement('div');
      col.style.cssText = 'flex:1;position:relative;border-right:1px solid #eee;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:9px;text-align:center;background:#f0f0f0;color:#666;padding:2px 0;border-bottom:1px solid #ddd;position:absolute;top:0;left:0;right:0;';
      label.textContent = DAYS_SHORT[i];
      col.appendChild(label);

      const blockArea = document.createElement('div');
      blockArea.style.cssText = 'position:absolute;top:18px;left:0;right:0;bottom:0;';

      availability.filter(b => b.day === day).forEach(block => {
        const startMin   = timeStringToMinutes(block.startTime);
        const endMin     = timeStringToMinutes(block.endTime);
        const clampStart = Math.max(startMin, MINI_START);
        const clampEnd   = Math.min(endMin,   MINI_END);
        if (clampStart >= clampEnd) return;
        const topPct    = ((clampStart - MINI_START) / MINI_RANGE) * 100;
        const heightPct = ((clampEnd - clampStart)   / MINI_RANGE) * 100;
        const color     = block.category ? CATEGORY_COLORS[block.category] || CATEGORY_COLORS.other : '#3498db';
        const blockEl   = document.createElement('div');
        blockEl.style.cssText = `position:absolute;left:2px;right:2px;top:${topPct}%;height:${heightPct}%;min-height:2px;background:${hexToRgba(color, 0.55)};border:1px solid ${color};border-radius:2px;`;
        const catText   = block.category ? ` ${CATEGORY_LABELS[block.category] || 'Other'}` : '';
        blockEl.title   = `${block.startTime} – ${block.endTime}${catText}` + (block.label ? `: ${block.label}` : '');
        blockArea.appendChild(blockEl);
      });

      col.appendChild(blockArea);
      wrapper.appendChild(col);
    });
    container.appendChild(wrapper);
  }

  function renderScheduleBreakdown(availability) {
    const el = document.getElementById('detailed-schedule-breakdown');
    const hasCategories = (availability || []).some(b => b.category);
    if (!hasCategories) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML = DAYS.map((day, i) => {
      const blocks = (availability || [])
        .filter(b => b.day === day)
        .sort((a, b) => timeStringToMinutes(a.startTime) - timeStringToMinutes(b.startTime));
      if (blocks.length === 0) return '';
      const lineItems = blocks.map(b => {
        const catLabel = b.category ? (CATEGORY_LABELS[b.category] || 'Other') : 'Available';
        const note     = b.label ? ` (${escapeHtml(b.label)})` : '';
        return `${b.startTime} - ${b.endTime} <strong>${escapeHtml(catLabel)}</strong>${note}`;
      }).join('<br>');
      return `<div class="mb-1"><span class="text-muted">${DAYS_SHORT[i]}:</span> ${lineItems}</div>`;
    }).join('');
  }

  function populateDancerDetails(dancer) {
    document.getElementById('detail-email').textContent     = dancer.email             || '';
    document.getElementById('detail-phone').textContent     = dancer.phone             || '';
    document.getElementById('detail-address').textContent   = dancer.address           || '';
    document.getElementById('detail-grade').textContent     = dancer.grade             || '';
    document.getElementById('detail-technique').textContent = dancer.technique_classes || '';
    document.getElementById('detail-injuries').textContent  = dancer.injuries          || '';
    document.getElementById('detail-absences').textContent  = dancer.absences          || '';
  }

  // ── Grid (lazily built on first open) ─────────────────────────────────────

  function initGrid() {
    if (_gridReady) return;
    _gridReady = true;

    const timeColumn = document.getElementById('time-column');
    const gridEl     = document.getElementById('grid');
    const headerRow  = document.getElementById('day-header-row');
    const legendEl   = document.getElementById('pieces-legend');

    headerRow.appendChild(document.createElement('div'));
    DAYS.forEach(day => {
      const h = document.createElement('div');
      h.className = 'day-header';
      h.textContent = day;
      headerRow.appendChild(h);
    });

    for (let h = startHour; h <= endHour; h++) {
      const label = document.createElement('div');
      label.className = 'time-label';
      label.textContent = formatTime(h, 0);
      timeColumn.appendChild(label);
    }

    const totalSlots = ((endHour + 1 - startHour) * 60) / increment;
    DAYS.forEach(() => {
      const col = document.createElement('div');
      col.className = 'day-column';
      for (let i = 0; i < totalSlots; i++) {
        const slot = document.createElement('div');
        slot.className = 'time-slot' + (i % 4 === 3 ? ' hour-line' : '');
        slot.dataset.timeIndex = i;
        col.appendChild(slot);
      }
      gridEl.appendChild(col);
    });

    // Legend
    legendEl.innerHTML = _pieces.length === 0
      ? '<p class="text-muted" style="font-size:12px;">No pieces yet.</p>'
      : '';
    _pieces.forEach(p => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      item.innerHTML = `<div style="width:14px;height:14px;border-radius:3px;background:${p.color};flex-shrink:0;"></div>
        <span style="font-size:13px;">${escapeHtml(p.name)}</span>`;
      legendEl.appendChild(item);
    });

    // Blocks (clicking selects that piece in the analyzer)
    requestAnimationFrame(() => {
      _allBlocks.forEach(b => {
        const piece    = _pieces.find(p => p.id === b.piece_id);
        if (!piece) return;
        const topPx    = timeStringToTopPx(b.start_time);
        const btmPx    = timeStringToTopPx(b.end_time);
        const dayIndex = DAYS.indexOf(b.day);
        renderBlock(piece, topPx, btmPx - topPx, dayIndex, b.start_time, b.end_time);
      });
      repositionBlocks();
    });
  }

  function renderBlock(piece, topPx, heightPx, dayIndex, startTime, endTime) {
    const gridEl   = document.getElementById('grid');
    const dayWidth = gridEl.clientWidth / 7;
    const block    = document.createElement('div');
    block.className           = 'block readonly-block';
    block.dataset.pieceId     = piece.id;
    block.dataset.pieceName   = piece.name;
    block.dataset.dayIndex    = String(dayIndex);
    block.dataset.startTime   = startTime;
    block.dataset.endTime     = endTime;
    block.style.top           = `${topPx}px`;
    block.style.height        = `${Math.max(heightPx, slotHeight)}px`;
    block.style.left          = `${dayIndex * dayWidth}px`;
    block.style.width         = `${dayWidth}px`;
    block.style.background    = hexToRgba(piece.color, 0.65);
    block.style.border        = `2px solid ${piece.color}`;
    block.style.position      = 'absolute';
    block.style.boxSizing     = 'border-box';
    block.style.color         = '#000';
    block.innerHTML = `
      <span style="font-size:11px;font-weight:bold;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${escapeHtml(piece.name)}</span>
      <span style="font-size:10px;display:block;opacity:0.8;">${startTime} – ${endTime}</span>`;

    block.addEventListener('click', () => {
      const sel = document.getElementById('piece-select');
      sel.value = String(piece.id);
      selectPiece(String(piece.id));
      document.getElementById('analysis-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    gridEl.appendChild(block);
  }

  function repositionBlocks() {
    const gridEl   = document.getElementById('grid');
    const dayWidth = gridEl.clientWidth / 7;
    DAYS.forEach((day, di) => {
      const els = Array.from(document.querySelectorAll('.readonly-block'))
        .filter(el => el.dataset.dayIndex === String(di));
      if (els.length === 0) return;

      const blocks = els.map(el => ({
        el,
        start: timeStringToMinutes(el.dataset.startTime),
        end:   timeStringToMinutes(el.dataset.endTime),
        lane:  0,
      })).sort((a, b) => a.start - b.start);

      const laneEnds = [];
      blocks.forEach(b => {
        let lane = laneEnds.findIndex(e => e <= b.start);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(b.end); }
        else laneEnds[lane] = b.end;
        b.lane = lane;
      });

      const laneCount = laneEnds.length;
      const laneW     = dayWidth / laneCount;
      blocks.forEach(b => {
        b.el.style.left  = `${di * dayWidth + b.lane * laneW}px`;
        b.el.style.width = `${laneW}px`;
      });
    });
  }

  // ── Toggle grid ────────────────────────────────────────────────────────────

  document.getElementById('toggle-grid-btn').addEventListener('click', () => {
    const gridSection = document.getElementById('grid-section');
    const btn         = document.getElementById('toggle-grid-btn');
    const isOpen      = gridSection.style.display !== 'none';
    if (!isOpen) {
      gridSection.style.display = '';
      btn.innerHTML = '&#9662; Full schedule grid';
      initGrid();
    } else {
      gridSection.style.display = 'none';
      btn.innerHTML = '&#9656; Full schedule grid';
    }
  });

  // ── Page init ──────────────────────────────────────────────────────────────

  try {
    const [piecesRes, blocksRes] = await Promise.all([
      fetch('/api/pieces'),
      fetch('/api/master-blocks'),
    ]);

    if (!piecesRes.ok) {
      document.getElementById('no-pieces-msg').classList.remove('d-none');
      document.getElementById('piece-selector-bar').style.display = 'none';
      return;
    }

    _pieces    = await piecesRes.json();
    _allBlocks = blocksRes.ok ? await blocksRes.json() : [];

    if (_pieces.length === 0) {
      document.getElementById('no-pieces-msg').classList.remove('d-none');
      document.getElementById('piece-selector-bar').style.display = 'none';
      return;
    }

    initPieceSelector(_pieces);

  } catch (err) {
    console.error(err);
    document.getElementById('no-pieces-msg').classList.remove('d-none');
    document.getElementById('piece-selector-bar').style.display = 'none';
  }

});
