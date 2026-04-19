document.addEventListener('DOMContentLoaded', () => {
  const DAYS       = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MINI_START = 8 * 60;
  const MINI_END   = 23 * 60;
  const MINI_RANGE = MINI_END - MINI_START;

  // Auto-assigned colors for new pieces
  const PALETTE = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7'];

  // ── State ─────────────────────────────────────────────────────────────────────
  let selectedDancers    = []; // { id (profile id), user_id, first_name, last_name, availability }
  let pieces             = []; // pieces in this season (kept in sync as new ones are created)
  let currentCommonSlots = []; // [{ day, start (minutes), end (minutes) }]

  // ── DOM ───────────────────────────────────────────────────────────────────────
  const searchInput  = document.getElementById('dancer-search');
  const dropdown     = document.getElementById('search-dropdown');
  const castList     = document.getElementById('cast-list');
  const castEmptyMsg = document.getElementById('cast-empty-msg');
  const castCount    = document.getElementById('cast-count');
  const summary      = document.getElementById('cast-summary');
  const placeholder  = document.getElementById('common-placeholder');
  const results      = document.getElementById('common-results');
  const commonList   = document.getElementById('common-list');
  const noCommon     = document.getElementById('no-common');
  const actionPanel  = document.getElementById('action-panel');
  const addSchedBtn  = document.getElementById('add-to-schedule-btn');

  // ── Time helpers ──────────────────────────────────────────────────────────────

  function timeToMinutes(timeStr) {
    const [time, ampm] = timeStr.trim().split(' ');
    const [h, m]       = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }

  function minutesToTimeString(min) {
    const h    = Math.floor(min / 60);
    const m    = min % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr   = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  // minutes → "HH:MM" for <input type="time">
  function minutesToHH24(min) {
    return `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`;
  }

  // "HH:MM" → app time string "H:MM AM/PM"
  function hh24ToTimeString(val) {
    const [h, m] = val.split(':').map(Number);
    return minutesToTimeString(h * 60 + m);
  }

  // ── Pieces ────────────────────────────────────────────────────────────────────

  async function loadPieces() {
    try {
      const res = await fetch('/api/pieces');
      pieces = res.ok ? await res.json() : [];
    } catch (e) { pieces = []; }
  }

  function populatePieceSelect() {
    const sel = document.getElementById('piece-select');
    sel.innerHTML = '';
    pieces.forEach(p => {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    // Always add "Create new piece..." at the bottom
    const newOpt = document.createElement('option');
    newOpt.value       = '__new__';
    newOpt.textContent = '+ Create new piece…';
    sel.appendChild(newOpt);
    // Default: first piece if any, else __new__
    sel.value = pieces.length > 0 ? pieces[0].id : '__new__';
    toggleNewPieceInput(sel.value);
  }

  function toggleNewPieceInput(val) {
    const wrapper = document.getElementById('new-piece-wrapper');
    if (val === '__new__') {
      wrapper.classList.remove('d-none');
    } else {
      wrapper.classList.add('d-none');
      document.getElementById('piece-name-input').value = '';
    }
  }

  document.getElementById('piece-select').addEventListener('change', function () {
    toggleNewPieceInput(this.value);
  });

  // ── Search ────────────────────────────────────────────────────────────────────

  let debounceTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (!q) { hideDropdown(); return; }
    debounceTimer = setTimeout(() => fetchDancers(q), 300);
  });

  searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); });
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrapper')) hideDropdown(); });

  async function fetchDancers(q) {
    try {
      const res      = await fetch(`/api/dancers/search?q=${encodeURIComponent(q)}`);
      const dancers  = await res.json();
      const filtered = dancers.filter(d => !selectedDancers.find(s => s.id === d.id));

      dropdown.innerHTML = '';
      if (filtered.length === 0) {
        dropdown.innerHTML = '<div class="dropdown-item-dancer text-muted">No results found.</div>';
      } else {
        filtered.forEach(dancer => {
          const item       = document.createElement('div');
          item.className   = 'dropdown-item-dancer';
          item.textContent = `${dancer.first_name} ${dancer.last_name}`;
          item.addEventListener('click', () => addDancer(dancer));
          dropdown.appendChild(item);
        });
      }
      dropdown.style.display = 'block';
    } catch (err) { console.error(err); }
  }

  function hideDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML     = '';
  }

  // ── Cast list ─────────────────────────────────────────────────────────────────

  function addDancer(dancer) {
    if (selectedDancers.find(d => d.id === dancer.id)) return;
    selectedDancers.push(dancer);
    searchInput.value = '';
    hideDropdown();
    renderCast();
    computeCommonAvailability();
  }

  function removeDancer(id) {
    selectedDancers = selectedDancers.filter(d => d.id !== id);
    renderCast();
    computeCommonAvailability();
  }

  function renderCast() {
    Array.from(castList.children).forEach(c => { if (c !== castEmptyMsg) c.remove(); });
    castCount.textContent = `${selectedDancers.length} selected`;

    if (selectedDancers.length === 0) { castEmptyMsg.style.display = 'block'; return; }
    castEmptyMsg.style.display = 'none';

    selectedDancers.forEach(dancer => {
      const chip = document.createElement('div');
      chip.className = 'cast-chip';

      const nameBtn = document.createElement('span');
      nameBtn.textContent   = `${dancer.first_name} ${dancer.last_name}`;
      nameBtn.style.cssText = 'cursor:pointer;text-decoration:underline;color:#0d6efd;flex:1;';
      nameBtn.title         = 'Click to view schedule';
      nameBtn.addEventListener('click', () => openDancerModal(dancer.user_id));

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.title       = 'Remove';
      removeBtn.addEventListener('click', () => removeDancer(dancer.id));

      chip.appendChild(nameBtn);
      chip.appendChild(removeBtn);
      castList.appendChild(chip);
    });
  }

  // ── Dancer profile modal ──────────────────────────────────────────────────────

  async function openDancerModal(userId) {
    try {
      const res    = await fetch(`/api/dancers/${userId}`);
      const dancer = await res.json();
      document.getElementById('dancer-modal-name').textContent = `${dancer.first_name} ${dancer.last_name}`;
      renderMiniSchedule(dancer.availability || []);
      populateDancerDetails(dancer);
      document.getElementById('dancer-full-profile').classList.remove('show');
      new bootstrap.Modal(document.getElementById('dancerModal')).show();
    } catch (err) { console.error(err); alert('Could not load dancer profile.'); }
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
      const area = document.createElement('div');
      area.style.cssText = 'position:absolute;top:18px;left:0;right:0;bottom:0;';
      availability.filter(b => b.day === day).forEach(block => {
        const s = timeToMinutes(block.startTime), e = timeToMinutes(block.endTime);
        const cs = Math.max(s, MINI_START), ce = Math.min(e, MINI_END);
        if (cs >= ce) return;
        const el = document.createElement('div');
        el.style.cssText = `position:absolute;left:2px;right:2px;top:${((cs-MINI_START)/MINI_RANGE)*100}%;height:${((ce-cs)/MINI_RANGE)*100}%;min-height:2px;background:rgba(52,152,219,0.55);border:1px solid #3498db;border-radius:2px;`;
        el.title = `${block.startTime} – ${block.endTime}`;
        area.appendChild(el);
      });
      col.appendChild(area);
      wrapper.appendChild(col);
    });
    container.appendChild(wrapper);
  }

  function populateDancerDetails(d) {
    document.getElementById('detail-email').textContent     = d.email             || '—';
    document.getElementById('detail-phone').textContent     = d.phone             || '—';
    document.getElementById('detail-address').textContent   = d.address           || '—';
    document.getElementById('detail-grade').textContent     = d.grade             || '—';
    document.getElementById('detail-technique').textContent = d.technique_classes || '—';
    document.getElementById('detail-injuries').textContent  = d.injuries          || '—';
    document.getElementById('detail-absences').textContent  = d.absences          || '—';
  }

  // ── Common availability ───────────────────────────────────────────────────────

  function getDayIntervals(dancer, day) {
    return (dancer.availability || [])
      .filter(b => b.day === day)
      .map(b => ({ start: timeToMinutes(b.startTime), end: timeToMinutes(b.endTime) }));
  }

  function intersectIntervals(listA, listB) {
    const result = [];
    for (const a of listA) {
      for (const b of listB) {
        const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
        if (s < e) result.push({ start: s, end: e });
      }
    }
    return result;
  }

  function computeCommonAvailability() {
    currentCommonSlots = [];

    if (selectedDancers.length < 2) {
      placeholder.style.display = 'block';
      results.style.display     = 'none';
      updateActionPanel();
      return;
    }

    placeholder.style.display = 'none';
    results.style.display     = 'block';
    commonList.innerHTML      = '';
    noCommon.style.display    = 'none';

    let foundAny = false;
    DAYS.forEach(day => {
      let common = getDayIntervals(selectedDancers[0], day);
      for (let i = 1; i < selectedDancers.length; i++) {
        common = intersectIntervals(common, getDayIntervals(selectedDancers[i], day));
        if (common.length === 0) break;
      }
      if (common.length === 0) return;
      foundAny = true;

      common.forEach(iv => currentCommonSlots.push({ day, start: iv.start, end: iv.end }));

      const dayEl = document.createElement('div');
      dayEl.className = 'common-day';
      dayEl.innerHTML = `<h6>${day}</h6>`;
      common.forEach(iv => {
        const badge       = document.createElement('span');
        badge.className   = 'time-window';
        badge.textContent = `${minutesToTimeString(iv.start)} – ${minutesToTimeString(iv.end)}`;
        dayEl.appendChild(badge);
      });
      commonList.appendChild(dayEl);
    });

    if (!foundAny) noCommon.style.display = 'block';
    updateActionPanel();
  }

  // ── Action panel + summary sentence ──────────────────────────────────────────

  function updateActionPanel() {
    const n = selectedDancers.length;
    const s = currentCommonSlots.length;

    if (n === 0) {
      summary.textContent       = '';
      actionPanel.style.display = 'none';
    } else if (n === 1) {
      summary.textContent       = '1 dancer selected — add a second to see shared availability';
      actionPanel.style.display = 'none';
    } else {
      summary.textContent = s > 0
        ? `${n} dancers selected — ${s} shared window${s === 1 ? '' : 's'}`
        : `${n} dancers selected — no shared availability`;
      actionPanel.style.display = s > 0 ? 'block' : 'none';
    }
  }

  // ── Add Rehearsal to Schedule ─────────────────────────────────────────────────

  addSchedBtn.addEventListener('click', async () => {
    document.getElementById('sched-error').classList.add('d-none');
    document.getElementById('sched-success').classList.add('d-none');

    // Refresh pieces list then rebuild the piece dropdown
    await loadPieces();
    populatePieceSelect();

    // Populate slot dropdown — one option per shared interval
    const slotEl = document.getElementById('slot-select');
    slotEl.innerHTML = currentCommonSlots.map(s =>
      `<option value="${s.day}|||${s.start}|||${s.end}">` +
      `${s.day} — available ${minutesToTimeString(s.start)} – ${minutesToTimeString(s.end)}` +
      `</option>`
    ).join('');

    // Pre-fill time inputs from the first slot
    if (currentCommonSlots.length > 0) applySlot(currentCommonSlots[0]);

    new bootstrap.Modal(document.getElementById('addToScheduleModal')).show();
  });

  // When the day dropdown changes, update hint + pre-fill times
  document.getElementById('slot-select').addEventListener('change', function () {
    const [day, startStr, endStr] = this.value.split('|||');
    applySlot({ day, start: parseInt(startStr), end: parseInt(endStr) });
  });

  function applySlot(slot) {
    document.getElementById('sched-start-time').value = minutesToHH24(slot.start);
    document.getElementById('sched-end-time').value   = minutesToHH24(slot.end);
    document.getElementById('day-window-hint').textContent =
      `Available window: ${minutesToTimeString(slot.start)} – ${minutesToTimeString(slot.end)}`;
  }

  document.getElementById('confirm-sched-btn').addEventListener('click', async () => {
    const pieceSelectVal = document.getElementById('piece-select').value;
    const slotVal        = document.getElementById('slot-select').value;
    const startVal       = document.getElementById('sched-start-time').value;
    const endVal         = document.getElementById('sched-end-time').value;
    const errorEl        = document.getElementById('sched-error');
    const successEl      = document.getElementById('sched-success');
    const btn            = document.getElementById('confirm-sched-btn');

    errorEl.classList.add('d-none');
    successEl.classList.add('d-none');

    // Validate new piece name if creating
    if (pieceSelectVal === '__new__') {
      const newName = document.getElementById('piece-name-input').value.trim();
      if (!newName) {
        errorEl.textContent = 'Please enter a name for the new piece.';
        errorEl.classList.remove('d-none');
        return;
      }
    }

    if (!startVal || !endVal) {
      errorEl.textContent = 'Please enter a rehearsal start and end time.';
      errorEl.classList.remove('d-none');
      return;
    }
    const [sh, sm] = startVal.split(':').map(Number);
    const [eh, em] = endVal.split(':').map(Number);
    if (sh * 60 + sm >= eh * 60 + em) {
      errorEl.textContent = 'Start time must be before end time.';
      errorEl.classList.remove('d-none');
      return;
    }

    const [day]     = slotVal.split('|||');
    const startTime = hh24ToTimeString(startVal);
    const endTime   = hh24ToTimeString(endVal);

    btn.disabled    = true;
    btn.textContent = 'Saving…';

    try {
      let pieceId, pieceName;

      if (pieceSelectVal === '__new__') {
        // Create a new piece
        pieceName       = document.getElementById('piece-name-input').value.trim();
        const color     = PALETTE[pieces.length % PALETTE.length];
        const pieceRes  = await fetch('/api/pieces', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ name: pieceName, color }),
        });
        if (!pieceRes.ok) {
          const data = await pieceRes.json();
          throw new Error(data.error || 'Failed to create piece.');
        }
        const piece = await pieceRes.json();
        pieces.push(piece);
        pieceId = piece.id;
      } else {
        // Use existing piece
        pieceId   = parseInt(pieceSelectVal);
        pieceName = pieces.find(p => p.id === pieceId)?.name || 'Piece';
      }

      // Add the rehearsal block
      const blockRes = await fetch('/api/master-blocks', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ piece_id: pieceId, day, start_time: startTime, end_time: endTime }),
      });

      if (!blockRes.ok) {
        const data = await blockRes.json();
        throw new Error(data.error || 'Failed to add block.');
      }

      successEl.textContent = `✓ "${pieceName}" — ${day} ${startTime} – ${endTime} added to the Master Schedule`;
      successEl.classList.remove('d-none');
      document.getElementById('piece-name-input').value = '';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('d-none');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Add to Schedule';
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────────

  loadPieces();
});
