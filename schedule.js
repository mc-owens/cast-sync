document.addEventListener("DOMContentLoaded", () => {
    const startHour = 8; // 8 AM
    const endHour = 23; // midnight
    const increment = 15; // minutes
    const slotHeight = 12.5; // pixels per 15-min slot
    const timeColumn = document.getElementById('time-column');
    const grid = document.getElementById('grid');
    const headerRow = document.getElementById('day-header-row');
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // Header row
    const emptyHeader = document.createElement('div');
    headerRow.appendChild(emptyHeader);
    days.forEach(day => {
      const header = document.createElement('div');
      header.className = 'day-header';
      header.textContent = day;
      headerRow.appendChild(header);
    });

    // Time column
for (let h = startHour; h <= endHour; h++) {
  const label = document.createElement('div');
  label.className = 'time-label';
  label.textContent = formatTime(h, 0);
  timeColumn.appendChild(label);
}

// Grid columns
days.forEach(day => {
  const col = document.createElement('div');
  col.className = 'day-column';
  const totalSlots = ((endHour + 1 - startHour) * 60) / increment; // +1 to include 11 PM hour fully
  for (let i = 0; i < totalSlots; i++) {
    const slot = document.createElement('div');
    slot.className = 'time-slot';
    if (i % 4 === 3) slot.classList.add('hour-line'); // bold line at every full hour
    slot.dataset.timeIndex = i;
    col.appendChild(slot);
  }
  grid.appendChild(col);
});

    // Interaction logic
    let isSelecting = false;
    let startSlot = 0;
    let currentBlock = null;
    let currentDayColumn = null;
    let isResizing = false;
    let resizeDirection = null;
    let offsetY = 0;

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
      currentDayColumn = slot.parentElement;
      startSlot = parseInt(slot.dataset.timeIndex);
      const dayIndex = Array.from(grid.children).indexOf(currentDayColumn);
      const dayWidth = grid.clientWidth / 7;
      const leftPos = dayIndex * dayWidth;

      currentBlock = document.createElement('div');
      currentBlock.className = 'block';
      currentBlock.dataset.startIndex = startSlot;
      currentBlock.style.left = `${leftPos}px`;
      currentBlock.style.top = `${startSlot * slotHeight}px`;
      currentBlock.style.height = `${slotHeight}px`;
      currentBlock.innerHTML = `
        <span class="time-label-text"></span>
        <span class="delete-btn">✕</span>
        <div class="resize-handle resize-top"></div>
        <div class="resize-handle resize-bottom"></div>
      `;
      grid.appendChild(currentBlock);
      updateBlockTimeLabel(currentBlock);
    });

    grid.addEventListener('mousemove', e => {
      if (isSelecting && currentBlock) {
        const slot = e.target.closest('.time-slot');
        if (!slot) return;
        const currentSlot = parseInt(slot.dataset.timeIndex);
        const topSlot = Math.min(startSlot, currentSlot);
        const heightSlots = Math.abs(currentSlot - startSlot) + 1;
        currentBlock.style.top = `${topSlot * slotHeight}px`;
        currentBlock.style.height = `${heightSlots * slotHeight}px`;
        currentBlock.dataset.startIndex = topSlot;
        updateBlockTimeLabel(currentBlock);
      }

      if (isResizing && currentBlock) {
        const rect = grid.getBoundingClientRect();
        let y = e.clientY - rect.top;
        y = Math.round(y / slotHeight) * slotHeight;
        const blockTop = parseFloat(currentBlock.style.top);
        const blockHeight = parseFloat(currentBlock.style.height);

        if (resizeDirection === 'top') {
          const newTop = Math.min(y, blockTop + blockHeight - slotHeight);
          const newHeight = blockHeight + (blockTop - newTop);
          currentBlock.style.top = `${newTop}px`;
          currentBlock.style.height = `${newHeight}px`;
          currentBlock.dataset.startIndex = Math.round(newTop / slotHeight);
        } else {
          const newHeight = Math.max(y - blockTop, slotHeight);
          currentBlock.style.height = `${newHeight}px`;
        }
        updateBlockTimeLabel(currentBlock);
      }

      if (currentBlock && !isResizing && !isSelecting && e.buttons === 1 && offsetY) {
        const rect = grid.getBoundingClientRect();
        let y = e.clientY - rect.top - offsetY;
        y = Math.max(0, Math.min(y, grid.clientHeight - parseFloat(currentBlock.style.height)));
        y = Math.round(y / slotHeight) * slotHeight;
        currentBlock.style.top = `${y}px`;
        currentBlock.dataset.startIndex = Math.round(y / slotHeight);
        updateBlockTimeLabel(currentBlock);
      }
    });

    document.addEventListener('mouseup', () => {
      isSelecting = false;
      isResizing = false;
      offsetY = 0;
      currentBlock = null;
    });

    grid.addEventListener('click', e => {
      if (e.target.classList.contains('delete-btn')) {
        e.target.parentElement.remove();
      }
    });

    function formatTime(hour, minute) {
      let ampm = hour >= 12 ? 'PM' : 'AM';
      let hr = hour % 12;
      if (hr === 0) hr = 12;
      return `${hr}:${minute.toString().padStart(2, '0')} ${ampm}`;
    }

    function updateBlockTimeLabel(block) {
      const startIndex = parseInt(block.dataset.startIndex);
      const height = parseFloat(block.style.height);
      const endIndex = startIndex + Math.round(height / slotHeight);

      const startMinutes = startIndex * increment + startHour * 60;
      const endMinutes = endIndex * increment + startHour * 60;

      const startHour24 = Math.floor(startMinutes / 60);
      const startMin = startMinutes % 60;
      const endHour24 = Math.floor(endMinutes / 60);
      const endMin = endMinutes % 60;

      const label = block.querySelector('.time-label-text');
      label.textContent = `${formatTime(startHour24, startMin)} - ${formatTime(endHour24, endMin)}`;
    }

  });
  