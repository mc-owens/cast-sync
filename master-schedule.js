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
  let pendingBlock        = null;
  let isSelecting         = false;
  let startSlot           = 0;
  let currentBlock        = null;
  let currentDayCol       = null;
  let isResizing          = false;
  let resizeDir           = null;
  let offsetY             = 0;
  let activeBlockId       = null;
  let originalDayBeforeDrag = null;
  let pendingDragMove       = null;
  let blockWasDragged       = false;
  let dragStartX            = 0;
  let dragStartY            = 0;
  const DRAG_THRESHOLD      = 6; // px — below this is treated as a click

  // ── Rehearsal drawer state ────────────────────────────────────────────────────
  let drawerPieceCasts       = [];
  let drawerCastsLoaded      = false;
  let drawerCurrentPieceId   = null;
  let drawerCurrentDbId      = null;
  let drawerCurrentDay       = null;
  let drawerCurrentStartTime = null;
  let drawerCurrentEndTime   = null;
  let drawerCurrentRoomId    = null;

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
    const fallbackBtn = document.getElementById('use-room-count-btn');
    if (fallbackBtn) fallbackBtn.classList.toggle('d-none', hasRooms);
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
      <div class="d-flex align-items-center gap-1 mb-1" data-room-row="${r.id}">
        <span style="font-size:12.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.name}</span>
        <button type="button" data-edit-room="${r.id}" aria-label="Rename room"
          style="border:none;background:none;padding:2px 4px;color:#9ca3af;cursor:pointer;flex-shrink:0;font-size:12px;line-height:1;">&#9998;</button>
        <button type="button" class="btn-close" style="font-size:9px;flex-shrink:0;" data-delete-room="${r.id}" aria-label="Delete room"></button>
      </div>`).join('') || '<div class="text-muted" style="font-size:12px;">No rooms yet.</div>';

    document.querySelectorAll('[data-edit-room]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id  = btn.dataset.editRoom;
        const room = rooms.find(r => String(r.id) === id);
        if (!room) return;
        const row = btn.closest('[data-room-row]');
        row.innerHTML = `
          <input type="text" value="${room.name}" maxlength="60"
            style="flex:1;font-size:12.5px;border:1px solid #d1d5db;border-radius:4px;padding:2px 6px;min-width:0;">
          <button type="button" data-save-room="${id}"
            style="border:none;background:none;padding:2px 6px;color:#111;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;">Save</button>
          <button type="button" data-cancel-edit
            style="border:none;background:none;padding:2px 4px;color:#9ca3af;cursor:pointer;font-size:12px;flex-shrink:0;">Cancel</button>
        `;
        const input = row.querySelector('input');
        input.focus();
        input.select();

        row.querySelector('[data-cancel-edit]').addEventListener('click', () => renderRoomsList());

        const doSave = async () => {
          const newName = input.value.trim();
          if (!newName) return;
          try {
            const res = await fetch(`/api/season/rooms/${id}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName }),
            });
            if (!res.ok) { const d = await res.json(); alert(d.error || 'Could not rename room.'); return; }
            const updated = await res.json();
            rooms = rooms.map(r => String(r.id) === id ? updated : r);
            renderRoomsList();
            updateRoomModeUI();
            repositionAllBlocks();
          } catch (e) { alert('Could not connect to server.'); }
        };
        row.querySelector('[data-save-room]').addEventListener('click', doSave);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') doSave();
          if (e.key === 'Escape') renderRoomsList();
        });
      });
    });

    document.querySelectorAll('[data-delete-room]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteRoom;
        try {
          let res = await fetch(`/api/season/rooms/${id}`, { method: 'DELETE' });
          if (res.status === 409) {
            const data = await res.json();
            const confirmed = confirm(`${data.count} rehearsal${data.count === 1 ? '' : 's'} ${data.count === 1 ? 'is' : 'are'} assigned to this room. Deleting it will unassign ${data.count === 1 ? 'it' : 'them'}. Continue?`);
            if (!confirmed) return;
            res = await fetch(`/api/season/rooms/${id}?force=true`, { method: 'DELETE' });
          }
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
    document.getElementById('use-room-count-btn').classList.remove('d-none');
    document.getElementById('new-room-name-input').focus();
  });

  document.getElementById('use-room-count-btn').addEventListener('click', () => {
    document.getElementById('named-rooms-section').style.display = 'none';
    document.getElementById('room-count-section').style.display = '';
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
      const masterEls = Array.from(document.querySelectorAll(`.master-block[data-day="${day}"]`))
        .filter(el => !el.classList.contains('block-cancelled-this-week'));
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

      // Cross-production room conflicts: compare this production's blocks against
      // org overlay blocks that share a named room.
      const orgBlocks = Array.from(document.querySelectorAll('.org-overlay-block')).map(el => ({
        el,
        day:      el.dataset.day,
        startMin: timeStringToMinutes(el.dataset.startTime),
        endMin:   timeStringToMinutes(el.dataset.endTime),
        roomId:   el.dataset.roomId || '',
      }));
      orgBlocks.forEach(b => b.el.classList.remove('room-conflict'));
      allBlocks.forEach(b => {
        if (!b.roomId) return;
        const crossConflict = orgBlocks.some(o => o.roomId && o.roomId === b.roomId &&
          o.day === b.day && o.startMin < b.endMin && o.endMin > b.startMin);
        if (crossConflict) { b.el.classList.add('room-conflict'); hasConflict = true; }
      });
      orgBlocks.forEach(b => {
        if (!b.roomId) return;
        const crossConflict = allBlocks.some(o => o.roomId && o.roomId === b.roomId &&
          o.day === b.day && o.startMin < b.endMin && o.endMin > b.startMin);
        if (crossConflict) { b.el.classList.add('room-conflict'); hasConflict = true; }
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
    el.dataset.roomId    = block.room_id || '';
    el.dataset.pieceName  = block.piece_name || '';
    el.dataset.seasonName = block.season_name || '';
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

  // ── Rehearsal drawer ─────────────────────────────────────────────────────────

  // "7:00 PM" <-> "19:00" conversions for <input type="time">
  function appTimeToInputTime(t) {
    const [timePart, ampm] = t.split(' ');
    let [h, m] = timePart.split(':').map(Number);
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h  = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  function inputTimeToAppTime(t) {
    const [h, m] = t.split(':').map(Number);
    return formatTime(h, m);
  }
  function nextMondayStr() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function showNormalDrawerView() {
    const tabBar     = document.getElementById('drawer-tab-bar');
    const actionFoot = document.getElementById('drawer-action-footer');
    const changeFoot = document.getElementById('drawer-change-footer');
    if (tabBar)     tabBar.style.display     = '';
    if (actionFoot) actionFoot.style.display = '';
    if (changeFoot) changeFoot.style.display = 'none';
    renderDrawerTab('cast');
  }

  function showChangeWeeklyForm() {
    const tabBar     = document.getElementById('drawer-tab-bar');
    const actionFoot = document.getElementById('drawer-action-footer');
    const changeFoot = document.getElementById('drawer-change-footer');
    const content    = document.getElementById('drawer-tab-content');
    if (tabBar)     tabBar.style.display     = 'none';
    if (actionFoot) actionFoot.style.display = 'none';
    if (changeFoot) changeFoot.style.display = '';

    const minDate  = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const defDate  = nextMondayStr();
    const startVal = drawerCurrentStartTime ? appTimeToInputTime(drawerCurrentStartTime) : '';
    const endVal   = drawerCurrentEndTime   ? appTimeToInputTime(drawerCurrentEndTime)   : '';
    const roomHtml = rooms.length > 0
      ? `<div style="margin-bottom:14px;">
           <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:5px;">Room</label>
           <select id="drawer-change-room" style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
             <option value="">No room</option>
             ${rooms.map(r => `<option value="${r.id}"${String(r.id) === String(drawerCurrentRoomId) ? ' selected' : ''}>${r.name}</option>`).join('')}
           </select>
         </div>`
      : '';

    if (content) content.innerHTML = `
      <p style="font-size:12px;color:#6b7280;margin:0 0 16px;line-height:1.5;">
        The existing schedule stays exactly as it was. CastSync will create a new version starting on the date you choose.
      </p>
      <div style="margin-bottom:14px;">
        <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:5px;">Starting when?</label>
        <input type="date" id="drawer-change-start-date" value="${defDate}" min="${minDate}"
          style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;" />
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px;">
        <div style="flex:1;">
          <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:5px;">Start time</label>
          <input type="time" id="drawer-change-start-time" value="${startVal}"
            style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;" />
        </div>
        <div style="flex:1;">
          <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:5px;">End time</label>
          <input type="time" id="drawer-change-end-time" value="${endVal}"
            style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;" />
        </div>
      </div>
      ${roomHtml}
      <div id="drawer-change-error" style="font-size:12px;color:#ef4444;margin-top:4px;display:none;"></div>`;
  }

  async function loadDrawerCasts() {
    if (drawerCastsLoaded) return;
    drawerCastsLoaded = true;
    try {
      const res = await fetch('/api/piece-casts');
      if (res.ok) drawerPieceCasts = await res.json();
    } catch (e) {}
  }

  function closeBlockDrawer() {
    document.getElementById('block-drawer')?.classList.remove('open');
    drawerCurrentPieceId = null;
    drawerCurrentDbId    = null;
    drawerCurrentDay     = null;
  }

  function checkDrawerRoomConflict(selectedRoomId) {
    const warningEl = document.getElementById('drawer-room-conflict-warning');
    if (!warningEl) return;
    if (!selectedRoomId) { warningEl.style.display = 'none'; return; }
    const curStart = timeStringToMinutes(drawerCurrentStartTime);
    const curEnd   = timeStringToMinutes(drawerCurrentEndTime);

    // Current production blocks
    const prodConflicts = [...document.querySelectorAll(`.master-block[data-day="${drawerCurrentDay}"]`)]
      .filter(el => String(el.dataset.dbId) !== String(drawerCurrentDbId))
      .filter(el => String(el.dataset.roomId) === String(selectedRoomId))
      .filter(el => {
        const s = timeStringToMinutes(el.dataset.startTime);
        const e = timeStringToMinutes(el.dataset.endTime);
        return s < curEnd && e > curStart;
      })
      .map(el => {
        const p = pieces.find(p => String(p.id) === String(el.dataset.pieceId));
        return p ? p.name : 'another piece';
      });

    // Other productions in the same org
    const orgConflicts = [...document.querySelectorAll(`.org-overlay-block[data-day="${drawerCurrentDay}"]`)]
      .filter(el => String(el.dataset.roomId) === String(selectedRoomId))
      .filter(el => {
        const s = timeStringToMinutes(el.dataset.startTime);
        const e = timeStringToMinutes(el.dataset.endTime);
        return s < curEnd && e > curStart;
      })
      .map(el => `${el.dataset.pieceName} (${el.dataset.seasonName})`);

    const allNames = [...new Set([...prodConflicts, ...orgConflicts])];
    if (allNames.length === 0) { warningEl.style.display = 'none'; return; }
    const roomObj = rooms.find(r => String(r.id) === String(selectedRoomId));
    warningEl.textContent = `${roomObj ? roomObj.name : 'This room'} is already booked for ${allNames.join(', ')} at this time.`;
    warningEl.style.display = '';
  }

  function renderDrawerConflicts() {
    const content = document.getElementById('drawer-tab-content');
    if (!content) return;
    const thisCast = drawerPieceCasts.filter(c => String(c.piece_id) === String(drawerCurrentPieceId));
    if (thisCast.length === 0) {
      content.innerHTML = `<p style="font-size:13px;color:#9ca3af;margin:0;">No cast assigned yet.</p>`;
      return;
    }
    const curStart = timeStringToMinutes(drawerCurrentStartTime);
    const curEnd   = timeStringToMinutes(drawerCurrentEndTime);
    const overlapBlocks = [...document.querySelectorAll('.master-block')]
      .filter(el => String(el.dataset.dbId) !== String(drawerCurrentDbId))
      .filter(el => el.dataset.day === drawerCurrentDay)
      .filter(el => {
        const s = timeStringToMinutes(el.dataset.startTime);
        const e = timeStringToMinutes(el.dataset.endTime);
        return s < curEnd && e > curStart;
      });
    if (overlapBlocks.length === 0) {
      content.innerHTML = `<p style="font-size:13px;color:#9ca3af;margin:0;">No other pieces rehearse at this time.</p>`;
      return;
    }
    const overlapPieceIds = new Set(overlapBlocks.map(el => String(el.dataset.pieceId)));
    let rows = '';
    for (const dancer of thisCast) {
      const clashes = drawerPieceCasts.filter(c =>
        String(c.user_id) === String(dancer.user_id) &&
        String(c.piece_id) !== String(drawerCurrentPieceId) &&
        overlapPieceIds.has(String(c.piece_id))
      );
      for (const clash of clashes) {
        const block = overlapBlocks.find(el => String(el.dataset.pieceId) === String(clash.piece_id));
        const timeRange = block ? `${block.dataset.startTime} – ${block.dataset.endTime}` : '';
        rows += `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f9fafb;">
          <div style="width:30px;height:30px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#374151;flex-shrink:0;">
            ${(dancer.first_name||'?')[0]}${(dancer.last_name||'?')[0]}
          </div>
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:500;">${dancer.first_name} ${dancer.last_name}</div>
            <div style="font-size:11px;color:#ef4444;">Also in ${clash.piece_name}${timeRange ? ` · ${timeRange}` : ''}</div>
          </div>
        </div>`;
      }
    }
    if (!rows) {
      content.innerHTML = `<p style="font-size:13px;color:#9ca3af;margin:0;">No scheduling conflicts for this cast.</p>`;
      return;
    }
    content.innerHTML = `
      <p style="font-size:11.5px;color:#b45309;margin:0 0 10px;">Dancers also in another piece at this time:</p>
      ${rows}`;
  }

  function renderDrawerNotes() {
    const content = document.getElementById('drawer-tab-content');
    if (!content) return;
    const pieceName = pieces.find(p => String(p.id) === String(drawerCurrentPieceId))?.name || '';
    const date = dateForDayInWeek(window._currentWeekMonday || new Date().toISOString().slice(0,10), drawerCurrentDay);
    const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    content.innerHTML = `
      <div style="margin-bottom:10px;">
        <div style="font-size:11.5px;color:#9ca3af;margin-bottom:5px;">Save to:</div>
        <select id="drawer-note-dest" style="font-size:12px;padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#374151;cursor:pointer;width:100%;">
          <option value="private">My Private Notes</option>
          <option value="production">Production Notes (shared with directors)</option>
        </select>
      </div>
      <textarea id="drawer-note-text" placeholder="Type a note..." style="width:100%;padding:9px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;min-height:100px;resize:vertical;font-family:inherit;box-sizing:border-box;"></textarea>
      <button id="drawer-note-save-btn" style="margin-top:8px;width:100%;padding:8px;background:#111;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;">Save Note</button>
      <span id="drawer-note-saved" style="font-size:12px;color:#16a34a;margin-top:6px;display:none;text-align:center;display:block;"></span>`;
    content.querySelector('#drawer-note-save-btn')?.addEventListener('click', async () => {
      const textarea = content.querySelector('#drawer-note-text');
      const dest     = content.querySelector('#drawer-note-dest')?.value || 'private';
      const text = textarea?.value.trim();
      if (!text) return;
      const btn = content.querySelector('#drawer-note-save-btn');
      const savedEl = content.querySelector('#drawer-note-saved');
      btn.disabled = true; btn.textContent = 'Saving...';
      const context = [pieceName, `${drawerCurrentDay} ${drawerCurrentStartTime}–${drawerCurrentEndTime}`, dateLabel].filter(Boolean).join(' · ');
      const noteText = `${context}: ${text}`;
      try {
        let r;
        if (dest === 'production') {
          r = await fetch('/api/season/production-notes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              note_text: noteText,
              category: 'general',
              dancer_user_ids: [],
              piece_ids: drawerCurrentPieceId ? [drawerCurrentPieceId] : [],
              notify_emails: [],
            }),
          });
        } else {
          r = await fetch('/api/my-notes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note_text: noteText }),
          });
        }
        if (r.ok) {
          textarea.value = '';
          const label = dest === 'production' ? 'Saved to Production Notes.' : 'Saved to My Private Notes.';
          if (savedEl) { savedEl.textContent = label; savedEl.style.display = 'block'; setTimeout(() => { if (savedEl) savedEl.style.display = 'none'; }, 2500); }
        } else {
          alert('Could not save note.');
        }
      } catch (e) { alert('Could not connect to server.'); }
      btn.disabled = false; btn.textContent = 'Save Note';
    });
  }

  function renderDrawerTab(tabName) {
    document.querySelectorAll('[data-drawer-tab]').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.drawerTab === tabName)
    );
    const content = document.getElementById('drawer-tab-content');
    if (!content) return;

    if (tabName === 'cast') {
      const cast = drawerPieceCasts.filter(c => String(c.piece_id) === String(drawerCurrentPieceId));
      if (cast.length === 0) {
        content.innerHTML = `<p style="font-size:13px;color:#6b7280;margin:0;">No cast assigned yet. Add dancers from the <a href="search.html" style="color:inherit;">Casting Availability</a> tab.</p>`;
      } else {
        content.innerHTML = cast.map(c => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f9fafb;">
            <div style="width:30px;height:30px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#374151;flex-shrink:0;">
              ${(c.first_name||'?')[0]}${(c.last_name||'?')[0]}
            </div>
            <div style="min-width:0;">
              <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.first_name} ${c.last_name}</div>
              ${c.role_name ? `<div style="font-size:11px;color:#9ca3af;">${c.role_name}</div>` : ''}
            </div>
          </div>`).join('');
      }
    } else if (tabName === 'attendance') {
      renderDrawerAttendance();
    } else if (tabName === 'conflicts') {
      renderDrawerConflicts();
    } else if (tabName === 'notes') {
      renderDrawerNotes();
    }
  }

  async function renderDrawerAttendance() {
    const content = document.getElementById('drawer-tab-content');
    if (!content) return;
    const pieceId = drawerCurrentPieceId;
    const date = dateForDayInWeek(window._currentWeekMonday || new Date().toISOString().slice(0,10), drawerCurrentDay);

    content.innerHTML = `<p style="font-size:13px;color:#9ca3af;">Loading...</p>`;
    try {
      const [res, absRes] = await Promise.all([
        fetch(`/api/season/attendance?date=${encodeURIComponent(date)}&piece_id=${encodeURIComponent(pieceId)}`),
        fetch('/api/season/absence-requests'),
      ]);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const absAll = absRes.ok ? await absRes.json() : [];

      const curStart = timeStringToMinutes(drawerCurrentStartTime);
      const curEnd   = timeStringToMinutes(drawerCurrentEndTime);
      const castUserIds = new Set(data.dancers.map(d => String(d.user_id)));
      const approvedAbsences = absAll.filter(a => {
        if (a.status !== 'approved') return false;
        if (!castUserIds.has(String(a.user_id))) return false;
        const aDate = (a.absence_date || '').slice(0, 10);
        if (aDate !== date) return false;
        const aStart = timeStringToMinutes(a.start_time);
        const aEnd   = timeStringToMinutes(a.end_time);
        return aStart < curEnd && aEnd > curStart;
      });

      const presentCount = data.dancers.filter(d => d.present).length;
      const total = data.dancers.length;
      const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      let html = `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:12px;color:#6b7280;">${dateLabel}</span>
        <span id="drawer-attend-count" style="font-size:13px;font-weight:600;color:#374151;">${total > 0 ? `${presentCount}/${total} present` : ''}</span>
      </div>`;

      if (approvedAbsences.length > 0) {
        html += `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;margin-bottom:10px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#b91c1c;margin-bottom:5px;">Approved Absences</div>`;
        html += approvedAbsences.map(a => `
          <div style="font-size:12.5px;color:#374151;padding:3px 0;">${a.first_name} ${a.last_name}
            <span style="color:#9ca3af;font-size:11px;"> &middot; ${a.start_time} – ${a.end_time}</span>
          </div>`).join('');
        html += `</div>`;
      }

      if (data.dancers.length === 0) {
        html += `<p style="font-size:13px;color:#9ca3af;margin:0;">No one cast in this piece yet.</p>`;
        content.innerHTML = html;
        return;
      }

      html += data.dancers.map(d => `
        <div class="drawer-attend-row" data-user-id="${d.user_id}" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f9fafb;">
          <div style="flex:1;font-size:13px;">${d.first_name} ${d.last_name}</div>
          <div class="form-check form-switch mb-0">
            <input class="form-check-input drawer-present-toggle" type="checkbox" role="switch" ${d.present ? 'checked' : ''}>
            <label class="form-check-label drawer-present-label" style="font-size:12px;width:50px;display:inline-block;">${d.present ? 'Present' : 'Absent'}</label>
          </div>
          <span class="drawer-attend-saved" style="font-size:11px;color:#16a34a;display:none;">Saved</span>
        </div>`).join('');

      html += `<p style="font-size:11px;color:#9ca3af;margin-top:14px;margin-bottom:0;">For a more detailed view, go to <a href="attendance.html" style="color:#9ca3af;text-decoration:underline;">Attendance</a>, or see <a href="attendance.html" style="color:#9ca3af;text-decoration:underline;">attendance history</a>.</p>`;

      content.innerHTML = html;

      function refreshCount() {
        const rows = content.querySelectorAll('.drawer-attend-row');
        const p = [...rows].filter(r => r.querySelector('.drawer-present-toggle')?.checked).length;
        const countEl = content.querySelector('#drawer-attend-count');
        if (countEl) countEl.textContent = `${p}/${rows.length} present`;
      }

      content.addEventListener('change', async (e) => {
        if (!e.target.classList.contains('drawer-present-toggle')) return;
        const row = e.target.closest('.drawer-attend-row');
        if (!row) return;
        e.target.closest('.form-check').querySelector('.drawer-present-label').textContent = e.target.checked ? 'Present' : 'Absent';
        refreshCount();
        const savedEl = row.querySelector('.drawer-attend-saved');
        try {
          const r = await fetch('/api/season/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, piece_id: parseInt(pieceId), user_id: parseInt(row.dataset.userId), present: e.target.checked, status: 'none', status_note: null }),
          });
          if (r.ok && savedEl) { savedEl.style.display = ''; setTimeout(() => { savedEl.style.display = 'none'; }, 1500); }
        } catch (_) {}
      });
    } catch (err) {
      content.innerHTML = `<p style="font-size:13px;color:#dc2626;margin:0;">Could not load attendance.</p>`;
    }
  }


  async function openBlockDrawer(dbId, piece, dayName, startTime, endTime, roomId) {
    await loadDrawerCasts();
    drawerCurrentPieceId  = piece.id;
    drawerCurrentDbId     = dbId;
    drawerCurrentDay      = dayName;
    drawerCurrentStartTime = startTime;
    drawerCurrentEndTime   = endTime;
    drawerCurrentRoomId    = roomId;

    const dot  = document.getElementById('drawer-piece-dot');
    const name = document.getElementById('drawer-piece-name');
    const dt   = document.getElementById('drawer-day-time');
    const room = document.getElementById('drawer-room');
    if (dot)  dot.style.background = piece.color;
    if (name) name.textContent = piece.name;
    if (dt)   dt.textContent   = `${dayName} · ${startTime} – ${endTime}`;

    if (room) {
      const roomObj = roomId ? rooms.find(r => String(r.id) === String(roomId)) : null;
      if (rooms.length > 0) {
        const label = document.getElementById('drawer-room-label');
        if (label) label.textContent = roomObj ? roomObj.name : 'No room assigned';
        room.style.display = '';
      } else {
        room.style.display = 'none';
      }
      const editForm = document.getElementById('drawer-room-edit-form');
      if (editForm) editForm.style.display = 'none';
    }

    showNormalDrawerView();
    document.getElementById('block-drawer')?.classList.add('open');
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

    block.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn') || e.target.closest('.resize-handle')) return;
      openBlockDrawer(dbId, piece, DAYS[dayIndex], displayStart, displayEnd, roomId);
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

  let pendingDeleteBlock     = null;
  let deleteModalFromDrawer  = false;
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

  deleteModalEl.addEventListener('hidden.bs.modal', () => {
    if (deleteModalFromDrawer) {
      if (!pendingDeleteBlock) closeBlockDrawer(); // action completed — dismiss drawer too
      // else dismissed via Never mind — drawer stays open behind the modal naturally
    }
    deleteModalFromDrawer = false;
    pendingDeleteBlock = null; // cleanup if dismissed without action
  });

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
        bootstrap.Modal.getInstance(deleteModalEl).hide();
        pendingDeleteBlock = null;
        applyWeekExceptionStyling();
        return;
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
    oneTimePieceSelect.innerHTML =
      pieces.map(p => `<option value="${p.id}">${p.name}</option>`).join('') +
      `<option value="__new__">+ New piece...</option>`;
    document.getElementById('otr-new-piece-row').style.display = 'none';
    document.getElementById('otr-new-piece-name').value = '';
    oneTimeDateInput.value = window._currentWeekMonday || new Date().toISOString().slice(0, 10);
    oneTimeStartInput.value = '';
    oneTimeEndInput.value   = '';
    oneTimeNoteInput.value  = '';
    document.getElementById('one-time-room-section').style.display = rooms.length > 0 ? 'block' : 'none';
    document.getElementById('one-time-room-select').innerHTML = roomSelectOptionsHTML(null);
    new bootstrap.Modal(addOneTimeModalEl).show();
  });

  oneTimePieceSelect.addEventListener('change', () => {
    document.getElementById('otr-new-piece-row').style.display =
      oneTimePieceSelect.value === '__new__' ? 'block' : 'none';
  });

  confirmAddOneTimeBtn.addEventListener('click', async () => {
    let pieceId = oneTimePieceSelect.value;
    const date  = oneTimeDateInput.value;
    if (!date || !oneTimeStartInput.value || !oneTimeEndInput.value) {
      alert('Please fill in the date, start time, and end time.');
      return;
    }
    if (pieceId === '__new__') {
      const newName = document.getElementById('otr-new-piece-name').value.trim();
      if (!newName) { alert('Please enter a name for the new piece.'); return; }
      try {
        const color = COLORS[pieces.length % COLORS.length];
        const pr = await fetch('/api/pieces', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName, color }),
        });
        if (!pr.ok) { alert('Could not create piece.'); return; }
        const newPiece = await pr.json();
        pieces.push(newPiece);
        renderLegend();
        pieceId = String(newPiece.id);
      } catch (e) { alert('Could not connect to server.'); return; }
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
    const monday = window._currentWeekMonday;
    if (!monday) return;
    const sunday = new Date(`${monday}T00:00:00`);
    sunday.setDate(sunday.getDate() + 6);
    const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    try {
      const res = await fetch(`/api/master-blocks/occurrences?start=${monday}&end=${sundayStr}`);
      if (!res.ok) return;
      const data = await res.json();
      const occurrences    = data.occurrences    || [];
      const segmentChanges = data.segment_changes || [];

      // Clear previous week's styling only after we have the new data, so blocks
      // never flash visible during the async gap.
      document.querySelectorAll('.master-block').forEach(b => {
        b.classList.remove('block-cancelled-this-week');
        if (b.title === 'Cancelled for this week only') b.removeAttribute('title');
      });
      document.querySelectorAll('.one-time-block').forEach(b => b.remove());
      document.querySelectorAll('.day-header.has-segment-change').forEach(el => el.classList.remove('has-segment-change'));
      document.querySelectorAll('.day-column.has-segment-change').forEach(el => el.classList.remove('has-segment-change'));
      document.querySelectorAll('.segment-change-label').forEach(el => el.remove());

      const templateBlockIds = new Set(occurrences.filter(o => o.source === 'template').map(o => o.master_block_id));
      document.querySelectorAll('.master-block').forEach(blockEl => {
        if (!templateBlockIds.has(parseInt(blockEl.dataset.dbId))) {
          blockEl.classList.add('block-cancelled-this-week');
          blockEl.title = 'Cancelled for this week only';
        }
      });
      repositionAllBlocks(); // re-layout now that inactive-segment blocks are hidden
      // Moved/added occurrences have no place in the recurring template at all, so they're
      // rendered as their own read-only markers (dashed, distinct color) layered on top of
      // the regular grid rather than going through the lane/conflict system that the
      // recurring blocks use -- they're one-time, so a rare visual overlap is an acceptable
      // trade for not entangling this with repositionAllBlocks().
      occurrences.filter(o => o.source === 'moved' || o.source === 'added').forEach(renderOneTimeBlock);

      // For any schedule change that falls mid-week (not Monday), show a subtle notice
      // above the grid and a small italic label under that day's header. No column borders.
      const midWeekChanges = segmentChanges.filter(sc => {
        const idx = dayIndexInWeek(monday, sc.date);
        return idx > 0; // 0 = Monday (whole week already on new schedule), -1 = outside week
      });
      const noticeEl = document.getElementById('segment-change-notice');
      if (noticeEl) {
        if (midWeekChanges.length > 0) {
          const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
          const parts = midWeekChanges.map(sc => {
            const idx = dayIndexInWeek(monday, sc.date);
            return DAY_NAMES[idx];
          });
          const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
          noticeEl.textContent = `Schedule changes on ${joined}.`;
          noticeEl.style.display = '';
        } else {
          noticeEl.textContent = '';
          noticeEl.style.display = 'none';
        }
      }
      midWeekChanges.forEach(sc => {
        const idx = dayIndexInWeek(monday, sc.date);
        const headerCell = headerRow.children[idx + 1]; // +1 skips the time-gutter spacer
        if (headerCell) {
          const lbl = document.createElement('span');
          lbl.className   = 'segment-change-label';
          lbl.textContent = 'New schedule';
          headerCell.appendChild(lbl);
        }
      });
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
      const [datesRes, seRes] = await Promise.all([
        fetch('/api/season/production-dates'),
        fetch('/api/season/special-events'),
      ]);
      const dates  = datesRes.ok ? await datesRes.json() : {};
      const events = seRes.ok   ? await seRes.json()    : [];
      const milestones = [];
      if (dates.audition_date) milestones.push({ date: dates.audition_date, type: 'Audition' });
      events.filter(e => e.event_type === 'performance').forEach(e => milestones.push({ date: e.date, type: 'Performance' }));

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

  // ── Special Events Band ───────────────────────────────────────────────────────

  const EVENT_COLORS = {
    tech:            '#2c3e50',
    dress:           '#8e44ad',
    spacing:         '#16a085',
    photo_dress:     '#e91e63',
    performance:     '#c0392b',
    warm_up:         '#e67e22',
    costume_fitting: '#2980b9',
    company_meeting: '#0369a1',
    no_rehearsal:    '#64748b',
    notes_cleaning:  '#0d9488',
    load_in_strike:  '#b45309',
    other:           '#7f8c8d',
  };
  const EVENT_LABELS = {
    tech: 'Tech Rehearsal', dress: 'Dress Rehearsal', spacing: 'Spacing Rehearsal',
    photo_dress: 'Photo Dress', performance: 'Performance', warm_up: 'Warm Up',
    costume_fitting: 'Costume Fitting', company_meeting: 'Company Meeting',
    no_rehearsal: 'No Rehearsal / Day Off', notes_cleaning: 'Notes / Cleaning',
    load_in_strike: 'Load-In / Strike', other: 'Other',
  };

  function fmt24hBand(s) {
    if (!s) return '';
    const [h, m] = s.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  let seBandHasContent = false;

  async function applySpecialEventBand() {
    const band = document.getElementById('se-band');
    const cols  = band ? [...band.querySelectorAll('.se-band-col')] : [];
    cols.forEach(c => { c.innerHTML = ''; });
    document.querySelectorAll('.master-block, .one-time-block').forEach(el => {
      el.classList.remove('block-day-off');
      el.removeAttribute('title');
    });
    document.querySelectorAll('.day-column.day-off').forEach(el => el.classList.remove('day-off'));

    const monday = window._currentWeekMonday;
    if (!monday || !band) return;

    try {
      const [seRes, datesRes] = await Promise.all([
        fetch('/api/season/special-events'),
        fetch('/api/season/production-dates'),
      ]);

      const events = seRes.ok    ? await seRes.json()    : [];
      const dates  = datesRes.ok ? await datesRes.json() : {};

      // Audition Day milestone chip (outlined -- audition date still comes from production-dates)
      if (dates.audition_date) {
        const idx = dayIndexInWeek(monday, dates.audition_date);
        if (idx !== -1 && cols[idx]) {
          const chip = document.createElement('div');
          chip.className = 'se-chip';
          chip.title = 'Audition Day';
          chip.style.cssText = `background:${hexToRgba('#c4943a', 0.1)};border:2px solid #c4943a;`;
          chip.innerHTML = `<div style="font-size:12px;font-weight:700;color:#c4943a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Audition Day</div>`;
          cols[idx].appendChild(chip);
        }
      }

      // Special event chips (solid fill) -- Performance events now live here as special events
      events.forEach(ev => {
        const idx = dayIndexInWeek(monday, ev.date);
        if (idx === -1 || !cols[idx]) return;
        const color   = EVENT_COLORS[ev.event_type] || EVENT_COLORS.other;
        const label   = EVENT_LABELS[ev.event_type] || 'Event';
        const timeStr = [fmt24hBand(ev.start_time), fmt24hBand(ev.end_time)].filter(Boolean).join(' - ');
        const chip = document.createElement('div');
        chip.className = 'se-chip';
        chip.style.background = color;
        chip.title = [ev.title, timeStr, ev.location, ev.notes].filter(Boolean).join(' | ');
        chip.innerHTML = `
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:rgba(255,255,255,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</div>
          <div style="font-size:12px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ev.title}</div>
          ${timeStr   ? `<div style="font-size:10px;color:rgba(255,255,255,.85);">${timeStr}</div>`   : ''}
          ${ev.location ? `<div style="font-size:10px;color:rgba(255,255,255,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ev.location}</div>` : ''}`;
        cols[idx].appendChild(chip);
      });

      // Tint day columns and grey out blocks on no-rehearsal days
      events.forEach(ev => {
        if (ev.event_type !== 'no_rehearsal') return;
        const idx = dayIndexInWeek(monday, ev.date);
        if (idx === -1) return;
        const dayName = DAYS[idx];
        if (grid.children[idx]) grid.children[idx].classList.add('day-off');
        const tooltip = ev.notes
          ? `No Rehearsal / Day Off - ${ev.notes}`
          : ev.title
            ? `No Rehearsal / Day Off - ${ev.title}`
            : 'No Rehearsal / Day Off';
        document.querySelectorAll(`.master-block[data-day="${dayName}"], .one-time-block[data-day="${dayName}"]`)
          .forEach(el => { el.classList.add('block-day-off'); el.title = tooltip; });
      });

      const total = cols.reduce((n, c) => n + c.children.length, 0);
      seBandHasContent = total > 0;
      const toggle = document.getElementById('special-events-toggle');
      band.style.display = (seBandHasContent && toggle?.checked !== false) ? '' : 'none';
    } catch (e) {
      band.style.display = 'none';
    }
  }
  window.addEventListener('weekChanged', applySpecialEventBand);
  window.addEventListener('specialEventsChanged', applySpecialEventBand);

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
    const label = occ.source === 'moved' ? 'Moved' : 'OTR';
    const displayName = occ.note || (piece ? piece.name : 'Rehearsal');
    block.title = `${displayName} (${label})`;
    block.innerHTML = `
      <span style="font-size:11px;font-weight:bold;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${displayName} (${label})</span>
      <span style="font-size:10px;display:block;opacity:0.8;">${occ.start_time} – ${occ.end_time}</span>
      <button class="delete-btn" title="Remove">&times;</button>`;
    block.querySelector('.delete-btn').addEventListener('mousedown', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        const res = await fetch(`/api/master-blocks/exceptions/${occ.exception_id}`, { method: 'DELETE' });
        if (res.ok) {
          block.remove();
          applyWeekExceptionStyling();
        }
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
      if (currentBlock.classList.contains('block-day-off')) return;
      activeBlockId = currentBlock.dataset.dbId;
      originalDayBeforeDrag = currentBlock.dataset.day;
      blockWasDragged = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
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
      if (currentBlock.classList.contains('master-block')) {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) blockWasDragged = true;
      }
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
      const wasResizing   = isResizing;
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
        activeBlockId = null;
      } else if (!wasResizing && blockWasDragged) {
        // Dragged a master block — ask whether to move just this occurrence or all
        pendingDragMove = { blockEl: blockToUpdate, blockId: activeBlockId, originalDay: originalDayBeforeDrag, pos };
        activeBlockId = null;
        originalDayBeforeDrag = null;
        blockWasDragged = false;
        const timeLabel = blockToUpdate.querySelector('span:nth-child(2)');
        if (timeLabel) timeLabel.textContent = `${pos.start_time} – ${pos.end_time}`;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('moveScopeModal')).show();
      } else {
        blockWasDragged = false;
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
        activeBlockId = null;
      }
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

  // ── Move scope modal (drag: just this week vs. all occurrences) ──────────────

  async function applyDragMove(mode) {
    bootstrap.Modal.getInstance(document.getElementById('moveScopeModal'))?.hide();
    if (!pendingDragMove) return;
    const { blockEl, blockId, originalDay, pos } = pendingDragMove;
    pendingDragMove = null;

    if (mode === 'once') {
      const monday = window._currentWeekMonday || new Date().toISOString().slice(0, 10);
      const originalDate = dateForDayInWeek(monday, originalDay || pos.day);
      const newDate      = dateForDayInWeek(monday, pos.day);
      try {
        const res = await fetch(`/api/master-blocks/${blockId}/exceptions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'moved', original_date: originalDate, new_date: newDate, new_start_time: pos.start_time, new_end_time: pos.end_time }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Could not save.'); }
        repositionAllBlocks();
      } catch (err) { console.error('Move-once failed:', err); }
    } else {
      try {
        await fetch(`/api/master-blocks/${blockId}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(pos),
        });
        repositionAllBlocks();
      } catch (err) { console.error('Move-always failed:', err); }
    }
  }

  document.getElementById('move-scope-once-btn').addEventListener('click',   () => applyDragMove('once'));
  document.getElementById('move-scope-always-btn').addEventListener('click', () => applyDragMove('always'));

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
        body:    JSON.stringify({ piece_id: piece.id, day: DAYS[dayIndex], start_time: startTime, end_time: endTime, room_id: roomId, current_date: (() => { if (!window._currentWeekMonday) return new Date().toISOString().slice(0, 10); const d = new Date(window._currentWeekMonday + 'T00:00:00'); d.setDate(d.getDate() + dayIndex); return d.toISOString().slice(0, 10); })() }),
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
  applySpecialEventBand();

  // Toggle special events band
  document.getElementById('special-events-toggle')?.addEventListener('change', function () {
    const band = document.getElementById('se-band');
    if (band) band.style.display = (this.checked && seBandHasContent) ? '' : 'none';
  });

  // Toggle other-productions overlay visibility
  document.getElementById('org-blocks-toggle')?.addEventListener('change', function () {
    document.querySelectorAll('.org-overlay-block').forEach(b => {
      b.style.display = this.checked ? '' : 'none';
    });
  });

  // ── Drawer wiring ─────────────────────────────────────────────────────────────

  document.getElementById('drawer-close-btn')?.addEventListener('click', closeBlockDrawer);

  document.querySelectorAll('[data-drawer-tab]').forEach(btn => {
    btn.addEventListener('click', () => renderDrawerTab(btn.dataset.drawerTab));
  });

  document.getElementById('drawer-edit-weekly-btn')?.addEventListener('click', showChangeWeeklyForm);
  document.getElementById('drawer-cancel-change-btn')?.addEventListener('click', showNormalDrawerView);

  document.getElementById('drawer-adjust-btn')?.addEventListener('click', () => {
    deleteModalFromDrawer = true;
    openDeleteBlockModal(drawerCurrentDbId, drawerCurrentDay, document.querySelector(`.master-block[data-db-id="${drawerCurrentDbId}"]`));
  });

  document.getElementById('drawer-room-edit-btn')?.addEventListener('click', () => {
    const editForm = document.getElementById('drawer-room-edit-form');
    const select   = document.getElementById('drawer-room-inline-select');
    if (editForm && select) {
      select.innerHTML = `<option value="">No room</option>` +
        rooms.map(r => `<option value="${r.id}"${String(r.id) === String(drawerCurrentRoomId || '') ? ' selected' : ''}>${r.name}</option>`).join('');
      editForm.style.display = '';
      checkDrawerRoomConflict(drawerCurrentRoomId || '');
    }
  });

  document.getElementById('drawer-room-edit-form')?.addEventListener('change', (e) => {
    if (e.target.id === 'drawer-room-inline-select') checkDrawerRoomConflict(e.target.value);
  });

  document.getElementById('drawer-room-cancel-btn')?.addEventListener('click', () => {
    const editForm = document.getElementById('drawer-room-edit-form');
    if (editForm) editForm.style.display = 'none';
  });

  document.getElementById('drawer-room-save-btn')?.addEventListener('click', async () => {
    const select  = document.getElementById('drawer-room-inline-select');
    const newRoomId = select?.value || null;
    const saveBtn = document.getElementById('drawer-room-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
    try {
      const res = await fetch(`/api/master-blocks/${drawerCurrentDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: newRoomId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Could not update the room.');
      } else {
        drawerCurrentRoomId = newRoomId;
        const roomObj = newRoomId ? rooms.find(r => String(r.id) === String(newRoomId)) : null;
        const label = document.getElementById('drawer-room-label');
        if (label) label.textContent = roomObj ? roomObj.name : 'No room assigned';
        const blockEl = document.querySelector(`.master-block[data-db-id="${drawerCurrentDbId}"]`);
        if (blockEl) { blockEl.dataset.roomId = newRoomId || ''; repositionAllBlocks(); }
        const editForm = document.getElementById('drawer-room-edit-form');
        if (editForm) editForm.style.display = 'none';
      }
    } catch (e) { alert('Could not connect to server.'); }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  });

  document.getElementById('drawer-apply-change-btn')?.addEventListener('click', async () => {
    const dateInput  = document.getElementById('drawer-change-start-date');
    const startInput = document.getElementById('drawer-change-start-time');
    const endInput   = document.getElementById('drawer-change-end-time');
    const roomSelect = document.getElementById('drawer-change-room');
    const errorEl    = document.getElementById('drawer-change-error');

    const newDate   = dateInput?.value;
    const today     = new Date().toISOString().slice(0, 10);

    if (!newDate || newDate <= today) {
      if (errorEl) { errorEl.textContent = 'Please choose a future date.'; errorEl.style.display = ''; }
      return;
    }
    if (errorEl) errorEl.style.display = 'none';

    const newStart = startInput?.value ? inputTimeToAppTime(startInput.value) : drawerCurrentStartTime;
    const newEnd   = endInput?.value   ? inputTimeToAppTime(endInput.value)   : drawerCurrentEndTime;
    const newRoom  = roomSelect ? (roomSelect.value || null) : drawerCurrentRoomId;

    const blockChange = {};
    if (newStart !== drawerCurrentStartTime) blockChange.start_time = newStart;
    if (newEnd   !== drawerCurrentEndTime)   blockChange.end_time   = newEnd;
    if (String(newRoom || '') !== String(drawerCurrentRoomId || '')) blockChange.room_id = newRoom;

    const blockChangesArr = Object.keys(blockChange).length > 0
      ? [{ source_block_id: drawerCurrentDbId, ...blockChange }]
      : [];

    const applyBtn = document.getElementById('drawer-apply-change-btn');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying...'; }

    try {
      const res = await fetch('/api/season/segments/fork-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_start_date:   newDate,
          block_changes:    blockChangesArr,
          blocks_to_remove: [],
          blocks_to_add:    [],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (errorEl) { errorEl.textContent = data.error || 'Something went wrong.'; errorEl.style.display = ''; }
        return;
      }

      // Refresh blocks in the grid from the new segment
      const existingIds = new Set(
        [...document.querySelectorAll('.master-block')].map(el => String(el.dataset.dbId))
      );
      const blocksRes = await fetch('/api/master-blocks');
      if (blocksRes.ok) {
        const allBlocks = await blocksRes.json();
        for (const b of allBlocks) {
          if (existingIds.has(String(b.id))) continue;
          const piece = pieces.find(p => p.id === b.piece_id);
          if (!piece) continue;
          const dayIdx = DAYS.indexOf(b.day_of_week);
          if (dayIdx < 0) continue;
          const [sh, sm] = b.start_time.split(':').map(Number);
          const [eh, em] = b.end_time.split(':').map(Number);
          const topPx    = ((sh * 60 + sm) - startHour * 60) / increment * slotHeight;
          const heightPx = ((eh * 60 + em) - (sh * 60 + sm)) / increment * slotHeight;
          renderBlock(b.id, piece, topPx, heightPx, dayIdx, formatTime(sh, sm), formatTime(eh, em), b.room_id);
        }
        repositionAllBlocks();
      }

      closeBlockDrawer();
      window.dispatchEvent(new CustomEvent('weekChanged'));
      window.dispatchEvent(new CustomEvent('segmentsChanged'));
    } catch (err) {
      if (errorEl) { errorEl.textContent = 'Network error. Please try again.'; errorEl.style.display = ''; }
    } finally {
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Change'; }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBlockDrawer();
  });
});
