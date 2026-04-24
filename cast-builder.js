document.addEventListener('DOMContentLoaded', () => {
  const DAYS       = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MINI_START = 8 * 60;
  const MINI_END   = 23 * 60;
  const MINI_RANGE = MINI_END - MINI_START;

  // Auto-assigned colors for new pieces
  const PALETTE = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7'];

  // ── State ─────────────────────────────────────────────────────────────────────
  let selectedDancers    = [];
  let pieces             = [];
  let currentCommonSlots = [];
  let masterBlocks       = [];
  let roomCount          = 1;
  let viewMode           = 'all'; // 'all' | 'open'

  // ── DOM ───────────────────────────────────────────────────────────────────────
  const searchInput  = document.getElementById('dancer-search');
  const dropdown     = document.getElementById('search-dropdown');
  const castList     = document.getElementById('cast-list');
  const castEmptyMsg = document.getElementById('cast-empty-msg');
  const castCount    = document.getElementById('cast-count');
  const summary      = document.getElementById('cast-summary');
  const placeholder  = document.getElementById('common-placeholder');
  const results      = document.getElementById('common-results');
  const noCommon     = document.getElementById('no-common');
  const actionPanel  = document.getElementById('action-panel');
  const addSchedBtn  = document.getElementById('add-to-schedule-btn');

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

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

  async function loadMasterBlocks() {
    try {
      const res = await fetch('/api/master-blocks');
      masterBlocks = res.ok ? await res.json() : [];
    } catch (e) { masterBlocks = []; }
  }

  async function loadRoomCount() {
    try {
      const res = await fetch('/api/season/room-count');
      if (res.ok) { const d = await res.json(); roomCount = d.room_count || 1; }
    } catch (e) { roomCount = 1; }
  }

  async function checkOverlap() {
    const slotVal   = document.getElementById('slot-select').value;
    const startVal  = document.getElementById('sched-start-time').value;
    const endVal    = document.getElementById('sched-end-time').value;
    const warningEl = document.getElementById('overlap-warning');
    const dancerEl  = document.getElementById('dancer-conflict-warning');

    warningEl.classList.add('d-none');
    if (dancerEl) dancerEl.classList.add('d-none');
    if (!slotVal || !startVal || !endVal) return;

    const [day]    = slotVal.split('|||');
    const [sh, sm] = startVal.split(':').map(Number);
    const [eh, em] = endVal.split(':').map(Number);
    const newStart = sh * 60 + sm;
    const newEnd   = eh * 60 + em;
    if (newStart >= newEnd) return;

    // Room schedule overlap (existing master blocks)
    const conflicts = masterBlocks.filter(b => {
      if (b.day !== day) return false;
      const bs = timeToMinutes(b.start_time);
      const be = timeToMinutes(b.end_time);
      return newStart < be && newEnd > bs;
    });

    if (conflicts.length > 0) {
      const names = conflicts.map(b => {
        const piece = pieces.find(p => p.id === b.piece_id);
        return `${piece ? piece.name : 'another piece'} (${b.start_time} – ${b.end_time})`;
      }).join(', ');
      warningEl.textContent = `Heads up: this overlaps with ${names} on the master schedule.`;
      warningEl.classList.remove('d-none');
    }

    // Dancer double-booking check (against piece_casts in the DB)
    if (dancerEl && selectedDancers.length > 0) {
      try {
        const userIds   = selectedDancers.map(d => d.user_id).join(',');
        const startTime = hh24ToTimeString(startVal);
        const endTime   = hh24ToTimeString(endVal);
        const params    = new URLSearchParams({ day, start_time: startTime, end_time: endTime, user_ids: userIds });
        const res       = await fetch(`/api/conflicts/dancers?${params}`);
        if (res.ok) {
          const doubleBooked = await res.json();
          if (doubleBooked.length > 0) {
            const names = doubleBooked.map(c => `${c.first_name} ${c.last_name} (in "${c.piece_name}")`).join(', ');
            dancerEl.textContent = `Double-booked: ${names} already has a rehearsal at this time.`;
            dancerEl.classList.remove('d-none');
          }
        }
      } catch (e) { console.error('Dancer conflict check failed:', e); }
    }
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
          const item     = document.createElement('div');
          item.className = 'dropdown-item-dancer';
          item.innerHTML = `${dancer.first_name} ${dancer.last_name}`
            + (dancer.audition_number
                ? ` <span style="color:#999;font-size:12px;">#${dancer.audition_number}</span>`
                : '');
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

  const GRID_START  = 8 * 60;
  const GRID_END    = 23 * 60;
  const GRID_RANGE  = GRID_END - GRID_START;  // 900 min = 15 hrs
  const GRID_H      = 512;                    // 32px per hour × 16 labels
  const PX_PER_MIN  = GRID_H / GRID_RANGE;

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

  // Subtract time spans where all rooms are occupied from the available intervals
  function openRoomIntervals(availIntervals, dayBlocks) {
    if (!dayBlocks.length || roomCount <= 0) return availIntervals;

    const events = [];
    dayBlocks.forEach(b => {
      events.push({ t: timeToMinutes(b.start_time), d: +1 });
      events.push({ t: timeToMinutes(b.end_time),   d: -1 });
    });
    events.sort((a, b) => a.t !== b.t ? a.t - b.t : a.d - b.d); // ends before starts at same t

    const blocked = [];
    let count = 0, blockStart = null;
    for (const ev of events) {
      count += ev.d;
      if (count >= roomCount && blockStart === null) blockStart = ev.t;
      if (count < roomCount  && blockStart !== null) { blocked.push({ start: blockStart, end: ev.t }); blockStart = null; }
    }

    let result = availIntervals.slice();
    for (const bp of blocked) {
      result = result.flatMap(iv => {
        if (bp.end <= iv.start || bp.start >= iv.end) return [iv];
        const parts = [];
        if (bp.start > iv.start) parts.push({ start: iv.start, end: bp.start });
        if (bp.end   < iv.end)   parts.push({ start: bp.end,   end: iv.end   });
        return parts;
      });
    }
    return result;
  }

  // Build the static skeleton (headers + time labels) once
  function buildGridSkeleton() {
    const headers = document.getElementById('avail-day-headers');
    const timeCol = document.getElementById('avail-time-col');
    if (headers.childElementCount > 0) return;

    const corner = document.createElement('div');
    corner.style.cssText = 'height:24px;';
    headers.appendChild(corner);
    DAYS.forEach(day => {
      const h = document.createElement('div');
      h.style.cssText = 'text-align:center;font-size:11px;font-weight:600;color:#555;padding:4px 0;border-left:1px solid #ddd;';
      h.textContent = day.slice(0, 3);
      headers.appendChild(h);
    });

    for (let h = 8; h <= 23; h++) {
      const label = document.createElement('div');
      const ampm  = h >= 12 ? 'PM' : 'AM';
      const hr    = h % 12 === 0 ? 12 : h % 12;
      label.style.cssText = 'height:32px;font-size:9px;color:#888;text-align:right;padding-right:4px;padding-top:2px;border-bottom:1px solid #f0f0f0;box-sizing:border-box;';
      label.textContent = `${hr}${ampm}`;
      timeCol.appendChild(label);
    }
  }

  function renderAvailGrid(allByDay, openByDay) {
    buildGridSkeleton();
    const grid = document.getElementById('avail-grid');
    grid.innerHTML = '';
    const activeByDay = viewMode === 'open' ? openByDay : allByDay;

    DAYS.forEach((day, di) => {
      const col = document.createElement('div');
      col.style.cssText = `position:relative;border-left:${di > 0 ? '1px solid #eee' : 'none'};`;

      for (let h = 0; h < 16; h++) {
        const line = document.createElement('div');
        line.style.cssText = 'height:32px;border-bottom:1px solid #f0f0f0;box-sizing:border-box;';
        col.appendChild(line);
      }

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;inset:0;';

      // Green: active common availability (based on view mode)
      (activeByDay[day] || []).forEach(iv => {
        const s = Math.max(iv.start, GRID_START), e = Math.min(iv.end, GRID_END);
        if (s >= e) return;
        const el = document.createElement('div');
        el.style.cssText = `position:absolute;left:1px;right:1px;top:${(s-GRID_START)*PX_PER_MIN}px;height:${(e-s)*PX_PER_MIN}px;background:rgba(34,197,94,.28);border:1px solid rgba(34,197,94,.75);border-radius:2px;box-sizing:border-box;`;
        el.title = `${minutesToTimeString(iv.start)} – ${minutesToTimeString(iv.end)}`;
        overlay.appendChild(el);
      });

      // In "all" mode, also show grey where rooms are full (so director can see the distinction)
      if (viewMode === 'all') {
        const allSlots  = allByDay[day]  || [];
        const openSlots = openByDay[day] || [];
        // Blocked = allSlots minus openSlots
        const blockedSlots = allSlots.flatMap(iv => {
          let remaining = [iv];
          for (const op of openSlots) {
            remaining = remaining.flatMap(r => {
              if (op.end <= r.start || op.start >= r.end) return [r];
              const parts = [];
              if (op.start > r.start) parts.push({ start: r.start, end: op.start });
              if (op.end   < r.end)   parts.push({ start: op.end,   end: r.end   });
              return parts;
            });
          }
          return remaining;
        });
        blockedSlots.forEach(iv => {
          const s = Math.max(iv.start, GRID_START), e = Math.min(iv.end, GRID_END);
          if (s >= e) return;
          const el = document.createElement('div');
          el.style.cssText = `position:absolute;left:1px;right:1px;top:${(s-GRID_START)*PX_PER_MIN}px;height:${(e-s)*PX_PER_MIN}px;background:rgba(234,179,8,.18);border:1px solid rgba(234,179,8,.5);border-radius:2px;box-sizing:border-box;`;
          el.title = `Rooms full: ${minutesToTimeString(iv.start)} – ${minutesToTimeString(iv.end)}`;
          overlay.appendChild(el);
        });
      }

      // Piece blocks from master schedule — lane-split overlapping blocks (gray, distinct from green)
      const dayMasterBlocks = masterBlocks.filter(b => b.day === day);
      if (dayMasterBlocks.length > 0) {
        // Sweep-line lane assignment
        const sorted = [...dayMasterBlocks].sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
        const laneEnds = [];
        sorted.forEach(b => {
          let lane = laneEnds.findIndex(e => e <= timeToMinutes(b.start_time));
          if (lane === -1) { lane = laneEnds.length; laneEnds.push(timeToMinutes(b.end_time)); }
          else laneEnds[lane] = timeToMinutes(b.end_time);
          b._lane = lane;
        });
        const totalLanes = laneEnds.length;

        sorted.forEach(b => {
          const s = Math.max(timeToMinutes(b.start_time), GRID_START);
          const e = Math.min(timeToMinutes(b.end_time),   GRID_END);
          if (s >= e) return;
          const ht    = (e - s) * PX_PER_MIN;
          const piece = pieces.find(p => p.id === b.piece_id);
          const laneW = 100 / totalLanes;
          const el    = document.createElement('div');
          el.style.cssText = `position:absolute;left:${b._lane * laneW}%;width:${laneW}%;top:${(s-GRID_START)*PX_PER_MIN}px;height:${ht}px;background:rgba(100,116,139,0.35);border:1.5px solid #94a3b8;border-radius:2px;box-sizing:border-box;overflow:hidden;padding:0 1px;`;
          el.title = `${piece?.name || 'Rehearsal'}: ${b.start_time} – ${b.end_time}`;
          if (ht > 14) {
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size:9px;font-weight:600;color:#374151;padding:1px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            lbl.textContent = piece?.name || '';
            el.appendChild(lbl);
          }
          overlay.appendChild(el);
        });
      }

      col.appendChild(overlay);
      grid.appendChild(col);
    });

    grid.style.height = `${GRID_H}px`;
    document.getElementById('avail-time-col').style.height = `${GRID_H}px`;
  }

  function renderTextList(slots) {
    const wrapper = document.getElementById('avail-text-list-wrapper');
    const list    = document.getElementById('avail-text-list');
    if (!list) return;

    if (!slots.length) {
      if (wrapper) wrapper.style.display = 'none';
      return;
    }

    if (wrapper) wrapper.style.display = 'block';

    const byDay = {};
    slots.forEach(s => { if (!byDay[s.day]) byDay[s.day] = []; byDay[s.day].push(s); });

    list.innerHTML = DAYS.filter(d => byDay[d])
      .map(day => `<div class="mb-1"><span style="font-size:12px;font-weight:600;color:#555;margin-right:6px;">${day}</span>`
        + byDay[day].map(iv =>
            `<span class="time-window">${minutesToTimeString(iv.start)} – ${minutesToTimeString(iv.end)}</span>`
          ).join('')
        + '</div>'
      ).join('');
  }

  function computeCommonAvailability() {
    currentCommonSlots = [];

    if (selectedDancers.length === 0) {
      placeholder.style.display = 'block';
      results.style.display     = 'none';
      updateActionPanel();
      return;
    }

    placeholder.style.display = 'none';
    results.style.display     = 'block';

    const allByDay  = {};
    const openByDay = {};

    DAYS.forEach(day => {
      let common = getDayIntervals(selectedDancers[0], day);
      for (let i = 1; i < selectedDancers.length; i++) {
        common = intersectIntervals(common, getDayIntervals(selectedDancers[i], day));
        if (!common.length) break;
      }
      allByDay[day]  = common;
      openByDay[day] = openRoomIntervals(common, masterBlocks.filter(b => b.day === day));
    });

    const active = viewMode === 'open' ? openByDay : allByDay;
    DAYS.forEach(day => {
      (active[day] || []).forEach(iv => currentCommonSlots.push({ day, start: iv.start, end: iv.end }));
    });

    const foundAny = currentCommonSlots.length > 0;
    noCommon.style.display = (!foundAny && selectedDancers.length >= 2) ? 'block' : 'none';

    renderAvailGrid(allByDay, openByDay);
    renderTextList(currentCommonSlots);
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
    document.getElementById('overlap-warning').classList.add('d-none');

    // Refresh pieces + master blocks, then rebuild the piece dropdown
    await Promise.all([loadPieces(), loadMasterBlocks()]);
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
    checkOverlap();

    new bootstrap.Modal(document.getElementById('addToScheduleModal')).show();
  });

  // When the day dropdown changes, update hint + pre-fill times + check overlap
  document.getElementById('slot-select').addEventListener('change', function () {
    const [day, startStr, endStr] = this.value.split('|||');
    applySlot({ day, start: parseInt(startStr), end: parseInt(endStr) });
    checkOverlap();
  });

  document.getElementById('sched-start-time').addEventListener('input', checkOverlap);
  document.getElementById('sched-end-time').addEventListener('input', checkOverlap);

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
      // Reload blocks and re-render grid to reflect the new rehearsal
      await loadMasterBlocks();
      computeCommonAvailability();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('d-none');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Add to Schedule';
    }
  });

  // ── View toggle ───────────────────────────────────────────────────────────────

  const viewAllBtn  = document.getElementById('view-all-btn');
  const viewOpenBtn = document.getElementById('view-open-btn');
  const viewHint    = document.getElementById('view-mode-hint');

  function setViewMode(mode) {
    viewMode = mode;
    if (mode === 'all') {
      viewAllBtn.classList.replace('btn-outline-dark', 'btn-dark');
      viewOpenBtn.classList.replace('btn-dark', 'btn-outline-dark');
      viewHint.textContent = 'Showing all time windows when dancers are free';
    } else {
      viewOpenBtn.classList.replace('btn-outline-dark', 'btn-dark');
      viewAllBtn.classList.replace('btn-dark', 'btn-outline-dark');
      viewHint.textContent = 'Showing only windows with an open room available';
    }
    computeCommonAvailability();
  }

  viewAllBtn.addEventListener('click',  () => setViewMode('all'));
  viewOpenBtn.addEventListener('click', () => setViewMode('open'));

  // ── Init ──────────────────────────────────────────────────────────────────────

  Promise.all([loadPieces(), loadMasterBlocks(), loadRoomCount()]);
});
