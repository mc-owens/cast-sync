
const schedule = document.getElementById('schedule');
const startHour = 9; // 9:00 AM
const slots = 12; // 12 half-hour slots = 6 hours

// Build the grid
for (let i = 0; i < slots; i++) {
  const time = document.createElement('div');
  time.className = 'time-label';
  const hour = startHour + Math.floor(i / 2);
  const minute = i % 2 === 0 ? '00' : '30';
  time.textContent = `${hour}:${minute}`;
  schedule.appendChild(time);

  const slot = document.createElement('div');
  slot.className = 'time-slot';
  slot.dataset.index = i;
  schedule.appendChild(slot);
}

let isSelecting = false;
let startIndex = null;
let currentBlock = null;
let isResizing = false;
let resizeDirection = null;

schedule.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('resize-handle')) {
    isResizing = true;
    currentBlock = e.target.parentElement;
    resizeDirection = e.target.classList.contains('resize-top') ? 'top' : 'bottom';
    return;
  }

  if (e.target.classList.contains('block')) {
    currentBlock = e.target;
    currentBlock.dataset.offsetY = e.offsetY;
    return;
  }

  if (e.target.classList.contains('time-slot')) {
    isSelecting = true;
    startIndex = parseInt(e.target.dataset.index);
    currentBlock = document.createElement('div');
    currentBlock.className = 'block';
    currentBlock.style.top = `${startIndex * 50}px`;
    currentBlock.style.height = '50px';
    currentBlock.innerHTML = `
      Available
      <div class="resize-handle resize-top"></div>
      <div class="resize-handle resize-bottom"></div>
    `;
    schedule.appendChild(currentBlock);
  }
});

schedule.addEventListener('mousemove', (e) => {
  if (isSelecting && currentBlock) {
    const slot = e.target.closest('.time-slot');
    if (!slot) return;
    const currentIndex = parseInt(slot.dataset.index);
    const height = (Math.abs(currentIndex - startIndex) + 1) * 50;
    const top = Math.min(currentIndex, startIndex) * 50;
    currentBlock.style.top = `${top}px`;
    currentBlock.style.height = `${height}px`;
  }

  if (isResizing && currentBlock) {
    const rect = schedule.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const blockTop = parseFloat(currentBlock.style.top);
    const blockHeight = parseFloat(currentBlock.style.height);

    if (resizeDirection === 'top') {
      const newTop = Math.min(y, blockTop + blockHeight - 25);
      const newHeight = blockHeight + (blockTop - newTop);
      currentBlock.style.top = `${newTop}px`;
      currentBlock.style.height = `${newHeight}px`;
    } else {
      const newHeight = Math.max(y - blockTop, 25);
      currentBlock.style.height = `${newHeight}px`;
    }
  }
});

document.addEventListener('mouseup', () => {
  isSelecting = false;
  isResizing = false;
  currentBlock = null;
});


// Array to store dancer data
let dancers = [];
let masterSchedule = [];

// Initialize the weekly grid with 15-minute intervals
function initializeWeeklyGrid() {
    const gridContainer = document.getElementById('weekly-grid');
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    days.forEach(day => {
        const dayColumn = document.createElement('div');
        dayColumn.className = 'day-column';

        const dayHeader = document.createElement('h4');
        dayHeader.textContent = day;
        dayColumn.appendChild(dayHeader);

        // Create time slots in 15-minute intervals (8:00 AM to 12:00 AM)
        for (let hour = 8; hour <= 24; hour++) {
            for (let minute = 0; minute < 60; minute += 15) {
                const time = `${hour}:${minute === 0 ? '00' : minute}`;
                const timeSlot = document.createElement('div');
                timeSlot.className = 'time-slot';
                timeSlot.dataset.day = day;
                timeSlot.dataset.time = time;
                timeSlot.textContent = time;
                timeSlot.draggable = true;

                timeSlot.addEventListener('click', handleTimeSlotClick);

                dayColumn.appendChild(timeSlot);
            }
        }

        gridContainer.appendChild(dayColumn);
    });
}

// Event handler for clicking a time slot
function handleTimeSlotClick(event) {
    const timeSlot = event.target;
    
    // Toggle the availability by changing the background color to green
    if (timeSlot.classList.contains('available')) {
        timeSlot.classList.remove('available');
        timeSlot.style.backgroundColor = ''; // Reset the color
    } else {
        timeSlot.classList.add('available');
        timeSlot.style.backgroundColor = 'green'; // Mark as available (green)
    }
}


// Function to save availability from the grid
function saveAvailability() {
    const timeSlots = document.querySelectorAll('.time-slot.available');
    const availability = {};

    timeSlots.forEach(slot => {
        const day = slot.dataset.day;
        const time = slot.dataset.time;

        if (!availability[day]) {
            availability[day] = [];
        }
        availability[day].push(time);
    });

    alert('Availability saved!');
    console.log('Saved Availability:', availability);
}

