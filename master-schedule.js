document.addEventListener('DOMContentLoaded', async () => {
  // ── Constants ─────────────────────────────────────────────────────────────────
  const startHour  = 8;
  const endHour    = 23;
  const increment  = 15;
  const slotHeight = 12.5;
  const DAYS       = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const COLORS     = [
    '#2ecc71', '#9b59b6', '#3498db', '#e67e22', '#e91e63',
    '#1abc9c', '#e74c3c', '#607d8b', '#f39c12', '#16a085',
  ];

  // ── DOM references ────────────────────────────────────────────────────────────
  const timeColumn = document.getElementById('time-column');
  const grid       = document.getElementById('grid');
  const headerRow  = document.getElementById('day-header-row');
  const legendEl   = document.getElementById('pieces-legend');

  // ── State ─────────────────────────────────────────────────────────────────────
  let pieces        = [];
  let roomCount     = 1;
  let rooms         = []; // named rooms for this season; [] means anonymous-count mode still applies
  let pendingBlock  = null;
  let isSelecting   = false;
  let startSlot     = 0;
  let currentBlock  = null;
  let currentDayCol = null;
  let isResizing    = false;
  let resizeDir     = null;
  let offsetY       = 0;
  let activeBlockId = null;

  // ── Grid initialization ───────────────────────────────────────────────────────

  function formatTime(h, m) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr   = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  headerRow.appendChild(document.createElement('div'));
  DAYS.forEach(day => {
    const h       = document.createElement('div');
    h.className   = 'day-header';
    h.textContent = day;
    headerRow.appendChild(h);
  });

  for (let h = startHour; h <= endHour; h++) {
    const label       = document.createElement('div');
    label.className   = 'time-label';
    label.textContent = formatTime(h, 0);
    timeColumn.appendChild(label);
  }

  const totalSlots = ((endHour + 1 - startHour) * 60) / increment;
  DAYS.forEach(() => {
    const col = document.createElement('div');
    col.className = 'day-column';
    for (let i = 0; i < totalSlots; i++) {
      const slot             = document.createElement('div');
      slot.className         = 'time-slot' + (i % 4 === 3 ? ' hour-line' : '');
      slot.dataset.timeIndex = i;
      col.appendChild(slot);
    }
    grid.appendChild(col);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function slotToTimeString(slotIndex) {
    const totalMin = slotIndex * increment + startHour * 60;
    return formatTime(Math.floor(totalMin / 60), totalMin % 60);
  }

  function timeStringToTopPx(timeStr) {
    const [time, ampm] = timeStr.split(' ');
    const [h, m]       = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return ((hour * 60 + m - startHour * 60) / increment) * slotHeight;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function getBlockPosition(block) {
    const topPx      = parseFloat(block.style.top);
    const heightPx   = parseFloat(block.style.height);
    // Use dataset.day which is kept in sync during drag — avoids parsing % left values
    const dayIndex   = Math.max(0, Math.min(DAYS.indexOf(block.dataset.day), 6));
    const startSlotI = Math.round(topPx / slotHeight);
    const endSlotI   = startSlotI + Math.round(heightPx / slotHeight);
    return {
      day:        DAYS[dayIndex],
      start_time: slotToTimeString(startSlotI),
      end_time:   slotToTimeString(endSlotI),
    };
  }

  function timeStringToMinutes(str) {
    const [time, ampm] = str.trim().split(' ');
    const [h, m]       = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }

  // ── Room count ────────────────────────────────────────────────────────────────

  async function loadRoomCount() {
    try {
      const res = await fetch('/api/season/room-count');
      if (res.ok) {
        const data = await res.json();
        roomCount = data.room_count || 1;
        const input = document.getElementById('room-count-input');
        if (input) input.value = roomCount;
      }
    } catch (e) { console.error('loadRoomCount error:', e); }
  }

  // ── Named rooms ───────────────────────────────────────────────────────────────
  // A season with zero named rooms keeps the plain anonymous-count UI/behavior
  // above untouched. The moment one exists, the sidebar switches to this list
  // editor and conflict detection switches to per-room double-booking (see
  // highlightConflicts). This is a data-driven switch, not a setting.

  function updateRoomModeUI() {
    const hasRooms = rooms.length > 0;
    document.getElementById('room-count-section').style.display = hasRooms ? 'none' : '';
    document.getElementById('named-rooms-section').style.display = hasRooms ? '' : 'none';
    const bannerText = document.getElementById('room-conflict-banner-text');
    if (bannerText) {
      bannerText.textContent = hasRooms
        ? 'Two rehearsals are booked in the same room at an overlapping time.'
        : 'Some pieces overlap more than your available rooms. Red blocks exceed capacity.';
    }
  }

  async function loadRooms() {
    try {
      const res = await fetch('/api/season/rooms');
      if (res.ok) rooms = await res.json();
    } catch (e) { console.error('loadRooms error:', e); }
    renderRoomsList();
    updateRoomModeUI();
  }

  function renderRoomsList() {
    document.getElementById('rooms-list').innerHTML = rooms.map(r => `
      <div class="d-flex align-items-center justify-content-between mb-1" data-room-row="${r.id}">
        <span style="font-size:12.5px;">${r.name}</span>
        <button type="button" class="btn-close" style="font-size:9px;" data-delete-room="${r.id}" aria-label="Delete room"></button>
      </div>`).join('') || '<div class="text-muted" style="font-size:12px;">No rooms yet.</div>';

    document.querySelectorAll('[data-delete-room]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteRoom;
        try {
          const res = await fetch(`/api/season/rooms/${id}`, { method: 'DELETE' });
          if (!res.ok) { const data = await res.json(); alert(data.error || 'Could not delete room.'); return; }
          rooms = rooms.filter(r => String(r.id) !== id);
          renderRoomsList();
          updateRoomModeUI();
          repositionAllBlocks();
        } catch (e) { alert('Could not connect to server.'); }
      });
    });
  }

  // Every <select> that offers a room choice (block-creation modal, move/add-one-time
  // modals) is built from this same list, so they always stay in sync with each other.
  function roomSelectOptionsHTML(selectedId) {
    const noneSelected = selectedId == null || selectedId === '' ? 'selected' : '';
    const opts = [`<option value="" ${noneSelected}>No room assigned</option>`];
    rooms.forEach(r => {
      const sel = String(r.id) === String(selectedId) ? 'selected' : '';
      opts.push(`<option value="${r.id}" ${sel}>${r.name}</option>`);
    });
    return opts.join('');
  }

  document.getElementById('setup-named-rooms-btn').addEventListener('click', () => {
    document.getElementById('room-count-section').style.display = 'none';
    document.getElementById('named-rooms-section').style.display = '';
    document.getElementById('new-room-name-input').focus();
  });

  document.getElementById('add-room-btn').addEventListener('click', async () => {
    const input  = document.getElementById('new-room-name-input');
    const errEl  = document.getElementById('room-add-error');
    const name   = input.value.trim();
    errEl.classList.add('d-none');
    if (!name) return;
    try {
      const res = await fetch('/api/season/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Could not add room.'; errEl.classList.remove('d-none'); return; }
      rooms.push(data);
      input.value = '';
      renderRoomsList();
      updateRoomModeUI();
    } catch (e) { errEl.textContent = 'Could not connect to server.'; errEl.classList.remove('d-none'); }
  });

  // Assign overlapping blocks to side-by-side lanes, flag overflow as conflicts.
  // Uses pixel positioning so values stay exact at whatever width the grid happens to be.
  // For print: the legend uses visibility:hidden (not display:none) so the grid keeps
  // exactly the same pixel width as on screen, making pixel positions still correct.
  function repositionAllBlocks() {
    // Combined sweep-line for master blocks + placeholder blocks — they share column space
    DAYS.forEach((day, di) => {
      const masterEls = Array.from(document.querySelectorAll(`.master-block[data-day="${day}"]`));
      const phEls     = Array.from(document.querySelectorAll(`.placeholder-block[data-day="${day}"]`));
      const allBlocks = [...masterEls, ...phEls].map(el => ({
        el,
        startMin: timeStringToMinutes(el.dataset.startTime),
        endMin:   timeStringToMinutes(el.dataset.endTime),
      }));
      if (!allBlocks.length) return;

      allBlocks.sort((a, b) => a.startMin - b.startMin);
      const laneEnds = [];
      for (const b of allBlocks) {
        let li = laneEnds.findIndex(e => b.startMin >= e);
        if (li === -1) { li = laneEnds.length; laneEnds.push(0); }
        laneEnds[li] = b.endMin;
        b.laneIdx = li;
      }
      for (const b of allBlocks) {
        const concurrent = allBlocks.filter(o => o !== b && o.startMin < b.endMin && o.endMin > b.startMin);
        b.laneCount = Math.max(b.laneIdx + 1, ...concurrent.map(o => o.laneIdx + 1), 1);
      }
      for (const b of allBlocks) {
        b.el.style.left  = `calc(${di} * 100% / 7 + ${b.laneIdx} * 100% / 7 / ${b.laneCount})`;
        b.el.style.width = `calc(100% / 7 / ${b.laneCount})`;
        if (b.el.classList.contains('master-block')) b.el.dataset.laneIdx = b.laneIdx;
      }
    });

    // Org overlay blocks: same sweep-line lane logic as master blocks (independent pool)
    DAYS.forEach((day, di) => {
      const orgDayBlocks = Array.from(document.querySelectorAll(`.org-overlay-block[data-day="${day}"]`))
        .map(el => ({
          el,
          startMin: timeStringToMinutes(el.dataset.startTime),
          endMin:   timeStringToMinutes(el.dataset.endTime),
        }));
      if (!orgDayBlocks.length) return;

      orgDayBlocks.sort((a, b) => a.startMin - b.startMin);
      const orgLaneEnds = [];
      for (const b of orgDayBlocks) {
        let li = orgLaneEnds.findIndex(e => b.startMin >= e);
        if (li === -1) { li = orgLaneEnds.length; orgLaneEnds.push(0); }
        orgLaneEnds[li] = b.endMin;
        b.laneIdx = li;
      }
      for (const b of orgDayBlocks) {
        const concurrent = orgDayBlocks.filter(o => o !== b && o.startMin < b.endMin && o.endMin > b.startMin);
        b.laneCount = Math.max(b.laneIdx + 1, ...concurrent.map(o => o.laneIdx + 1), 1);
      }
      for (const b of orgDayBlocks) {
        b.el.style.left  = `calc(${di} * 100% / 7 + ${b.laneIdx} * 100% / 7 / ${b.laneCount})`;
        b.el.style.width = `calc(100% / 7 / ${b.laneCount})`;
      }
    });

    highlightConflicts();
  }

  // Two modes, switched purely on whether the season has any named room (see
  // updateRoomModeUI): with none, the original anonymous lane-count check (more
  // overlapping things than the room count allows); with rooms, a real per-room
  // double-booking check that doesn't care how many lanes things were rendered into.
  function highlightConflicts() {
    let hasConflict = false;

    if (rooms.length === 0) {
      document.querySelectorAll('.master-block').forEach(b => {
        const laneIdx = parseInt(b.dataset.laneIdx ?? 0);
        const isConflict = laneIdx >= roomCount;
        b.classList.toggle('room-conflict', isConflict);
        b.classList.remove('room-needs-assignment');
        if (isConflict) hasConflict = true;
      });
    } else {
      const allBlocks = Array.from(document.querySelectorAll('.master-block, .placeholder-block')).map(el => ({
        el,
        day:      el.dataset.day,
        startMin: timeStringToMinutes(el.dataset.startTime),
        endMin:   timeStringToMinutes(el.dataset.endTime),
        roomId:   el.dataset.roomId || '',
      }));
      allBlocks.forEach(b => {
        b.el.classList.remove('room-conflict', 'room-needs-assignment');
        if (!b.roomId) { b.el.classList.add('room-needs-assignment'); return; }
        const conflict = allBlocks.some(o => o !== b && o.day === b.day && o.roomId === b.roomId &&
          o.startMin < b.endMin && o.endMin > b.startMin);
        if (conflict) { b.el.classList.add('room-conflict'); hasConflict = true; }
      });
    }

    const banner = document.getElementById('room-conflict-banner');
    if (banner) banner.style.display = hasConflict ? 'block' : 'none';
  }

  // Wire up room-count input
  document.getElementById('room-count-input')?.addEventListener('change', async function () {
    const n = parseInt(this.value);
    if (!n || n < 1) { this.value = roomCount; return; }
    try {
      const res = await fetch('/api/season/room-count', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ room_count: n }),
      });
      if (res.ok) { roomCount = n; repositionAllBlocks(); }
      else this.value = roomCount;
    } catch (e) { console.error(e); this.value = roomCount; }
  });

  // ── Pieces ────────────────────────────────────────────────────────────────────

  async function loadPieces() {
    try {
      const res = await fetch('/api/pieces');
      if (res.ok) pieces = await res.json();
    } catch (e) { console.error(e); }
    renderLegend();
    populatePieceSelect();
  }

  function renderLegend() {
    legendEl.innerHTML = pieces.length === 0
      ? '<p class="text-muted" style="font-size:12px;">No pieces yet.<br>Draw a block to create one.</p>'
      : '';

    pieces.forEach(p => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px;';

      const dot = document.createElement('div');
      dot.style.cssText = `width:14px;height:14px;border-radius:3px;background:${p.color};flex-shrink:0;`;

      const name = document.createElement('span');
      name.style.cssText = 'font-size:13px;flex:1;';
      name.textContent   = p.name;

      const editBtn = document.createElement('button');
      editBtn.className   = 'btn btn-link p-0';
      editBtn.style.cssText = 'font-size:13px;color:#888;line-height:1;text-decoration:none;';
      editBtn.textContent = '✎';
      editBtn.title       = `Rename ${p.name}`;
      editBtn.addEventListener('click', async () => {
        const newName = prompt('Piece name:', p.name);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === p.name) return;
        try {
          const res = await fetch(`/api/pieces/${p.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          });
          if (!res.ok) { alert('Could not rename piece.'); return; }
          p.name = trimmed;
          renderLegend();
          populatePieceSelect();
          document.querySelectorAll(`.master-block[data-piece-id="${p.id}"] span:first-child`).forEach(span => {
            span.textContent = trimmed;
          });
        } catch (err) { alert('Could not connect to server.'); }
      });

      const delBtn = document.createElement('button');
      delBtn.className   = 'btn btn-link p-0';
      delBtn.style.cssText = 'font-size:14px;color:#dc3545;line-height:1;text-decoration:none;';
      delBtn.textContent = '×';
      delBtn.title       = `Delete ${p.name}`;
      delBtn.addEventListener('click', async () => {
        const confirmed = confirm(
          `Are you sure you want to delete "${p.name}"?\n\nThis will permanently remove all of its blocks from the master schedule.`
        );
        if (!confirmed) return;
        try {
          const res = await fetch(`/api/pieces/${p.id}`, { method: 'DELETE' });
          if (!res.ok) { alert('Could not delete piece.'); return; }
          pieces = pieces.filter(piece => piece.id !== p.id);
          document.querySelectorAll(`.master-block[data-piece-id="${p.id}"]`).forEach(b => b.remove());
          renderLegend();
          populatePieceSelect();
          repositionAllBlocks();
        } catch (err) { alert('Could not connect to server.'); }
      });

      item.appendChild(dot);
      item.appendChild(name);
      item.appendChild(editBtn);
      item.appendChild(delBtn);
      legendEl.appendChild(item);
    });
  }

  function populatePieceSelect() {
    const sel     = document.getElementById('existing-piece-select');
    sel.innerHTML = '';
    const hasExisting = pieces.length > 0;
    document.getElementById('radio-existing-piece').disabled = !hasExisting;
    if (!hasExisting) {
      sel.innerHTML = '<option disabled>No pieces yet. Create one first.</option>';
      document.getElementById('radio-new-piece').checked              = true;
      document.getElementById('new-piece-section').style.display      = 'block';
      document.getElementById('existing-piece-section').style.display = 'none';
      return;
    }
    pieces.forEach(p => {
      const opt       = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }

  // ── Block rendering ───────────────────────────────────────────────────────────

  function renderOrgBlock(block) {
    const dayIndex = DAYS.indexOf(block.day);
    if (dayIndex === -1) return;
    const topPx    = timeStringToTopPx(block.start_time);
    const btmPx    = timeStringToTopPx(block.end_time);
    const heightPx = Math.max(btmPx - topPx, slotHeight);

    const el = document.createElement('div');
    el.className        = 'block org-overlay-block';
    el.dataset.day       = block.day;
    el.dataset.startTime = block.start_time;
    el.dataset.endTime   = block.end_time;
    el.style.top         = `${topPx}px`;
    el.style.height     = `${heightPx}px`;
    el.style.left       = `calc(${dayIndex} * 100% / 7)`;
    el.style.width      = `calc(100% / 7)`;
    el.style.background = 'repeating-linear-gradient(135deg,rgba(100,116,139,0.12),rgba(100,116,139,0.12) 5px,rgba(100,116,139,0.22) 5px,rgba(100,116,139,0.22) 10px)';
    el.style.border     = '1px dashed #94a3b8';
    el.style.position   = 'absolute';
    el.style.boxSizing  = 'border-box';
    el.style.zIndex     = '0';
    el.style.pointerEvents = 'none';
    el.innerHTML = `<span style="font-size:10px;color:#64748b;font-weight:600;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:2px 4px;">${block.season_name}: ${block.piece_name}</span>`;
    grid.appendChild(el);
  }

  function renderPlaceholder(dbId, label, topPx, heightPx, dayIndex, startTimeStr, endTimeStr, roomId) {
    const startSlotI = Math.round(topPx / slotHeight);
    const endSlotI   = startSlotI + Math.round(heightPx / slotHeight);
    const block = document.createElement('div');
    block.className         = 'block placeholder-block';
    block.dataset.dbId      = dbId;
    block.dataset.day       = DAYS[dayIndex];
    block.dataset.label     = label;
    block.dataset.startTime = startTimeStr || slotToTimeString(startSlotI);
    block.dataset.endTime   = endTimeStr   || slotToTimeString(endSlotI);
    block.dataset.roomId    = roomId || '';
    block.style.top         = `${topPx}px`;
    block.style.height      = `${Math.max(heightPx, slotHeight)}px`;
    block.style.left        = `calc(${dayIndex} * 100% / 7)`;
    block.style.width       = `calc(100% / 7)`;
    block.style.background  = 'repeating-linear-gradient(45deg,#e8e8e8,#e8e8e8 5px,#d4d4d4 5px,#d4d4d4 10px)';
    block.style.border      = '2px solid #bbb';
    block.style.position    = 'absolute';
    block.style.boxSizing   = 'border-box';
    block.style.color       = '#666';
    block.style.zIndex      = '2';
    block.style.pointerEvents = 'none';  // body passes clicks through to time slots below
    block.innerHTML = `
      <span class="ph-drag-handle" title="Drag to move" style="font-size:11px;font-weight:bold;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:move;pointer-events:auto;">${label}</span>
      <button class="delete-btn" title="Delete">&times;</button>
      <div class="resize-handle resize-top" style="pointer-events:auto;"></div>
      <div class="resize-handle resize-bottom" style="pointer-events:auto;"></div>`;
    block.querySelector('.delete-btn').style.pointerEvents = 'auto';
    block.querySelector('.delete-btn').addEventListener('mousedown', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await fetch(`/api/schedule-placeholders/${dbId}`, { method: 'DELETE' });
      block.remove();
      repositionAllBlocks();
    });
    grid.appendChild(block);
    return block;
  }

  // startTimeStr / endTimeStr are optional — if omitted, computed from pixels
  function renderBlock(dbId, piece, topPx, heightPx, dayIndex, startTimeStr, endTimeStr, roomId) {
    const startSlotI = Math.round(topPx / slotHeight);
    const endSlotI   = startSlotI + Math.round(heightPx / slotHeight);
    const displayStart = startTimeStr || slotToTimeString(startSlotI);
    const displayEnd   = endTimeStr   || slotToTimeString(endSlotI);

    const block = document.createElement('div');
    block.className            = 'block master-block';
    block.dataset.dbId         = dbId;
    block.dataset.pieceId      = piece.id;
    block.dataset.day          = DAYS[dayIndex];
    block.dataset.startTime    = displayStart;
    block.dataset.endTime      = displayEnd;
    block.dataset.roomId       = roomId || '';
    block.style.top            = `${topPx}px`;
    block.style.height         = `${Math.max(heightPx, slotHeight)}px`;
    block.style.left           = `calc(${dayIndex} * 100% / 7)`;
    block.style.width          = `calc(100% / 7)`;
    block.style.background     = hexToRgba(piece.color, 0.65);
    block.style.border         = `2px solid ${piece.color}`;
    block.style.position       = 'absolute';
    block.style.boxSizing      = 'border-box';
    block.style.color          = '#000';
    block.innerHTML = `
      <span style="font-size:11px;font-weight:bold;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${piece.name}</span>
      <span style="font-size:10px;display:block;opacity:0.8;">${displayStart} – ${displayEnd}</span>
      <button class="delete-btn" title="Delete">&times;</button>
      <div class="resize-handle resize-top"></div>
      <div class="resize-handle resize-bottom"></div>`;

    block.querySelector('.delete-btn').addEventListener('mousedown', (e) => {
      e.stopPropagation();   // prevent grid's mousedown from firing drag mode
      e.preventDefault();    // prevent focus shift / text selection
      openDeleteBlockModal(dbId, DAYS[dayIndex], block);
    });

    grid.appendChild(block);
    return block;
  }

  // ── Delete confirmation (whole recurring block, or just one date) ──────────────

  const DAY_OFFSET = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };
  function dateForDayInWeek(mondayStr, dayName) {
    const d = new Date(`${mondayStr}T00:00:00`);
    d.setDate(d.getDate() + DAY_OFFSET[dayName]);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  let pendingDeleteBlock = null;
  const deleteModalEl    = document.getElementById('deleteBlockModal');
  const deleteModalText  = document.getElementById('delete-block-modal-text');
  const deleteChoicesEl  = document.getElementById('delete-block-choices');
  const moveOneDateBtn   = document.getElementById('move-one-date-btn');
  const cancelOneDateBtn = document.getElementById('cancel-one-date-btn');
  const confirmDeleteBtn = document.getElementById('confirm-delete-block-btn');
  const moveDateFormEl   = document.getElementById('move-date-form');
  const moveNewDateInput  = document.getElementById('move-new-date-input');
  const moveNewStartInput = document.getElementById('move-new-start-input');
  const moveNewEndInput   = document.getElementById('move-new-end-input');
  const confirmMoveBtn   = document.getElementById('confirm-move-btn');
  const moveBackBtn      = document.getElementById('move-back-btn');

  function timeStringTo24Hour(str) {
    const mins = timeStringToMinutes(str);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  // window._currentWeekMonday is set by master.html's week navigator only once a
  // production has start/end dates configured. Without it there's no specific calendar
  // date to attach a single-date move/cancellation to, so only the whole-schedule option applies.
  function openDeleteBlockModal(dbId, dayName, blockEl) {
    pendingDeleteBlock = { dbId, dayName, blockEl };
    deleteChoicesEl.classList.remove('d-none');
    moveDateFormEl.classList.add('d-none');
    document.getElementById('room-only-edit-form').classList.add('d-none');
    // Editing the template's room isn't tied to a specific calendar date the way
    // move/cancel are, so it's available whenever the season has named rooms at all,
    // independent of whether production dates are set.
    document.getElementById('change-room-btn').classList.toggle('d-none', rooms.length === 0);
    const weekMonday = window._currentWeekMonday;
    if (weekMonday) {
      const specificDate = dateForDayInWeek(weekMonday, dayName);
      const niceDate = new Date(`${specificDate}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      deleteModalText.textContent = `This rehearsal repeats every ${dayName}. Move or cancel just ${niceDate}, or remove it from the schedule entirely?`;
      moveOneDateBtn.classList.remove('d-none');
      moveOneDateBtn.dataset.date = specificDate;
      cancelOneDateBtn.classList.remove('d-none');
      cancelOneDateBtn.dataset.date = specificDate;
    } else {
      deleteModalText.textContent = `This will remove the ${dayName} rehearsal from every week. Add production dates in Settings to change or cancel a single date instead of the whole series.`;
      moveOneDateBtn.classList.add('d-none');
      cancelOneDateBtn.classList.add('d-none');
    }
    new bootstrap.Modal(deleteModalEl).show();
  }

  moveOneDateBtn.addEventListener('click', () => {
    deleteChoicesEl.classList.add('d-none');
    moveDateFormEl.classList.remove('d-none');
    // Pre-fill with the rehearsal's usual date/time/room as a sensible starting point.
    moveNewDateInput.value  = moveOneDateBtn.dataset.date;
    moveNewStartInput.value = timeStringTo24Hour(pendingDeleteBlock.blockEl.dataset.startTime);
    moveNewEndInput.value   = timeStringTo24Hour(pendingDeleteBlock.blockEl.dataset.endTime);
    document.getElementById('move-room-section').style.display = rooms.length > 0 ? 'block' : 'none';
    document.getElementById('move-room-select').innerHTML = roomSelectOptionsHTML(pendingDeleteBlock.blockEl.dataset.roomId);
  });

  moveBackBtn.addEventListener('click', () => {
    moveDateFormEl.classList.add('d-none');
    deleteChoicesEl.classList.remove('d-none');
  });

  // Change room: edits the recurring template's room directly (PUT, not an exception)
  // -- this changes the room every week, not just for the date currently being viewed.
  document.getElementById('change-room-btn').addEventListener('click', () => {
    deleteChoicesEl.classList.add('d-none');
    document.getElementById('room-only-edit-form').classList.remove('d-none');
    document.getElementById('room-only-select').innerHTML = roomSelectOptionsHTML(pendingDeleteBlock.blockEl.dataset.roomId);
  });

  document.getElementById('room-only-back-btn').addEventListener('click', () => {
    document.getElementById('room-only-edit-form').classList.add('d-none');
    deleteChoicesEl.classList.remove('d-none');
  });

  document.getElementById('confirm-room-only-btn').addEventListener('click', async () => {
    if (!pendingDeleteBlock) return;
    const { dbId, blockEl } = pendingDeleteBlock;
    const roomId = document.getElementById('room-only-select').value || null;
    try {
      const res = await fetch(`/api/master-blocks/${dbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not update the room.');
      } else {
        blockEl.dataset.roomId = roomId || '';
        repositionAllBlocks();
      }
    } catch (e) { alert('Could not connect to server.'); }
    bootstrap.Modal.getInstance(deleteModalEl).hide();
    pendingDeleteBlock = null;
  });

  confirmMoveBtn.addEventListener('click', async () => {
    if (!pendingDeleteBlock) return;
    const { dbId, blockEl } = pendingDeleteBlock;
    const originalDate = moveOneDateBtn.dataset.date;
    const newDate = moveNewDateInput.value;
    if (!newDate || !moveNewStartInput.value || !moveNewEndInput.value) {
      alert('Please fill in the new date, start time, and end time.');
      return;
    }
    const [newStartH, newStartM] = moveNewStartInput.value.split(':').map(Number);
    const [newEndH, newEndM]     = moveNewEndInput.value.split(':').map(Number);
    try {
      const res = await fetch(`/api/master-blocks/${dbId}/exceptions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_date: originalDate, type: 'moved', new_date: newDate,
          new_start_time: formatTime(newStartH, newStartM), new_end_time: formatTime(newEndH, newEndM),
          room_id: document.getElementById('move-room-select').value || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not move this date.');
      } else {
        blockEl.classList.add('block-cancelled-this-week'); // the usual slot doesn't happen this week
        blockEl.title = 'Moved for this week only';
      }
    } catch (e) { alert('Could not connect to server.'); }
    bootstrap.Modal.getInstance(deleteModalEl).hide();
    pendingDeleteBlock = null;
  });

  confirmDeleteBtn.addEventListener('click', async () => {
    if (!pendingDeleteBlock) return;
    const { dbId, blockEl } = pendingDeleteBlock;
    try {
      const res = await fetch(`/api/master-blocks/${dbId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not delete this rehearsal.');
      } else {
        blockEl.remove();
        repositionAllBlocks();
      }
    } catch (e) { alert('Could not connect to server.'); }
    bootstrap.Modal.getInstance(deleteModalEl).hide();
    pendingDeleteBlock = null;
  });

  cancelOneDateBtn.addEventListener('click', async () => {
    if (!pendingDeleteBlock) return;
    const { dbId, blockEl } = pendingDeleteBlock;
    const date = cancelOneDateBtn.dataset.date;
    try {
      const res = await fetch(`/api/master-blocks/${dbId}/exceptions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original_date: date, type: 'cancelled' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not cancel this date.');
      } else {
        blockEl.classList.add('block-cancelled-this-week');
        blockEl.title = 'Cancelled for this week only';
      }
    } catch (e) { alert('Could not connect to server.'); }
    bootstrap.Modal.getInstance(deleteModalEl).hide();
    pendingDeleteBlock = null;
  });

  // ── Add a one-time rehearsal (no weekly template tie at all) ────────────────────

  const addOneTimeBtn        = document.getElementById('add-one-time-btn');
  const addOneTimeModalEl    = document.getElementById('addOneTimeModal');
  const oneTimePieceSelect   = document.getElementById('one-time-piece-select');
  const oneTimeDateInput     = document.getElementById('one-time-date-input');
  const oneTimeStartInput    = document.getElementById('one-time-start-input');
  const oneTimeEndInput      = document.getElementById('one-time-end-input');
  const oneTimeNoteInput     = document.getElementById('one-time-note-input');
  const confirmAddOneTimeBtn = document.getElementById('confirm-add-one-time-btn');

  addOneTimeBtn.addEventListener('click', () => {
    if (pieces.length === 0) { alert('Create a piece on the schedule first.'); return; }
    oneTimePieceSelect.innerHTML = pieces.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    // Default to the week currently being viewed, falling back to today.
    oneTimeDateInput.value = window._currentWeekMonday || new Date().toISOString().slice(0, 10);
    oneTimeStartInput.value = '';
    oneTimeEndInput.value   = '';
    oneTimeNoteInput.value  = '';
    document.getElementById('one-time-room-section').style.display = rooms.length > 0 ? 'block' : 'none';
    document.getElementById('one-time-room-select').innerHTML = roomSelectOptionsHTML(null);
    new bootstrap.Modal(addOneTimeModalEl).show();
  });

  confirmAddOneTimeBtn.addEventListener('click', async () => {
    const pieceId = oneTimePieceSelect.value;
    const date     = oneTimeDateInput.value;
    if (!date || !oneTimeStartInput.value || !oneTimeEndInput.value) {
      alert('Please fill in the date, start time, and end time.');
      return;
    }
    const [startH, startM] = oneTimeStartInput.value.split(':').map(Number);
    const [endH, endM]      = oneTimeEndInput.value.split(':').map(Number);
    try {
      const res = await fetch(`/api/pieces/${pieceId}/one-time-rehearsals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date, start_time: formatTime(startH, startM), end_time: formatTime(endH, endM),
          note: oneTimeNoteInput.value.trim() || undefined,
          room_id: document.getElementById('one-time-room-select').value || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not add this rehearsal.');
      } else {
        applyWeekExceptionStyling();
      }
    } catch (e) { alert('Could not connect to server.'); }
    bootstrap.Modal.getInstance(addOneTimeModalEl).hide();
  });

  // Dims any master block whose USUAL day/time didn't actually happen during the
  // currently-viewed week (cancelled or moved away) -- otherwise cancelling "just this
  // date" has no visible effect and looks like it silently failed. Only meaningful once
  // a week is actually being viewed (production dates configured).
  async function applyWeekExceptionStyling() {
    document.querySelectorAll('.master-block').forEach(b => {
      b.classList.remove('block-cancelled-this-week');
      if (b.title === 'Cancelled for this week only') b.removeAttribute('title');
    });
    document.querySelectorAll('.one-time-block').forEach(b => b.remove());
    const monday = window._currentWeekMonday;
    if (!monday) return;
    const sunday = new Date(`${monday}T00:00:00`);
    sunday.setDate(sunday.getDate() + 6);
    const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    try {
      const res = await fetch(`/api/master-blocks/occurrences?start=${monday}&end=${sundayStr}`);
      if (!res.ok) return;
      const occurrences = await res.json();
      const templateBlockIds = new Set(occurrences.filter(o => o.source === 'template').map(o => o.master_block_id));
      document.querySelectorAll('.master-block').forEach(blockEl => {
        if (!templateBlockIds.has(parseInt(blockEl.dataset.dbId))) {
          blockEl.classList.add('block-cancelled-this-week');
          blockEl.title = 'Cancelled for this week only';
        }
      });
      // Moved/added occurrences have no place in the recurring template at all, so they're
      // rendered as their own read-only markers (dashed, distinct color) layered on top of
      // the regular grid rather than going through the lane/conflict system that the
      // recurring blocks use -- they're one-time, so a rare visual overlap is an acceptable
      // trade for not entangling this with repositionAllBlocks().
      occurrences.filter(o => o.source === 'moved' || o.source === 'added').forEach(renderOneTimeBlock);
    } catch (e) { /* leave styling as-is */ }
  }
  window.addEventListener('weekChanged', applyWeekExceptionStyling);

  // Returns the 0-6 (Monday-Sunday) index of targetDateStr within the week starting at
  // mondayStr, or -1 if it falls outside that week. Both dates are constructed via the
  // same local-midnight pattern used throughout this file, so subtracting them gives an
  // exact day count safe across DST transitions when rounded.
  function dayIndexInWeek(mondayStr, targetDateStr) {
    const monday = new Date(`${mondayStr}T00:00:00`);
    const target = new Date(`${targetDateStr}T00:00:00`);
    const diffDays = Math.round((target - monday) / 86400000);
    return (diffDays >= 0 && diffDays <= 6) ? diffDays : -1;
  }

  // Surfaces the audition date and any performance date(s) -- production-wide
  // milestones set on Production Settings -- whenever the currently-viewed week
  // contains one. Originally tried squeezing an icon onto the day-header text itself;
  // that broke down with several milestone days in one week and at narrower window
  // widths (the appended text has nowhere clipped to go, so it can overflow sideways
  // into the next cell, or off the grid entirely for the last day). A named banner
  // can't have that problem since it isn't confined to one narrow column; the
  // per-cell highlight is now just a whole-cell accent (CSS box-shadow, not text).
  async function applyMilestoneDateMarkers() {
    document.querySelectorAll('.day-header.has-milestone').forEach(el => {
      el.classList.remove('has-milestone');
      el.removeAttribute('title');
    });
    document.querySelectorAll('.day-column.has-milestone').forEach(el => el.classList.remove('has-milestone'));
    const banner = document.getElementById('milestone-banner');
    banner.classList.add('d-none');
    const monday = window._currentWeekMonday;
    if (!monday) return;
    try {
      const [datesRes, perfRes] = await Promise.all([
        fetch('/api/season/production-dates'),
        fetch('/api/season/performance-dates'),
      ]);
      const dates = datesRes.ok ? await datesRes.json() : {};
      const perfDates = perfRes.ok ? await perfRes.json() : [];
      const milestones = [];
      if (dates.audition_date) milestones.push({ date: dates.audition_date, type: 'Audition' });
      perfDates.forEach(p => milestones.push({ date: p.date, type: 'Performance' }));

      const inWeek = milestones
        .map(m => ({ ...m, idx: dayIndexInWeek(monday, m.date) }))
        .filter(m => m.idx !== -1);
      if (inWeek.length === 0) return;

      inWeek.forEach(m => {
        const headerCell = headerRow.children[m.idx + 1]; // +1 skips the time-gutter spacer
        const columnCell = grid.children[m.idx]; // grid has no leading spacer, unlike headerRow
        const niceDate = new Date(`${m.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        if (headerCell) {
          headerCell.classList.add('has-milestone');
          headerCell.title = headerCell.title ? `${headerCell.title}; ${m.type}: ${niceDate}` : `${m.type}: ${niceDate}`;
        }
        if (columnCell) columnCell.classList.add('has-milestone');
      });

      // Group by type so "Friday, Saturday, and Sunday" reads as one line per type
      // instead of three separate near-identical sentences.
      const byType = new Map();
      inWeek.forEach(m => {
        const dayName = new Date(`${m.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
        if (!byType.has(m.type)) byType.set(m.type, []);
        byType.get(m.type).push(dayName);
      });
      const icon = { Audition: '🎟', Performance: '🎭' };
      const lines = [...byType.entries()].map(([type, days]) => `${icon[type] || ''} ${type}${days.length > 1 ? 's' : ''} this week: ${days.join(', ')}`);
      banner.innerHTML = lines.join('<br>');
      banner.classList.remove('d-none');
    } catch (e) { /* leave header/banner as-is */ }
  }
  window.addEventListener('weekChanged', applyMilestoneDateMarkers);

  function renderOneTimeBlock(occ) {
    const dayName  = new Date(`${occ.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
    const dayIndex = DAYS.indexOf(dayName);
    if (dayIndex === -1) return;
    const topPx = timeStringToTopPx(occ.start_time);
    const btmPx = timeStringToTopPx(occ.end_time);

    const block = document.createElement('div');
    block.className = 'block one-time-block';
    block.style.top      = `${topPx}px`;
    block.style.height   = `${Math.max(btmPx - topPx, slotHeight)}px`;
    block.style.left     = `calc(${dayIndex} * 100% / 7)`;
    block.style.width    = `calc(100% / 7)`;
    block.style.position = 'absolute';
    block.style.boxSizing = 'border-box';
    block.style.zIndex   = '3';
    const piece = pieces.find(p => p.id === occ.piece_id);
    if (piece) { block.style.border = `2px dashed ${piece.color}`; block.style.background = hexToRgba(piece.color, 0.3); }
    const label = occ.source === 'moved' ? 'Moved here' : 'One-time';
    block.title = `${label}${occ.note ? `: ${occ.note}` : ''}`;
    block.innerHTML = `
      <span style="font-size:11px;font-weight:bold;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${piece ? piece.name : 'Rehearsal'} (${label})</span>
      <span style="font-size:10px;display:block;opacity:0.8;">${occ.start_time} – ${occ.end_time}</span>
      <button class="delete-btn" title="Remove">&times;</button>`;
    block.querySelector('.delete-btn').addEventListener('mousedown', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        const res = await fetch(`/api/master-blocks/exceptions/${occ.exception_id}`, { method: 'DELETE' });
        if (res.ok) block.remove();
      } catch (err) { /* leave block as-is on failure */ }
    });
    grid.appendChild(block);
  }

  async function loadBlocks() {
    try {
      const [blocksRes, placeholdersRes] = await Promise.all([
        fetch('/api/master-blocks'),
        fetch('/api/schedule-placeholders'),
      ]);
      if (blocksRes.ok) {
        const blocks = await blocksRes.json();
        blocks.forEach(b => {
          const piece    = pieces.find(p => p.id === b.piece_id);
          if (!piece) return;
          const topPx    = timeStringToTopPx(b.start_time);
          const btmPx    = timeStringToTopPx(b.end_time);
          const dayIndex = DAYS.indexOf(b.day);
          renderBlock(b.id, piece, topPx, btmPx - topPx, dayIndex, b.start_time, b.end_time, b.room_id);
        });
      }
      if (placeholdersRes.ok) {
        const placeholders = await placeholdersRes.json();
        placeholders.forEach(ph => {
          const topPx    = timeStringToTopPx(ph.start_time);
          const btmPx    = timeStringToTopPx(ph.end_time);
          const dayIndex = DAYS.indexOf(ph.day);
          renderPlaceholder(ph.id, ph.label, topPx, btmPx - topPx, dayIndex, ph.start_time, ph.end_time, ph.room_id);
        });
      }
    } catch (e) { console.error('loadBlocks error:', e); }

    // Org blocks fetched separately so a failure here never skips repositionAllBlocks
    try {
      const orgBlocksRes = await fetch('/api/master-blocks/org');
      if (orgBlocksRes.ok) {
        const orgBlocks = await orgBlocksRes.json();
        if (orgBlocks.length > 0) {
          orgBlocks.forEach(b => renderOrgBlock(b));
          const toggleRow = document.getElementById('org-blocks-toggle-row');
          if (toggleRow) toggleRow.style.display = '';
        }
      }
    } catch (e) { console.error('org blocks error:', e); }

    repositionAllBlocks();
  }

  // ── Mouse interaction ─────────────────────────────────────────────────────────

  grid.addEventListener('mousedown', e => {
    // Delete buttons use mousedown+stopPropagation — they never reach here.

    // Resize handle — works for both master blocks and placeholder blocks
    if (e.target.classList.contains('resize-handle')) {
      isResizing    = true;
      currentBlock  = e.target.closest('.block');
      activeBlockId = currentBlock?.dataset.dbId;
      resizeDir     = e.target.classList.contains('resize-top') ? 'top' : 'bottom';
      e.preventDefault();
      return;
    }

    // Drag handle on placeholder block — move the placeholder
    if (e.target.classList.contains('ph-drag-handle')) {
      currentBlock  = e.target.closest('.placeholder-block');
      activeBlockId = currentBlock.dataset.dbId;
      const dayWidth = grid.clientWidth / 7;
      const dayIdx   = DAYS.indexOf(currentBlock.dataset.day);
      currentBlock.style.width = `${dayWidth}px`;
      currentBlock.style.left  = `${dayIdx * dayWidth}px`;
      offsetY = e.clientY - currentBlock.getBoundingClientRect().top;
      e.preventDefault();
      return;
    }

    // Drag a master block
    if (e.target.closest('.master-block')) {
      currentBlock  = e.target.closest('.master-block');
      activeBlockId = currentBlock.dataset.dbId;
      const dayWidth = grid.clientWidth / 7;
      const dayIdx   = DAYS.indexOf(currentBlock.dataset.day);
      currentBlock.style.width = `${dayWidth}px`;
      currentBlock.style.left  = `${dayIdx * dayWidth}px`;
      offsetY = e.clientY - currentBlock.getBoundingClientRect().top;
      e.preventDefault();
      return;
    }

    const slot = e.target.closest('.time-slot');
    if (!slot) return;
    isSelecting   = true;
    currentDayCol = slot.parentElement;
    startSlot     = parseInt(slot.dataset.timeIndex);
    const dayIndex = Array.from(grid.children).indexOf(currentDayCol);
    const dayWidth = grid.clientWidth / 7;

    currentBlock = document.createElement('div');
    currentBlock.className        = 'block pending-block';
    currentBlock.dataset.dayIndex = dayIndex; // stored so mouseup can skip parsing style.left
    currentBlock.style.left       = `${dayIndex * dayWidth}px`;
    currentBlock.style.width      = `${dayWidth}px`;
    currentBlock.style.top        = `${startSlot * slotHeight}px`;
    currentBlock.style.height     = `${slotHeight}px`;
    currentBlock.style.background = 'rgba(180,180,180,0.4)';
    currentBlock.style.border     = '2px dashed #999';
    currentBlock.style.position   = 'absolute';
    currentBlock.style.boxSizing  = 'border-box';
    currentBlock.style.pointerEvents = 'none';
    currentBlock.style.zIndex     = '20';  // float above all existing blocks while drawing
    currentBlock.style.fontSize   = '11px';
    currentBlock.style.padding    = '2px 4px';
    currentBlock.style.color      = '#555';
    currentBlock.textContent      = '...';
    grid.appendChild(currentBlock);
  });

  // Document-level handler for drag-create — fires even when cursor leaves the grid
  document.addEventListener('mousemove', e => {
    if (!isSelecting || !currentBlock) return;
    const rect = grid.getBoundingClientRect();
    const y    = e.clientY - rect.top;
    const cur  = Math.max(0, Math.min(Math.floor(y / slotHeight), totalSlots - 1));
    const topSlot = Math.min(startSlot, cur);
    currentBlock.style.top    = `${topSlot * slotHeight}px`;
    currentBlock.style.height = `${(Math.abs(cur - startSlot) + 1) * slotHeight}px`;
  });

  grid.addEventListener('mousemove', e => {
    if (isSelecting) return; // handled above at document level

    if (isResizing && currentBlock) {
      const rect = grid.getBoundingClientRect();
      const y    = Math.round((e.clientY - rect.top) / slotHeight) * slotHeight;
      const bTop = parseFloat(currentBlock.style.top);
      const bH   = parseFloat(currentBlock.style.height);
      if (resizeDir === 'top') {
        const newTop = Math.min(y, bTop + bH - slotHeight);
        currentBlock.style.top    = `${Math.max(0, newTop)}px`;
        currentBlock.style.height = `${bH + (bTop - parseFloat(currentBlock.style.top))}px`;
      } else {
        currentBlock.style.height = `${Math.max(y - bTop, slotHeight)}px`;
      }
      return;
    }

    if (currentBlock && (currentBlock.classList.contains('master-block') || currentBlock.classList.contains('placeholder-block')) && e.buttons === 1) {
      const rect     = grid.getBoundingClientRect();
      const dayWidth = grid.clientWidth / 7;
      let y = e.clientY - rect.top - offsetY;
      let x = e.clientX - rect.left;
      y = Math.round(y / slotHeight) * slotHeight;
      y = Math.max(0, Math.min(y, grid.clientHeight - parseFloat(currentBlock.style.height)));
      const dayIndex = Math.max(0, Math.min(Math.floor(x / dayWidth), 6));
      currentBlock.style.top   = `${y}px`;
      currentBlock.style.left  = `${dayIndex * dayWidth}px`;
      currentBlock.dataset.day = DAYS[dayIndex];
    }
  });

  document.addEventListener('mouseup', async () => {
    if (isSelecting && currentBlock) {
      isSelecting  = false;
      pendingBlock = currentBlock;
      currentBlock = null;
      populatePieceSelect();
      document.getElementById('new-piece-name').value         = '';
      document.getElementById('placeholder-label-input').value = '';
      document.getElementById('radio-new-piece').checked      = true;
      showModalSection('new');
      document.getElementById('block-room-section').style.display = rooms.length > 0 ? 'block' : 'none';
      document.getElementById('block-room-select').innerHTML = roomSelectOptionsHTML(null);
      new bootstrap.Modal(document.getElementById('pieceModal'), { backdrop: 'static' }).show();
      return;
    }

    if ((isResizing || currentBlock) && activeBlockId && currentBlock) {
      const blockToUpdate = currentBlock;
      isResizing   = false;
      currentBlock = null;
      const pos = getBlockPosition(blockToUpdate);
      blockToUpdate.dataset.startTime = pos.start_time;
      blockToUpdate.dataset.endTime   = pos.end_time;
      blockToUpdate.dataset.day       = pos.day;

      if (blockToUpdate.classList.contains('placeholder-block')) {
        try {
          await fetch(`/api/schedule-placeholders/${activeBlockId}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ label: blockToUpdate.dataset.label || '', ...pos }),
          });
          repositionAllBlocks();
        } catch (err) { console.error('Placeholder update failed:', err); }
      } else {
        const timeLabel = blockToUpdate.querySelector('span:nth-child(2)');
        if (timeLabel) timeLabel.textContent = `${pos.start_time} – ${pos.end_time}`;
        try {
          await fetch(`/api/master-blocks/${activeBlockId}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(pos),
          });
          repositionAllBlocks();
        } catch (err) { console.error('Update failed:', err); }
      }
      activeBlockId = null;
      return;
    }

    isSelecting   = false;
    isResizing    = false;
    currentBlock  = null;
    activeBlockId = null;
  });

  // ── Modal radio toggles ───────────────────────────────────────────────────────

  function showModalSection(which) {
    document.getElementById('new-piece-section').style.display      = which === 'new'         ? 'block' : 'none';
    document.getElementById('existing-piece-section').style.display = which === 'existing'    ? 'block' : 'none';
    document.getElementById('placeholder-section').style.display    = which === 'placeholder' ? 'block' : 'none';
  }

  document.getElementById('radio-new-piece').addEventListener('change',     () => showModalSection('new'));
  document.getElementById('radio-existing-piece').addEventListener('change', () => showModalSection('existing'));
  document.getElementById('radio-placeholder').addEventListener('change',   () => showModalSection('placeholder'));

  // ── Modal confirm ─────────────────────────────────────────────────────────────

  document.getElementById('piece-confirm-btn').addEventListener('click', async () => {
    const isNew         = document.getElementById('radio-new-piece').checked;
    const isPlaceholder = document.getElementById('radio-placeholder').checked;

    const topPx    = parseFloat(pendingBlock.style.top);
    const heightPx = parseFloat(pendingBlock.style.height);
    const dayIndex = Math.max(0, Math.min(parseInt(pendingBlock.dataset.dayIndex ?? 0), 6));
    const startI   = Math.round(topPx / slotHeight);
    const endI     = startI + Math.round(heightPx / slotHeight);
    const startTime = slotToTimeString(startI);
    const endTime   = slotToTimeString(endI);

    const roomId = document.getElementById('block-room-select').value || null;

    if (isPlaceholder) {
      const label = document.getElementById('placeholder-label-input').value.trim() || 'Blocked';
      try {
        const res = await fetch('/api/schedule-placeholders', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ label, day: DAYS[dayIndex], start_time: startTime, end_time: endTime, room_id: roomId }),
        });
        if (!res.ok) { alert('Could not save placeholder.'); return; }
        const saved = await res.json();
        pendingBlock.remove();
        pendingBlock = null;
        renderPlaceholder(saved.id, saved.label, topPx, heightPx, dayIndex, startTime, endTime, saved.room_id);
        repositionAllBlocks();
      } catch (err) { console.error(err); return; }
      bootstrap.Modal.getInstance(document.getElementById('pieceModal')).hide();
      return;
    }

    let piece;
    if (isNew) {
      const name = document.getElementById('new-piece-name').value.trim();
      if (!name) { alert('Please enter a piece name.'); return; }
      const color = COLORS[pieces.length % COLORS.length];
      try {
        const res = await fetch('/api/pieces', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ name, color }),
        });
        if (!res.ok) { alert('Could not create piece.'); return; }
        piece = await res.json();
        pieces.push(piece);
        renderLegend();
      } catch (err) { console.error(err); return; }
    } else {
      const sel = document.getElementById('existing-piece-select');
      piece = pieces.find(p => p.id === parseInt(sel.value));
      if (!piece) { alert('Please select a piece.'); return; }
    }

    try {
      const res = await fetch('/api/master-blocks', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ piece_id: piece.id, day: DAYS[dayIndex], start_time: startTime, end_time: endTime, room_id: roomId }),
      });
      if (!res.ok) { alert('Could not save block.'); return; }
      const saved = await res.json();
      pendingBlock.remove();
      pendingBlock = null;
      renderBlock(saved.id, piece, topPx, heightPx, dayIndex, startTime, endTime, roomId);
      repositionAllBlocks();
    } catch (err) { console.error(err); return; }

    bootstrap.Modal.getInstance(document.getElementById('pieceModal')).hide();
  });

  document.getElementById('piece-cancel-btn').addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('pieceModal')).hide();
  });

  document.getElementById('pieceModal').addEventListener('hidden.bs.modal', () => {
    if (pendingBlock) { pendingBlock.remove(); pendingBlock = null; }
  });

  // ── Initialize ────────────────────────────────────────────────────────────────

  await loadPieces();
  await loadRoomCount();
  await loadRooms();
  await new Promise(r => requestAnimationFrame(r));
  await loadBlocks();
  // master.html's auth-check fetch (which sets window._currentWeekMonday) and this
  // DOMContentLoaded handler aren't ordered relative to each other, so this call and the
  // weekChanged listener above both exist -- whichever finishes second is the one that
  // actually has both the rendered blocks and the active week available together.
  applyWeekExceptionStyling();
  applyMilestoneDateMarkers();

  // Toggle other-productions overlay visibility
  document.getElementById('org-blocks-toggle')?.addEventListener('change', function () {
    document.querySelectorAll('.org-overlay-block').forEach(b => {
      b.style.display = this.checked ? '' : 'none';
    });
  });
});
