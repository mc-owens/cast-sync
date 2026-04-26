document.addEventListener("DOMContentLoaded", () => {
  const DAYS        = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const START_HOUR  = 8;
  const END_HOUR    = 23;
  const INCREMENT   = 15;
  const SLOT_HEIGHT = 12.5;

  // Touch device or narrow screen → mobile dropdown UI
  const isMobile = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth < 1024;

  if (isMobile) {
    window._mobileAvailUI = true;
    initMobileUI();
  } else {
    initDesktopGrid();
  }

  // ─── Desktop drag grid ────────────────────────────────────────────────────
  function initDesktopGrid() {
    const timeColumn = document.getElementById('time-column');
    const grid       = document.getElementById('grid');
    const headerRow  = document.getElementById('day-header-row');

    // Header row
    headerRow.appendChild(document.createElement('div'));
    DAYS.forEach(day => {
      const header = document.createElement('div');
      header.className = 'day-header';
      header.textContent = day;
      headerRow.appendChild(header);
    });

    // Time column
    for (let h = START_HOUR; h <= END_HOUR; h++) {
      const label = document.createElement('div');
      label.className = 'time-label';
      label.textContent = fmt(h, 0);
      timeColumn.appendChild(label);
    }

    // Grid columns
    DAYS.forEach(() => {
      const col = document.createElement('div');
      col.className = 'day-column';
      const totalSlots = ((END_HOUR + 1 - START_HOUR) * 60) / INCREMENT;
      for (let i = 0; i < totalSlots; i++) {
        const slot = document.createElement('div');
        slot.className = 'time-slot';
        if (i % 4 === 3) slot.classList.add('hour-line');
        slot.dataset.timeIndex = i;
        col.appendChild(slot);
      }
      grid.appendChild(col);
    });

    // Interaction
    let isSelecting = false, startSlot = 0, currentBlock = null;
    let isResizing = false, resizeDirection = null, offsetY = 0;

    grid.addEventListener('mousedown', e => {
      if (e.target.classList.contains('resize-handle')) {
        isResizing = true;
        currentBlock = e.target.parentElement;
        resizeDirection = e.target.classList.contains('resize-top') ? 'top' : 'bottom';
        return;
      }
      if (e.target.classList.contains('block')) {
        currentBlock = e.target;
        offsetY = e.offsetY;
        return;
      }
      const slot = e.target.closest('.time-slot');
      if (!slot) return;
      isSelecting = true;
      startSlot = parseInt(slot.dataset.timeIndex);
      const dayIndex = Array.from(grid.children).indexOf(slot.parentElement);
      const dayWidth = grid.clientWidth / 7;
      currentBlock = document.createElement('div');
      currentBlock.className = 'block';
      currentBlock.dataset.startIndex = startSlot;
      currentBlock.style.left   = `${dayIndex * dayWidth}px`;
      currentBlock.style.top    = `${startSlot * SLOT_HEIGHT}px`;
      currentBlock.style.height = `${SLOT_HEIGHT}px`;
      currentBlock.style.width  = `${dayWidth}px`;
      currentBlock.innerHTML = `<span class="time-label-text"></span><span class="delete-btn">✕</span><div class="resize-handle resize-top"></div><div class="resize-handle resize-bottom"></div>`;
      grid.appendChild(currentBlock);
      updateLabel(currentBlock);
    });

    grid.addEventListener('mousemove', e => {
      if (isSelecting && currentBlock) {
        const slot = e.target.closest('.time-slot');
        if (!slot) return;
        const cur = parseInt(slot.dataset.timeIndex);
        const top = Math.min(startSlot, cur);
        currentBlock.style.top    = `${top * SLOT_HEIGHT}px`;
        currentBlock.style.height = `${(Math.abs(cur - startSlot) + 1) * SLOT_HEIGHT}px`;
        currentBlock.dataset.startIndex = top;
        updateLabel(currentBlock);
      }
      if (isResizing && currentBlock) {
        const rect = grid.getBoundingClientRect();
        let y = Math.round((e.clientY - rect.top) / SLOT_HEIGHT) * SLOT_HEIGHT;
        const bTop = parseFloat(currentBlock.style.top);
        const bH   = parseFloat(currentBlock.style.height);
        if (resizeDirection === 'top') {
          const newTop = Math.min(y, bTop + bH - SLOT_HEIGHT);
          currentBlock.style.top    = `${newTop}px`;
          currentBlock.style.height = `${bH + (bTop - newTop)}px`;
          currentBlock.dataset.startIndex = Math.round(newTop / SLOT_HEIGHT);
        } else {
          currentBlock.style.height = `${Math.max(y - bTop, SLOT_HEIGHT)}px`;
        }
        updateLabel(currentBlock);
      }
      if (currentBlock && !isResizing && !isSelecting && e.buttons === 1 && offsetY) {
        const rect = grid.getBoundingClientRect();
        let y = Math.round((e.clientY - rect.top - offsetY) / SLOT_HEIGHT) * SLOT_HEIGHT;
        y = Math.max(0, Math.min(y, grid.clientHeight - parseFloat(currentBlock.style.height)));
        currentBlock.style.top = `${y}px`;
        currentBlock.dataset.startIndex = Math.round(y / SLOT_HEIGHT);
        updateLabel(currentBlock);
      }
    });

    document.addEventListener('mouseup', () => {
      isSelecting = false; isResizing = false; offsetY = 0; currentBlock = null;
    });

    grid.addEventListener('click', e => {
      if (e.target.classList.contains('delete-btn')) e.target.parentElement.remove();
    });

    function updateLabel(block) {
      const si = parseInt(block.dataset.startIndex);
      const ei = si + Math.round(parseFloat(block.style.height) / SLOT_HEIGHT);
      block.querySelector('.time-label-text').textContent =
        `${fmt2(si * INCREMENT + START_HOUR * 60)} - ${fmt2(ei * INCREMENT + START_HOUR * 60)}`;
    }
  }

  // ─── Mobile dropdown UI ───────────────────────────────────────────────────
  function initMobileUI() {
    const wrapper = document.querySelector('.schedule-wrapper');
    if (!wrapper) return;

    // Build time option list: 8:00 AM → 11:45 PM in 15-min steps
    const timeOpts = [];
    for (let mins = START_HOUR * 60; mins <= END_HOUR * 60 + 45; mins += INCREMENT) {
      timeOpts.push({ label: fmt2(mins), mins });
    }

    function makeSelect(defaultMins) {
      const sel = document.createElement('select');
      sel.className = 'form-select form-select-sm mob-time-select';
      sel.style.cssText = 'width:auto;min-width:110px;font-size:13px;';
      timeOpts.forEach(({ label, mins }) => {
        const opt = document.createElement('option');
        opt.value = mins;
        opt.textContent = label;
        if (mins === defaultMins) opt.selected = true;
        sel.appendChild(opt);
      });
      return sel;
    }

    function addSlot(slotsEl, fromMins, toMins) {
      const row = document.createElement('div');
      row.className = 'mob-slot';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;';

      const fromSel = makeSelect(fromMins ?? 9 * 60);   // default 9:00 AM
      const toSel   = makeSelect(toMins   ?? 10 * 60);  // default 10:00 AM

      const sep = document.createElement('span');
      sep.textContent = 'to';
      sep.style.cssText = 'font-size:13px;color:#6b7280;';

      const del = document.createElement('button');
      del.type = 'button';
      del.innerHTML = '&times;';
      del.setAttribute('aria-label', 'Remove');
      del.style.cssText = 'background:none;border:none;color:#9ca3af;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;flex-shrink:0;';
      del.addEventListener('click', () => row.remove());

      row.appendChild(fromSel);
      row.appendChild(sep);
      row.appendChild(toSel);
      row.appendChild(del);
      slotsEl.appendChild(row);
    }

    // Replace wrapper contents with mobile UI
    wrapper.innerHTML = '';
    wrapper.style.cssText = 'box-shadow:none;border-radius:0;overflow:visible;border:none;';

    const container = document.createElement('div');
    container.id = 'mobile-availability';

    DAYS.forEach(day => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;padding:12px 0;border-bottom:1px solid #e5e7eb;';

      const dayLabel = document.createElement('div');
      dayLabel.style.cssText = 'width:96px;font-size:13px;font-weight:600;color:#374151;padding-top:7px;flex-shrink:0;';
      dayLabel.textContent = day;

      const right = document.createElement('div');
      right.style.cssText = 'flex:1;min-width:0;';

      const slotsEl = document.createElement('div');
      slotsEl.className = 'mob-slots';
      slotsEl.dataset.day = day;

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '+ Add time';
      addBtn.style.cssText = 'background:none;border:none;font-size:12px;font-weight:600;color:#c4943a;cursor:pointer;padding:4px 0;margin-top:2px;display:block;';
      addBtn.addEventListener('click', () => addSlot(slotsEl));

      right.appendChild(slotsEl);
      right.appendChild(addBtn);
      row.appendChild(dayLabel);
      row.appendChild(right);
      container.appendChild(row);
    });

    wrapper.appendChild(container);

    // ── Public API used by app.js and auditionForm.html inline script ─────────
    window._getMobileAvailability = () => {
      const result = [];
      container.querySelectorAll('.mob-slots').forEach(slotsEl => {
        const day = slotsEl.dataset.day;
        slotsEl.querySelectorAll('.mob-slot').forEach(slot => {
          const sels = slot.querySelectorAll('.mob-time-select');
          if (sels.length < 2) return;
          const fromMins = parseInt(sels[0].value);
          const toMins   = parseInt(sels[1].value);
          if (isNaN(fromMins) || isNaN(toMins) || toMins <= fromMins) return;
          result.push({ day, startMins: fromMins, endMins: toMins });
        });
      });
      return result;
    };

    window._setMobileAvailability = (slots) => {
      container.querySelectorAll('.mob-slots').forEach(el => el.innerHTML = '');
      slots.forEach(({ day, startMins, endMins }) => {
        const slotsEl = container.querySelector(`.mob-slots[data-day="${day}"]`);
        if (slotsEl) addSlot(slotsEl, startMins, endMins);
      });
    };

    window._clearMobileAvailability = () => {
      container.querySelectorAll('.mob-slots').forEach(el => el.innerHTML = '');
    };
  }

  // ─── Shared time formatting helpers ──────────────────────────────────────
  function fmt(h, m) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${m.toString().padStart(2,'0')} ${ampm}`;
  }
  function fmt2(totalMins) {
    return fmt(Math.floor(totalMins / 60), totalMins % 60);
  }
});