// Initialize the interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    initializeWeeklyGrid();
});


// ── One submission per account ────────────────────────────────────────────────

let pendingSubmission = null;

document.addEventListener('DOMContentLoaded', () => {
  const confirmBtn = document.getElementById('confirm-update-btn');
  if (!confirmBtn) return;
  confirmBtn.addEventListener('click', () => {
    const modal = bootstrap.Modal.getInstance(document.getElementById('updateConfirmModal'));
    modal.hide();
    document.getElementById('updateConfirmModal').addEventListener('hidden.bs.modal', async () => {
      await submitToServer(pendingSubmission, true);
      pendingSubmission = null;
    }, { once: true });
  });
});

async function submitToServer(data, isUpdate) {
  try {
    const response = await fetch(isUpdate ? '/api/dancers/me' : '/api/dancers', {
      method:  isUpdate ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!response.ok) {
      const err = await response.json();
      alert('Error saving form: ' + err.error);
      return;
    }
    document.getElementById('successModalLabel').textContent =
      isUpdate ? 'Submission Updated!' : 'Form Submitted!';
    document.getElementById('successModalBody').textContent =
      isUpdate ? 'Your submission has been updated.' : 'Your form has been successfully submitted!';
    const successModal = new bootstrap.Modal(document.getElementById('successModal'));
    successModal.show();
    if (!isUpdate) {
      document.getElementById('successModal').addEventListener('hidden.bs.modal', () => {
        document.getElementById('dancer-form').reset();
        document.querySelectorAll('#grid .block').forEach(b => b.remove());
      }, { once: true });
    }
  } catch (err) {
    alert('Could not connect to the server. Make sure it is running (node server.js).');
    console.error(err);
  }
}

async function addDancer() {
    // ── 1. Collect text form fields ──────────────────────────────────────
    const first_name        = document.getElementById('fname').value.trim();
    const last_name         = document.getElementById('lname').value.trim();
    const email             = document.getElementById('email').value.trim();
    const phone             = document.getElementById('phonenumber').value.trim();
    const address           = document.getElementById('address').value.trim();
    const technique_classes = document.getElementById('techniqueclasses').value.trim();
    const injuries          = document.getElementById('injuries').value.trim();
    const absences          = document.getElementById('absences').value.trim();

    // ── 2. Collect the selected grade from the radio buttons ─────────────
    // The radio buttons have no value attr, so we read the adjacent label text.
    const gradeRadio = document.querySelector('input[name="flexRadioDefault"]:checked');
    const grade = gradeRadio ? gradeRadio.nextElementSibling.textContent.trim() : null;

    // ── 3. Serialize schedule blocks from the grid ───────────────────────
    // schedule.js appends .block divs to #grid with CSS top/height/left.
    // Constants must match schedule.js: slotHeight=12.5, startHour=8, increment=15.
    const SLOT_HEIGHT = 12.5;
    const START_HOUR  = 8;
    const INCREMENT   = 15;
    const DAYS        = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const gridEl  = document.getElementById('grid');
    const dayWidth = gridEl.clientWidth / 7;

    function toTimeString(totalMinutes) {
        const h    = Math.floor(totalMinutes / 60);
        const m    = totalMinutes % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hr   = h % 12 === 0 ? 12 : h % 12;
        return `${hr}:${m.toString().padStart(2, '0')} ${ampm}`;
    }

    const availability = [];
    document.querySelectorAll('#grid .block').forEach(block => {
        const topPx    = parseFloat(block.style.top);
        const heightPx = parseFloat(block.style.height);
        const leftPx   = parseFloat(block.style.left);

        const dayIndex     = Math.round(leftPx / dayWidth);
        const startSlot    = Math.round(topPx / SLOT_HEIGHT);
        const endSlot      = startSlot + Math.round(heightPx / SLOT_HEIGHT);
        const startMinutes = startSlot * INCREMENT + START_HOUR * 60;
        const endMinutes   = endSlot   * INCREMENT + START_HOUR * 60;

        availability.push({
            day:       DAYS[dayIndex] || 'Unknown',
            startTime: toTimeString(startMinutes),
            endTime:   toTimeString(endMinutes),
        });
    });

    // ── 4. Check for existing submission, then send ───────────────────────
    try {
        const checkRes = await fetch('/api/dancers/me');
        if (checkRes.ok) {
            pendingSubmission = { first_name, last_name, email, phone, address, grade, technique_classes, injuries, absences, availability };
            new bootstrap.Modal(document.getElementById('updateConfirmModal')).show();
            return;
        }
    } catch (err) { /* network error — attempt POST below */ }

    await submitToServer({ first_name, last_name, email, phone, address, grade, technique_classes, injuries, absences, availability }, false);
}
