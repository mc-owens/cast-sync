document.addEventListener('DOMContentLoaded', () => {
  const DAYS      = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MINI_START = 8 * 60;   // 8 AM in minutes
  const MINI_END   = 23 * 60;  // 11 PM in minutes
  const MINI_RANGE = MINI_END - MINI_START;

  // ── State ─────────────────────────────────────────────────────────────────────
  let selectedDancers = [];

  // ── DOM references ────────────────────────────────────────────────────────────
  const searchInput  = document.getElementById('dancer-search');
  const dropdown     = document.getElementById('search-dropdown');
  const castList     = document.getElementById('cast-list');
  const castEmptyMsg = document.getElementById('cast-empty-msg');
  const castCount    = document.getElementById('cast-count');
  const placeholder  = document.getElementById('common-placeholder');
  const results      = document.getElementById('common-results');
  const commonList   = document.getElementById('common-list');
  const noCommon     = document.getElementById('no-common');

  // ── Time helpers ──────────────────────────────────────────────────────────────

  function timeToMinutes(timeStr) {
    const [time, ampm] = timeStr.trim().split(' ');
    const [h, m]       = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }

  function minutesToTimeString(totalMinutes) {
    const h    = Math.floor(totalMinutes / 60);
    const m    = totalMinutes % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr   = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  // ── Search (debounced) ────────────────────────────────────────────────────────

  let debounceTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (!q) { hideDropdown(); return; }
    debounceTimer = setTimeout(() => fetchDancers(q), 300);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideDropdown();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrapper')) hideDropdown();
  });

  async function fetchDancers(q) {
    try {
      const res     = await fetch(`/api/dancers/search?q=${encodeURIComponent(q)}`);
      const dancers = await res.json();
      const filtered = dancers.filter(d => !selectedDancers.find(s => s.id === d.id));

      if (filtered.length === 0) {
        dropdown.innerHTML = '<div class="dropdown-item-dancer text-muted">No results found.</div>';
      } else {
        dropdown.innerHTML = '';
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

  // ── Cast management ───────────────────────────────────────────────────────────

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
    Array.from(castList.children).forEach(child => {
      if (child !== castEmptyMsg) child.remove();
    });

    castCount.textContent = `${selectedDancers.length} selected`;

    if (selectedDancers.length === 0) {
      castEmptyMsg.style.display = 'block';
      return;
    }
    castEmptyMsg.style.display = 'none';

    selectedDancers.forEach(dancer => {
      const chip = document.createElement('div');
      chip.className = 'cast-chip';

      const nameBtn = document.createElement('span');
      nameBtn.textContent   = `${dancer.first_name} ${dancer.last_name}`;
      nameBtn.style.cssText = 'cursor:pointer;text-decoration:underline;color:#0d6efd;flex:1;';
      nameBtn.title         = 'Click to view schedule';
      nameBtn.addEventListener('click', () => openDancerModal(dancer.id));

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.title       = 'Remove from cast';
      removeBtn.addEventListener('click', () => removeDancer(dancer.id));

      chip.appendChild(nameBtn);
      chip.appendChild(removeBtn);
      castList.appendChild(chip);
    });
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

      // Collapse the full profile section so it's hidden by default each time
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

      // Day label
      const label = document.createElement('div');
      label.style.cssText = 'font-size:9px;text-align:center;background:#f0f0f0;color:#666;padding:2px 0;border-bottom:1px solid #ddd;position:absolute;top:0;left:0;right:0;';
      label.textContent = DAYS_SHORT[i];
      col.appendChild(label);

      // Block area (below the label)
      const blockArea = document.createElement('div');
      blockArea.style.cssText = 'position:absolute;top:18px;left:0;right:0;bottom:0;';

      // Render each availability block for this day
      const blocks = availability.filter(b => b.day === day);
      blocks.forEach(block => {
        const startMin = timeToMinutes(block.startTime);
        const endMin   = timeToMinutes(block.endTime);
        // Clamp to 8AM–11PM range
        const clampedStart = Math.max(startMin, MINI_START);
        const clampedEnd   = Math.min(endMin, MINI_END);
        if (clampedStart >= clampedEnd) return;

        const topPct    = ((clampedStart - MINI_START) / MINI_RANGE) * 100;
        const heightPct = ((clampedEnd - clampedStart) / MINI_RANGE) * 100;

        const blockEl = document.createElement('div');
        blockEl.style.cssText = `
          position:absolute;
          left:2px;right:2px;
          top:${topPct}%;
          height:${heightPct}%;
          min-height:2px;
          background:rgba(52,152,219,0.55);
          border:1px solid #3498db;
          border-radius:2px;`;
        blockEl.title = `${block.startTime} – ${block.endTime}`;
        blockArea.appendChild(blockEl);
      });

      col.appendChild(blockArea);
      wrapper.appendChild(col);
    });

    container.appendChild(wrapper);
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

  // ── Common availability computation ───────────────────────────────────────────

  function getDayIntervals(dancer, day) {
    return (dancer.availability || [])
      .filter(b => b.day === day)
      .map(b => ({ start: timeToMinutes(b.startTime), end: timeToMinutes(b.endTime) }));
  }

  function intersectIntervals(listA, listB) {
    const result = [];
    for (const a of listA) {
      for (const b of listB) {
        const start = Math.max(a.start, b.start);
        const end   = Math.min(a.end, b.end);
        if (start < end) result.push({ start, end });
      }
    }
    return result;
  }

  function computeCommonAvailability() {
    if (selectedDancers.length < 2) {
      placeholder.style.display = 'block';
      results.style.display     = 'none';
      return;
    }

    placeholder.style.display = 'none';
    results.style.display     = 'block';
    commonList.innerHTML       = '';
    noCommon.style.display     = 'none';

    let foundAny = false;

    DAYS.forEach(day => {
      let common = getDayIntervals(selectedDancers[0], day);
      for (let i = 1; i < selectedDancers.length; i++) {
        common = intersectIntervals(common, getDayIntervals(selectedDancers[i], day));
        if (common.length === 0) break;
      }
      if (common.length === 0) return;
      foundAny = true;

      const dayEl = document.createElement('div');
      dayEl.className = 'common-day';
      dayEl.innerHTML = `<h6>${day}</h6>`;
      common.forEach(interval => {
        const badge       = document.createElement('span');
        badge.className   = 'time-window';
        badge.textContent = `${minutesToTimeString(interval.start)} – ${minutesToTimeString(interval.end)}`;
        dayEl.appendChild(badge);
      });
      commonList.appendChild(dayEl);
    });

    if (!foundAny) noCommon.style.display = 'block';
  }
});
