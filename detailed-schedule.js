(function () {
  const DAYS        = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const START_HOUR  = 8;
  const END_HOUR    = 23; // window ends here exclusive (11:00 PM), matching server.js's
                          // AVAILABILITY_WINDOW_END exactly. Unlike the simple grid, this
                          // intentionally does not extend to midnight, since "12:00 AM" as
                          // a label is ambiguous between start-of-day and end-of-day once
                          // re-parsed, and a window ending at a plain hour avoids that.
  const INCREMENT   = 15;
  const SLOT_HEIGHT = 12.5;
  const TOTAL_SLOTS = ((END_HOUR - START_HOUR) * 60) / INCREMENT; // 60, 8:00 AM through 11:00 PM

  // Fixed ids, matching server.js's AVAILABILITY_CATEGORIES exactly. These are what
  // gets stored, never the display label. If a future single-day mobile paint grid
  // gets built, it only needs to read/write this same array shape; nothing else changes.
  const CATEGORIES = [
    { id: 'academic_class', label: 'Academic Class',         color: '#3498db' },
    { id: 'dance_class',    label: 'Dance Class',             color: '#9b59b6' },
    { id: 'work',           label: 'Work',                    color: '#e67e22' },
    { id: 'available',      label: 'Available To Rehearse',   color: '#2ecc71' },
    { id: 'other',          label: 'Other',                   color: '#95a5a6' },
  ];
  const CATEGORY_BY_ID = {};
  CATEGORIES.forEach(c => { CATEGORY_BY_ID[c.id] = c; });

  let originalWrapperHtml = null;
  let dayStates = null; // { Monday: Array(64) of category-id-or-null, ... }, the source of truth
  let dayLabels = null; // { Monday: Array(64) of label-string-or-null, ... }
  let selectedCategory = null;
  let mouseupHandler = null;
  let recolorAllSlots = null;     // set by initDesktopGrid; repaints all slots from dayStates/dayLabels
  let addMobileRow = null;        // set by initMobileUI; (day, fromMins, toMins, categoryId, label) => void
  let clearMobileRows = null;     // set by initMobileUI

  function fmt(h, m) {
    // h can be 24 when a block runs to the very end of the window (midnight); wrap it
    // back to 0 first so that case formats as "12:00 AM" instead of "12:00 PM".
    const hWrapped = h % 24;
    const ampm = hWrapped >= 12 ? 'PM' : 'AM';
    const hr = hWrapped % 12 === 0 ? 12 : hWrapped % 12;
    return `${hr}:${m.toString().padStart(2,'0')} ${ampm}`;
  }
  function fmt2(totalMins) {
    return fmt(Math.floor(totalMins / 60), totalMins % 60);
  }
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function freshSlotMap(fill) {
    const obj = {};
    DAYS.forEach(d => { obj[d] = Array(TOTAL_SLOTS).fill(fill); });
    return obj;
  }

  // Coalesces a day's slot array into the canonical {day,startTime,endTime,category,label}
  // shape, merging contiguous slots only when BOTH category and label match. A label
  // change mid-run starts a new block even if the category didn't change.
  function coalesceDay(day) {
    const states = dayStates[day], labels = dayLabels[day];
    const blocks = [];
    let i = 0;
    while (i < TOTAL_SLOTS) {
      if (!states[i]) { i++; continue; }
      const cat = states[i], lbl = labels[i];
      let j = i + 1;
      while (j < TOTAL_SLOTS && states[j] === cat && labels[j] === lbl) j++;
      blocks.push({
        day,
        startTime: fmt2(i * INCREMENT + START_HOUR * 60),
        endTime:   fmt2(j * INCREMENT + START_HOUR * 60),
        category:  cat,
        label:     lbl || undefined,
      });
      i = j;
    }
    return blocks;
  }

  function updateCoverageStatus() {
    const statusEl = document.getElementById('detailed-coverage-status');
    if (!statusEl || !dayStates) return;
    let remaining = 0;
    DAYS.forEach(day => dayStates[day].forEach(v => { if (!v) remaining++; }));
    statusEl.textContent = remaining === 0 ? 'Full week accounted for.' : `${remaining} slot${remaining === 1 ? '' : 's'} left to fill in.`;
    statusEl.style.color = remaining === 0 ? '#198754' : '#888';
  }

  // ─── Desktop paint grid ───────────────────────────────────────────────────
  function initDesktopGrid() {
    const wrapper = document.querySelector('.schedule-wrapper');
    if (!wrapper) return;
    dayStates = freshSlotMap(null);
    dayLabels = freshSlotMap(null);
    selectedCategory = null;

    wrapper.innerHTML = `
      <div id="detailed-toolbar" style="padding:10px 12px;border-bottom:1px solid var(--border);background:#fafafa;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;" id="detailed-category-buttons"></div>
        <input type="text" id="detailed-label-input" class="form-control form-control-sm d-inline-block" style="max-width:260px;" placeholder="Optional label (e.g. after-school activity)">
        <span id="detailed-coverage-status" style="margin-left:10px;font-size:12px;color:#888;"></span>
        <span id="detailed-hover-time" style="margin-left:10px;font-size:12px;color:#555;font-weight:600;"></span>
      </div>
      <div class="day-header-row" id="day-header-row"></div>
      <div class="schedule-container">
        <div class="time-column" id="time-column"></div>
        <div class="grid" id="grid"></div>
      </div>
    `;

    const catButtonsEl = document.getElementById('detailed-category-buttons');
    CATEGORIES.forEach(cat => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm category-btn';
      btn.dataset.categoryId = cat.id;
      btn.textContent = cat.label;
      btn.style.cssText = `border:2px solid ${cat.color};color:${cat.color};background:#fff;`;
      btn.addEventListener('click', () => {
        selectedCategory = cat.id;
        document.querySelectorAll('#detailed-category-buttons .category-btn').forEach(b => {
          const c = CATEGORY_BY_ID[b.dataset.categoryId];
          const active = b.dataset.categoryId === cat.id;
          b.style.background = active ? c.color : '#fff';
          b.style.color = active ? '#fff' : c.color;
        });
        const labelInp = document.getElementById('detailed-label-input');
        if (cat.id === 'available') {
          labelInp.placeholder = 'Optional label (e.g. after-school activity)';
          labelInp.classList.remove('is-invalid');
        } else {
          labelInp.placeholder = 'Label required (e.g. AP Bio, Babysitting)';
        }
      });
      catButtonsEl.appendChild(btn);
    });

    const headerRow = document.getElementById('day-header-row');
    headerRow.appendChild(document.createElement('div'));
    DAYS.forEach(day => {
      const h = document.createElement('div');
      h.className = 'day-header';
      h.textContent = day;
      headerRow.appendChild(h);
    });

    const timeColumn = document.getElementById('time-column');
    for (let h = START_HOUR; h < END_HOUR; h++) {
      const label = document.createElement('div');
      label.className = 'time-label';
      label.textContent = fmt(h, 0);
      timeColumn.appendChild(label);
    }

    const grid = document.getElementById('grid');
    DAYS.forEach(day => {
      const col = document.createElement('div');
      col.className = 'day-column';
      col.dataset.day = day;
      for (let i = 0; i < TOTAL_SLOTS; i++) {
        const slot = document.createElement('div');
        slot.className = 'time-slot detailed-slot';
        if (i % 4 === 3) slot.classList.add('hour-line');
        slot.dataset.slotIndex = i;
        col.appendChild(slot);
      }
      grid.appendChild(col);
    });

    function recolorSlot(day, idx) {
      const slotEl = grid.querySelector(`.day-column[data-day="${day}"] .time-slot[data-slot-index="${idx}"]`);
      if (!slotEl) return;
      const category = dayStates[day][idx], label = dayLabels[day][idx];
      if (!category) { slotEl.style.background = ''; slotEl.title = ''; return; }
      const cat = CATEGORY_BY_ID[category];
      slotEl.style.background = hexToRgba(cat.color, 0.55);
      slotEl.title = cat.label + (label ? `: ${label}` : '');
    }

    // The background color on each 12.5px slot already shows category at a glance, but
    // a hover-only tooltip is too easy to miss for the label, which is meant to actually
    // be read later (e.g. a director seeing "Work: across-campus class" and understanding
    // why someone might run late). Overlay the label as real text on each merged run.
    function renderDayOverlays(day) {
      const col = grid.querySelector(`.day-column[data-day="${day}"]`);
      if (!col) return;
      col.querySelectorAll('.detailed-block-label').forEach(el => el.remove());
      coalesceDay(day).forEach(block => {
        if (!block.label) return;
        const startIdx = Math.round((timeToMinutes(block.startTime) - START_HOUR * 60) / INCREMENT);
        const endIdx   = Math.round((timeToMinutes(block.endTime)   - START_HOUR * 60) / INCREMENT);
        if (endIdx - startIdx < 2) return; // not enough room to show readable text
        const overlay = document.createElement('div');
        overlay.className = 'detailed-block-label';
        overlay.style.cssText = `position:absolute;left:2px;right:2px;top:${startIdx * SLOT_HEIGHT}px;height:${(endIdx - startIdx) * SLOT_HEIGHT}px;pointer-events:none;overflow:hidden;font-size:10px;line-height:1.25;font-weight:600;color:#1f2937;padding:2px 4px;`;
        overlay.textContent = block.label;
        col.appendChild(overlay);
      });
    }

    function paintSlot(slotEl) {
      const day = slotEl.parentElement.dataset.day;
      const idx = parseInt(slotEl.dataset.slotIndex);
      const labelInp = document.getElementById('detailed-label-input');
      const labelVal = labelInp.value.trim();
      if (selectedCategory !== 'available' && !labelVal) {
        labelInp.classList.add('is-invalid');
        labelInp.focus();
        setTimeout(() => labelInp.classList.remove('is-invalid'), 2000);
        return;
      }
      dayStates[day][idx] = selectedCategory;
      dayLabels[day][idx] = labelVal || null;
      recolorSlot(day, idx);
      renderDayOverlays(day);
      updateCoverageStatus();
    }

    // Sunday's slots are a full week's width away from the time-column on the left, so
    // hovering them gives no easy way to tell what time you're looking at without
    // counting rows. Show it as text instead of making people line things up visually.
    const hoverTimeEl = document.getElementById('detailed-hover-time');
    function showHoverTime(slotEl) {
      const day = slotEl.parentElement.dataset.day;
      const idx = parseInt(slotEl.dataset.slotIndex);
      const start = fmt2(idx * INCREMENT + START_HOUR * 60);
      const end   = fmt2((idx + 1) * INCREMENT + START_HOUR * 60);
      hoverTimeEl.textContent = `${day}, ${start} - ${end}`;
    }

    let isPainting = false;
    grid.addEventListener('mousedown', e => {
      const slot = e.target.closest('.time-slot');
      if (!slot) return;
      if (!selectedCategory) { alert('Pick a category above first, then click or drag to paint your schedule.'); return; }
      isPainting = true;
      paintSlot(slot);
      showHoverTime(slot);
    });
    grid.addEventListener('mousemove', e => {
      const slot = e.target.closest('.time-slot');
      if (!slot) return;
      showHoverTime(slot);
      if (isPainting) paintSlot(slot);
    });
    grid.addEventListener('mouseleave', () => { if (!isPainting) hoverTimeEl.textContent = ''; });
    mouseupHandler = () => { isPainting = false; };
    document.addEventListener('mouseup', mouseupHandler);

    recolorAllSlots = () => DAYS.forEach(day => {
      for (let i = 0; i < TOTAL_SLOTS; i++) recolorSlot(day, i);
      renderDayOverlays(day);
    });
    updateCoverageStatus();
  }

  // ─── Mobile extended dropdown UI ─────────────────────────────────────────
  function initMobileUI() {
    const wrapper = document.querySelector('.schedule-wrapper');
    if (!wrapper) return;
    window._detailedMobileUI = true;

    const timeOpts = [];
    for (let mins = START_HOUR * 60; mins <= END_HOUR * 60; mins += INCREMENT) {
      timeOpts.push({ label: fmt2(mins), mins });
    }

    function makeTimeSelect(extraClass, defaultMins) {
      const sel = document.createElement('select');
      sel.className = `form-select form-select-sm mob-time-select ${extraClass}`;
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

    function makeCategorySelect(defaultId) {
      const sel = document.createElement('select');
      sel.className = 'form-select form-select-sm detailed-category-select';
      sel.style.cssText = 'width:auto;min-width:170px;font-size:13px;';
      CATEGORIES.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.label;
        if (cat.id === defaultId) opt.selected = true;
        sel.appendChild(opt);
      });
      return sel;
    }

    function addRow(slotsEl, fromMins, toMins, categoryId, label) {
      const row = document.createElement('div');
      row.className = 'detailed-mob-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;';

      const fromSel = makeTimeSelect('mob-time-from', fromMins ?? 9 * 60);
      const toSel   = makeTimeSelect('mob-time-to', toMins ?? 10 * 60);
      const sep = document.createElement('span');
      sep.textContent = 'to';
      sep.style.cssText = 'font-size:13px;color:#6b7280;';
      const catSel = makeCategorySelect(categoryId || 'available');
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'form-control form-control-sm detailed-label-input';
      labelInput.style.cssText = 'width:auto;min-width:130px;font-size:13px;';
      labelInput.value = label || '';

      function syncLabelRequired() {
        const needsLabel = catSel.value !== 'available';
        labelInput.placeholder = needsLabel ? 'Label required' : 'Label (optional)';
        labelInput.required = needsLabel;
      }
      catSel.addEventListener('change', syncLabelRequired);
      syncLabelRequired();

      const del = document.createElement('button');
      del.type = 'button';
      del.innerHTML = '&times;';
      del.setAttribute('aria-label', 'Remove');
      del.style.cssText = 'background:none;border:none;color:#9ca3af;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;flex-shrink:0;';
      del.addEventListener('click', () => row.remove());

      row.append(fromSel, sep, toSel, catSel, labelInput, del);
      slotsEl.appendChild(row);
    }

    addMobileRow = (day, fromMins, toMins, categoryId, label) => {
      const slotsEl = document.querySelector(`.detailed-mob-day-slots[data-day="${day}"]`);
      if (slotsEl) addRow(slotsEl, fromMins, toMins, categoryId, label);
    };
    clearMobileRows = () => {
      document.querySelectorAll('.detailed-mob-day-slots').forEach(el => { el.innerHTML = ''; });
    };

    wrapper.innerHTML = '';
    wrapper.style.cssText = 'box-shadow:none;border-radius:0;overflow:visible;border:none;';

    const container = document.createElement('div');
    container.id = 'detailed-mobile-availability';

    DAYS.forEach(day => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;padding:12px 0;border-bottom:1px solid #e5e7eb;';

      const dayLabel = document.createElement('div');
      dayLabel.style.cssText = 'width:96px;font-size:13px;font-weight:600;color:#374151;padding-top:7px;flex-shrink:0;';
      dayLabel.textContent = day;

      const right = document.createElement('div');
      right.style.cssText = 'flex:1;min-width:0;';

      const slotsEl = document.createElement('div');
      slotsEl.className = 'detailed-mob-day-slots';
      slotsEl.dataset.day = day;

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '+ Add time';
      addBtn.style.cssText = 'background:none;border:none;font-size:12px;font-weight:600;color:#c4943a;cursor:pointer;padding:4px 0;margin-top:2px;display:block;';
      addBtn.addEventListener('click', () => addRow(slotsEl));

      right.appendChild(slotsEl);
      right.appendChild(addBtn);
      row.appendChild(dayLabel);
      row.appendChild(right);
      container.appendChild(row);
    });

    wrapper.appendChild(container);
  }

  function getDetailedMobileRows() {
    const container = document.getElementById('detailed-mobile-availability');
    if (!container) return [];
    const result = [];
    container.querySelectorAll('.detailed-mob-day-slots').forEach(slotsEl => {
      const day = slotsEl.dataset.day;
      slotsEl.querySelectorAll('.detailed-mob-row').forEach(row => {
        const fromMins = parseInt(row.querySelector('.mob-time-from').value);
        const toMins   = parseInt(row.querySelector('.mob-time-to').value);
        const category = row.querySelector('.detailed-category-select').value;
        const label    = row.querySelector('.detailed-label-input').value.trim() || undefined;
        if (isNaN(fromMins) || isNaN(toMins) || toMins <= fromMins) return;
        result.push({ day, startTime: fmt2(fromMins), endTime: fmt2(toMins), category, label });
      });
    });
    return result;
  }

  // Seeds a previously-saved (or drafted) blocks array back into whichever UI is
  // currently mounted. Only ever called after the shape has already been confirmed to
  // match detailed mode (caller's responsibility); no validation happens here.
  window._setDetailedAvailability = function (blocks) {
    if (window._detailedMobileUI) {
      if (!clearMobileRows || !addMobileRow) return;
      clearMobileRows();
      blocks.forEach(b => addMobileRow(b.day, timeToMinutes(b.startTime), timeToMinutes(b.endTime), b.category, b.label));
      return;
    }
    if (!dayStates) return;
    dayStates = freshSlotMap(null);
    dayLabels = freshSlotMap(null);
    blocks.forEach(b => {
      const startIdx = (timeToMinutes(b.startTime) - START_HOUR * 60) / INCREMENT;
      const endIdx   = (timeToMinutes(b.endTime)   - START_HOUR * 60) / INCREMENT;
      for (let i = startIdx; i < endIdx; i++) {
        if (i < 0 || i >= TOTAL_SLOTS) continue;
        dayStates[b.day][i] = b.category;
        dayLabels[b.day][i] = b.label || null;
      }
    });
    if (recolorAllSlots) recolorAllSlots();
    updateCoverageStatus();
  };

  // Same gap/overlap/coverage algorithm as server.js's validateDetailedAvailability,
  // for instant client-side feedback before submitting (the server still re-checks).
  function timeToMinutes(t) {
    const [time, ampm] = t.trim().split(' ');
    const [h, m] = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }
  function validateCoverage(availability) {
    const WINDOW_START = START_HOUR * 60, WINDOW_END = END_HOUR * 60;
    for (const day of DAYS) {
      const intervals = availability
        .filter(b => b.day === day)
        .map(b => ({ start: timeToMinutes(b.startTime), end: timeToMinutes(b.endTime) }))
        .sort((a, b) => a.start - b.start);
      let expected = WINDOW_START;
      for (const iv of intervals) {
        if (iv.start > expected) return `${day}: there's a gap before ${fmt2(iv.start)}.`;
        if (iv.start < expected) return `${day}: two blocks overlap around ${fmt2(iv.start)}.`;
        expected = iv.end;
      }
      if (expected < WINDOW_END) return `${day}: the schedule doesn't reach all the way to 11:00 PM.`;
    }
    return null;
  }

  // ─── Public init/teardown ────────────────────────────────────────────────
  window.initDetailedAvailability = function () {
    const wrapper = document.querySelector('.schedule-wrapper');
    if (wrapper && originalWrapperHtml === null) originalWrapperHtml = wrapper.innerHTML;

    if (window.innerWidth < 1024) {
      initMobileUI();
    } else {
      window._detailedMobileUI = false;
      initDesktopGrid();
    }
  };

  window.teardownDetailedAvailability = function () {
    const wrapper = document.querySelector('.schedule-wrapper');
    if (wrapper && originalWrapperHtml !== null) {
      wrapper.innerHTML = originalWrapperHtml;
      wrapper.removeAttribute('style');
    }
    if (mouseupHandler) {
      document.removeEventListener('mouseup', mouseupHandler);
      mouseupHandler = null;
    }
    dayStates = null;
    dayLabels = null;
    selectedCategory = null;
    recolorAllSlots = null;
    addMobileRow = null;
    clearMobileRows = null;
    delete window._detailedMobileUI;
  };

  window._getDetailedAvailability = function () {
    if (window._detailedMobileUI) return getDetailedMobileRows();
    if (!dayStates) return [];
    let result = [];
    DAYS.forEach(day => { result = result.concat(coalesceDay(day)); });
    return result;
  };

  // Used by app.js before submitting: null if valid, an error string naming the day
  // and problem if not. Mirrors server.js's validateDetailedAvailability exactly.
  window._getDetailedAvailabilityError = function () {
    const availability = window._getDetailedAvailability();
    const coverageError = validateCoverage(availability);
    if (coverageError) return coverageError;
    for (const block of availability) {
      if (block.category !== 'available' && !block.label) {
        const catName = CATEGORY_BY_ID[block.category]?.label || block.category;
        return `${block.day}: a label is required for "${catName}" blocks.`;
      }
    }
    return null;
  };
})();
