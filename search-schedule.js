document.addEventListener('DOMContentLoaded', async () => {
  // ── Constants ─────────────────────────────────────────────────────────────────
  const startHour  = 8;
  const endHour    = 23;
  const increment  = 15;
  const slotHeight = 12.5;
  const DAYS       = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAYS_SHORT  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MINI_START  = 8 * 60;
  const MINI_END    = 23 * 60;
  const MINI_RANGE  = MINI_END - MINI_START;

  // ── DOM references ────────────────────────────────────────────────────────────
  const timeColumn = document.getElementById('time-column');
  const grid       = document.getElementById('grid');
  const headerRow  = document.getElementById('day-header-row');
  const legendEl   = document.getElementById('pieces-legend');

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

  // ── Legend ────────────────────────────────────────────────────────────────────

  function renderLegend(pieces) {
    legendEl.innerHTML = pieces.length === 0
      ? '<p class="text-muted" style="font-size:12px;">No pieces in the master schedule yet.</p>'
      : '';
    pieces.forEach(p => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
      item.innerHTML = `
        <div style="width:14px;height:14px;border-radius:3px;background:${p.color};flex-shrink:0;"></div>
        <span style="font-size:13px;">${p.name}</span>`;
      legendEl.appendChild(item);
    });
  }

  // ── Read-only block rendering ─────────────────────────────────────────────────

  function renderBlock(piece, topPx, heightPx, dayIndex, startTime, endTime) {
    const dayWidth = grid.clientWidth / 7;
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
    block.style.cursor        = 'pointer';
    block.innerHTML = `
      <span style="font-size:11px;font-weight:bold;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${piece.name}</span>
      <span style="font-size:10px;display:block;opacity:0.8;">${startTime} – ${endTime}</span>`;

    block.addEventListener('click', () => showAvailability(block));
    grid.appendChild(block);
  }

  // Split overlapping blocks in the same day into side-by-side lanes
  function repositionBlocks() {
    const dayWidth = grid.clientWidth / 7;
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

      // Greedy lane assignment (same sweep-line as master schedule)
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

  // ── Format piece schedule into clean title string ─────────────────────────────
  // Groups blocks by matching time ranges, e.g.:
  // "Monday, Wednesday, Friday 11:00 AM – 12:00 PM"

  function formatPieceSchedule(pieceBlocks) {
    const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const groups = {};
    pieceBlocks.forEach(b => {
      const key = `${b.start_time}|||${b.end_time}`;
      if (!groups[key]) groups[key] = { days: [], start: b.start_time, end: b.end_time };
      groups[key].days.push(b.day);
    });
    return Object.values(groups).map(g => {
      g.days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
      return `${g.days.join(', ')} ${g.start} – ${g.end}`;
    }).join(' | ');
  }

  // ── Availability modal ────────────────────────────────────────────────────────

  // State shared between showAvailability and sort buttons
  let _availFull    = [];
  let _availPartial = [];
  let _availPieceId = null;
  let _sortMode     = 'abc';

  function sortDancers(arr) {
    return [...arr].sort((a, b) => {
      if (_sortMode === 'num') {
        const aNum = a.audition_number != null ? Number(a.audition_number) : Infinity;
        const bNum = b.audition_number != null ? Number(b.audition_number) : Infinity;
        if (aNum !== bNum) return aNum - bNum;
      }
      // A-Z (always tiebreak)
      const lastCmp = (a.last_name || '').localeCompare(b.last_name || '');
      return lastCmp !== 0 ? lastCmp : (a.first_name || '').localeCompare(b.first_name || '');
    });
  }

  function renderAvailabilityLists() {
    const fullList    = document.getElementById('fully-available-list');
    const partialList = document.getElementById('partially-available-list');
    const noFull      = document.getElementById('no-full');
    const noPartial   = document.getElementById('no-partial');

    fullList.innerHTML    = '';
    partialList.innerHTML = '';

    const sorted = { full: sortDancers(_availFull), partial: sortDancers(_availPartial) };

    noFull.style.display = sorted.full.length === 0 ? 'block' : 'none';
    sorted.full.forEach(d => appendDancerItem(fullList, d, _availPieceId));

    noPartial.style.display = sorted.partial.length === 0 ? 'block' : 'none';
    sorted.partial.forEach(d => appendDancerItem(partialList, d, _availPieceId));
  }

  // Wire sort buttons
  document.getElementById('sort-abc').addEventListener('click', () => {
    _sortMode = 'abc';
    document.getElementById('sort-abc').classList.add('active');
    document.getElementById('sort-num').classList.remove('active');
    renderAvailabilityLists();
  });
  document.getElementById('sort-num').addEventListener('click', () => {
    _sortMode = 'num';
    document.getElementById('sort-num').classList.add('active');
    document.getElementById('sort-abc').classList.remove('active');
    renderAvailabilityLists();
  });

  async function showAvailability(block) {
    const pieceId   = block.dataset.pieceId;
    const pieceName = block.dataset.pieceName;

    const fullList    = document.getElementById('fully-available-list');
    const partialList = document.getElementById('partially-available-list');
    const noFull      = document.getElementById('no-full');
    const noPartial   = document.getElementById('no-partial');

    document.getElementById('avail-modal-title').textContent = pieceName;
    fullList.innerHTML      = '<li class="text-muted" style="font-size:13px;">Loading...</li>';
    partialList.innerHTML   = '';
    noFull.style.display    = 'none';
    noPartial.style.display = 'none';

    // Reset sort to A-Z each time a new piece is opened
    _sortMode = 'abc';
    document.getElementById('sort-abc').classList.add('active');
    document.getElementById('sort-num').classList.remove('active');

    const modal = new bootstrap.Modal(document.getElementById('availabilityModal'));
    modal.show();

    try {
      const res  = await fetch(`/api/availability/piece/${pieceId}`);
      const data = await res.json();

      // Update title with formatted schedule
      if (data.piece_blocks && data.piece_blocks.length > 0) {
        document.getElementById('avail-modal-title').textContent =
          `${pieceName} — ${formatPieceSchedule(data.piece_blocks)}`;
      }

      _availFull    = data.fully_available;
      _availPartial = data.partially_available;
      _availPieceId = pieceId;

      fullList.innerHTML = '';
      renderAvailabilityLists();
    } catch (err) {
      fullList.innerHTML = '<li class="text-danger" style="font-size:13px;">Could not load availability.</li>';
      console.error(err);
    }
  }

  // Renders a clickable dancer name + toggleable cast/understudy buttons
  function appendDancerItem(listEl, dancer, pieceId) {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';

    const link = document.createElement('span');
    link.textContent   = dancer.audition_number
      ? `#${dancer.audition_number} — ${dancer.first_name} ${dancer.last_name}`
      : `${dancer.first_name} ${dancer.last_name}`;
    link.style.cssText = 'cursor:pointer;text-decoration:underline;color:#0d6efd;font-size:13px;flex:1;';
    link.title         = 'Click to view schedule';
    link.addEventListener('click', () => {
      bootstrap.Modal.getInstance(document.getElementById('availabilityModal')).hide();
      document.getElementById('availabilityModal').addEventListener(
        'hidden.bs.modal',
        () => openDancerModal(dancer.id),
        { once: true }
      );
    });

    const castBtn = document.createElement('button');
    castBtn.style.cssText = 'font-size:11px;padding:1px 7px;line-height:1.5;';

    const understudyBtn = document.createElement('button');
    understudyBtn.style.cssText = 'font-size:11px;padding:1px 7px;line-height:1.5;';

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
    btnGroup.appendChild(castBtn);
    btnGroup.appendChild(understudyBtn);
    li.appendChild(link);
    li.appendChild(btnGroup);
    listEl.appendChild(li);

    // Mutable per-row state
    let currentRole   = dancer.cast_role; // null | 'member' | 'understudy'
    let currentCastId = dancer.cast_id;   // piece_casts.id or null

    function renderBtns() {
      if (currentRole === 'member') {
        castBtn.textContent = '✓ Cast';
        castBtn.className   = 'btn btn-success';
        castBtn.title       = 'Click to remove from cast';
        castBtn.style.display = '';
        castBtn.onclick     = removeFromCast;
        understudyBtn.textContent = '→ Understudy';
        understudyBtn.className   = 'btn btn-outline-warning';
        understudyBtn.title       = 'Switch to understudy';
        understudyBtn.style.display = '';
        understudyBtn.onclick     = () => setCast('understudy');
      } else if (currentRole === 'understudy') {
        castBtn.textContent = '→ Cast';
        castBtn.className   = 'btn btn-outline-primary';
        castBtn.title       = 'Switch to cast member';
        castBtn.style.display = '';
        castBtn.onclick     = () => setCast('member');
        understudyBtn.textContent = '✓ Understudy';
        understudyBtn.className   = 'btn btn-warning';
        understudyBtn.title       = 'Click to remove from understudies';
        understudyBtn.style.display = '';
        understudyBtn.onclick     = removeFromCast;
      } else {
        castBtn.textContent = '+ Cast';
        castBtn.className   = 'btn btn-outline-primary';
        castBtn.title       = '';
        castBtn.style.display = '';
        castBtn.onclick     = () => setCast('member');
        understudyBtn.textContent = '+ Understudy';
        understudyBtn.className   = 'btn btn-outline-warning';
        understudyBtn.title       = '';
        understudyBtn.style.display = '';
        understudyBtn.onclick     = () => setCast('understudy');
      }
    }

    async function setCast(role) {
      castBtn.disabled = true;
      understudyBtn.disabled = true;
      try {
        const res = await fetch('/api/piece-casts', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ piece_id: parseInt(pieceId), user_id: dancer.id, cast_role: role }),
        });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error || 'Failed to update cast.');
          return;
        }
        const data  = await res.json();
        currentRole   = role;
        currentCastId = data.id;
        renderBtns();
      } catch (err) {
        console.error(err);
        alert('Failed to update cast.');
      } finally {
        castBtn.disabled = false;
        understudyBtn.disabled = false;
      }
    }

    async function removeFromCast() {
      if (!currentCastId) return;
      castBtn.disabled = true;
      understudyBtn.disabled = true;
      try {
        const res = await fetch(`/api/piece-casts/${currentCastId}`, { method: 'DELETE' });
        if (!res.ok) { alert('Could not remove dancer.'); return; }
        currentRole   = null;
        currentCastId = null;
        renderBtns();
      } catch (err) {
        console.error(err);
      } finally {
        castBtn.disabled = false;
        understudyBtn.disabled = false;
      }
    }

    renderBtns();
  }

  // ── Dancer profile modal ──────────────────────────────────────────────────────

  async function openDancerModal(id) {
    try {
      const res    = await fetch(`/api/dancers/${id}`);
      const dancer = await res.json();
      document.getElementById('dancer-modal-name').textContent =
        `${dancer.first_name} ${dancer.last_name}`;
      renderMiniSchedule(dancer.availability || []);
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
        const startMin    = timeStringToMinutes(block.startTime);
        const endMin      = timeStringToMinutes(block.endTime);
        const clampStart  = Math.max(startMin, MINI_START);
        const clampEnd    = Math.min(endMin, MINI_END);
        if (clampStart >= clampEnd) return;
        const topPct    = ((clampStart - MINI_START) / MINI_RANGE) * 100;
        const heightPct = ((clampEnd - clampStart) / MINI_RANGE) * 100;
        const blockEl   = document.createElement('div');
        blockEl.style.cssText = `position:absolute;left:2px;right:2px;top:${topPct}%;height:${heightPct}%;min-height:2px;background:rgba(52,152,219,0.55);border:1px solid #3498db;border-radius:2px;`;
        blockEl.title = `${block.startTime} – ${block.endTime}`;
        blockArea.appendChild(blockEl);
      });

      col.appendChild(blockArea);
      wrapper.appendChild(col);
    });
    container.appendChild(wrapper);
  }

  function timeStringToMinutes(timeStr) {
    const [time, ampm] = timeStr.trim().split(' ');
    const [h, m]       = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }

  function populateDancerDetails(dancer) {
    document.getElementById('detail-email').textContent     = dancer.email             || '—';
    document.getElementById('detail-phone').textContent     = dancer.phone             || '—';
    document.getElementById('detail-address').textContent   = dancer.address           || '—';
    document.getElementById('detail-grade').textContent     = dancer.grade             || '—';
    document.getElementById('detail-technique').textContent = dancer.technique_classes || '—';
    document.getElementById('detail-injuries').textContent  = dancer.injuries          || '—';
    document.getElementById('detail-absences').textContent  = dancer.absences          || '—';
  }

  // ── Load and render everything ────────────────────────────────────────────────

  try {
    const [piecesRes, blocksRes] = await Promise.all([
      fetch('/api/pieces'),
      fetch('/api/master-blocks'),
    ]);

    if (!piecesRes.ok || !blocksRes.ok) {
      document.getElementById('no-schedule-msg').classList.remove('d-none');
      document.getElementById('schedule-content').classList.add('d-none');
      return;
    }

    const pieces = await piecesRes.json();
    const blocks = await blocksRes.json();

    if (pieces.length === 0 && blocks.length === 0) {
      document.getElementById('no-schedule-msg').classList.remove('d-none');
      document.getElementById('schedule-content').classList.add('d-none');
      return;
    }

    renderLegend(pieces);
    await new Promise(r => requestAnimationFrame(r)); // wait for grid layout

    blocks.forEach(b => {
      const piece    = pieces.find(p => p.id === b.piece_id);
      if (!piece) return;
      const topPx    = timeStringToTopPx(b.start_time);
      const btmPx    = timeStringToTopPx(b.end_time);
      const dayIndex = DAYS.indexOf(b.day);
      renderBlock(piece, topPx, btmPx - topPx, dayIndex, b.start_time, b.end_time);
    });

    repositionBlocks();

  } catch (err) {
    console.error(err);
    document.getElementById('no-schedule-msg').classList.remove('d-none');
    document.getElementById('schedule-content').classList.add('d-none');
  }
});
