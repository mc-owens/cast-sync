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
    const dayWidth   = grid.clientWidth / 7;
    const topPx      = parseFloat(block.style.top);
    const heightPx   = parseFloat(block.style.height);
    const leftPx     = parseFloat(block.style.left);
    const dayIndex   = Math.max(0, Math.min(Math.round(leftPx / dayWidth), 6));
    const startSlotI = Math.round(topPx / slotHeight);
    const endSlotI   = startSlotI + Math.round(heightPx / slotHeight);
    return {
      day:        DAYS[dayIndex],
      start_time: slotToTimeString(startSlotI),
      end_time:   slotToTimeString(endSlotI),
    };
  }

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
        } catch (err) { alert('Could not connect to server.'); }
      });

      item.appendChild(dot);
      item.appendChild(name);
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
      sel.innerHTML = '<option disabled>No pieces yet — create one first</option>';
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

  // startTimeStr / endTimeStr are optional — if omitted, computed from pixels
  function renderBlock(dbId, piece, topPx, heightPx, dayIndex, startTimeStr, endTimeStr) {
    const dayWidth   = grid.clientWidth / 7;
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
    block.style.top            = `${topPx}px`;
    block.style.height         = `${Math.max(heightPx, slotHeight)}px`;
    block.style.left           = `${dayIndex * dayWidth}px`;
    block.style.width          = `${dayWidth}px`;
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

    block.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/master-blocks/${dbId}`, { method: 'DELETE' });
      block.remove();
    });

    grid.appendChild(block);
    return block;
  }

  async function loadBlocks() {
    try {
      const res = await fetch('/api/master-blocks');
      if (!res.ok) return;
      const blocks = await res.json();
      blocks.forEach(b => {
        const piece    = pieces.find(p => p.id === b.piece_id);
        if (!piece) return;
        const topPx    = timeStringToTopPx(b.start_time);
        const btmPx    = timeStringToTopPx(b.end_time);
        const dayIndex = DAYS.indexOf(b.day);
        renderBlock(b.id, piece, topPx, btmPx - topPx, dayIndex, b.start_time, b.end_time);
      });
    } catch (e) { console.error(e); }
  }

  // ── Mouse interaction ─────────────────────────────────────────────────────────

  grid.addEventListener('mousedown', e => {
    if (e.target.classList.contains('resize-handle')) {
      isResizing    = true;
      currentBlock  = e.target.closest('.block');
      activeBlockId = currentBlock?.dataset.dbId;
      resizeDir     = e.target.classList.contains('resize-top') ? 'top' : 'bottom';
      e.preventDefault();
      return;
    }

    if (e.target.closest('.master-block')) {
      currentBlock  = e.target.closest('.master-block');
      activeBlockId = currentBlock.dataset.dbId;
      offsetY       = e.clientY - currentBlock.getBoundingClientRect().top;
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
    currentBlock.style.left       = `${dayIndex * dayWidth}px`;
    currentBlock.style.width      = `${dayWidth}px`;
    currentBlock.style.top        = `${startSlot * slotHeight}px`;
    currentBlock.style.height     = `${slotHeight}px`;
    currentBlock.style.background = 'rgba(180,180,180,0.4)';
    currentBlock.style.border     = '2px dashed #999';
    currentBlock.style.position   = 'absolute';
    currentBlock.style.boxSizing  = 'border-box';
    currentBlock.style.pointerEvents = 'none';
    currentBlock.style.fontSize   = '11px';
    currentBlock.style.padding    = '2px 4px';
    currentBlock.style.color      = '#555';
    currentBlock.textContent      = '...';
    grid.appendChild(currentBlock);
  });

  grid.addEventListener('mousemove', e => {
    if (isSelecting && currentBlock) {
      const slot = e.target.closest('.time-slot');
      if (!slot) return;
      const cur     = parseInt(slot.dataset.timeIndex);
      const topSlot = Math.min(startSlot, cur);
      currentBlock.style.top    = `${topSlot * slotHeight}px`;
      currentBlock.style.height = `${(Math.abs(cur - startSlot) + 1) * slotHeight}px`;
      return;
    }

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

    if (currentBlock && currentBlock.classList.contains('master-block') && e.buttons === 1) {
      const rect     = grid.getBoundingClientRect();
      const dayWidth = grid.clientWidth / 7;
      let y = e.clientY - rect.top - offsetY;
      let x = e.clientX - rect.left;
      y = Math.round(y / slotHeight) * slotHeight;
      y = Math.max(0, Math.min(y, grid.clientHeight - parseFloat(currentBlock.style.height)));
      const dayIndex = Math.max(0, Math.min(Math.floor(x / dayWidth), 6));
      currentBlock.style.top  = `${y}px`;
      currentBlock.style.left = `${dayIndex * dayWidth}px`;
    }
  });

  document.addEventListener('mouseup', async () => {
    if (isSelecting && currentBlock) {
      isSelecting  = false;
      pendingBlock = currentBlock;
      currentBlock = null;
      populatePieceSelect();
      document.getElementById('new-piece-name').value            = '';
      document.getElementById('radio-new-piece').checked         = true;
      document.getElementById('new-piece-section').style.display = 'block';
      document.getElementById('existing-piece-section').style.display = 'none';
      new bootstrap.Modal(document.getElementById('pieceModal'), { backdrop: 'static' }).show();
      return;
    }

    if ((isResizing || (currentBlock && currentBlock.classList.contains('master-block'))) && activeBlockId) {
      const blockToUpdate = currentBlock;
      isResizing   = false;
      currentBlock = null;
      if (blockToUpdate) {
        const pos = getBlockPosition(blockToUpdate);
        // Update time label on the block
        const timeLabel = blockToUpdate.querySelector('span:nth-child(2)');
        if (timeLabel) timeLabel.textContent = `${pos.start_time} – ${pos.end_time}`;
        blockToUpdate.dataset.startTime = pos.start_time;
        blockToUpdate.dataset.endTime   = pos.end_time;
        blockToUpdate.dataset.day       = pos.day;
        try {
          await fetch(`/api/master-blocks/${activeBlockId}`, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(pos),
          });
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

  document.getElementById('radio-new-piece').addEventListener('change', () => {
    document.getElementById('new-piece-section').style.display      = 'block';
    document.getElementById('existing-piece-section').style.display = 'none';
  });
  document.getElementById('radio-existing-piece').addEventListener('change', () => {
    document.getElementById('new-piece-section').style.display      = 'none';
    document.getElementById('existing-piece-section').style.display = 'block';
  });

  // ── Modal confirm ─────────────────────────────────────────────────────────────

  document.getElementById('piece-confirm-btn').addEventListener('click', async () => {
    const isNew = document.getElementById('radio-new-piece').checked;
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

    const topPx    = parseFloat(pendingBlock.style.top);
    const heightPx = parseFloat(pendingBlock.style.height);
    const leftPx   = parseFloat(pendingBlock.style.left);
    const dayWidth = grid.clientWidth / 7;
    const dayIndex = Math.max(0, Math.min(Math.round(leftPx / dayWidth), 6));
    const startI   = Math.round(topPx / slotHeight);
    const endI     = startI + Math.round(heightPx / slotHeight);
    const startTime = slotToTimeString(startI);
    const endTime   = slotToTimeString(endI);

    try {
      const res = await fetch('/api/master-blocks', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ piece_id: piece.id, day: DAYS[dayIndex], start_time: startTime, end_time: endTime }),
      });
      if (!res.ok) { alert('Could not save block.'); return; }
      const saved = await res.json();
      pendingBlock.remove();
      pendingBlock = null;
      renderBlock(saved.id, piece, topPx, heightPx, dayIndex, startTime, endTime);
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
  await new Promise(r => requestAnimationFrame(r));
  await loadBlocks();
});
