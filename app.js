// ── Submission logic ──────────────────────────────────────────────────────────

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
    const response = await fetch('/api/submissions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      alert('Error: ' + result.error);
      return;
    }
    document.getElementById('successModalLabel').textContent = isUpdate ? 'Submission Updated!' : 'Submitted!';
    document.getElementById('successModalBody').textContent  =
      isUpdate
        ? `Your submission for ${result.org} — ${result.season} has been updated.`
        : `Your audition form for ${result.org} — ${result.season} has been received!`;
    new bootstrap.Modal(document.getElementById('successModal')).show();
    if (!isUpdate) {
      document.getElementById('successModal').addEventListener('hidden.bs.modal', () => {
        document.getElementById('dancer-form').reset();
        document.querySelectorAll('#grid .block').forEach(b => b.remove());
      }, { once: true });
    }
  } catch (err) {
    alert('Could not connect to the server.');
    console.error(err);
  }
}

async function addDancer() {
  const join_code        = document.getElementById('join-code').value.trim();
  const first_name       = document.getElementById('fname').value.trim();
  const last_name        = document.getElementById('lname').value.trim();
  const phone            = document.getElementById('phonenumber').value.trim();
  const address          = document.getElementById('address').value.trim();
  const technique_classes= document.getElementById('techniqueclasses').value.trim();
  const injuries         = document.getElementById('injuries').value.trim();
  const absences         = document.getElementById('absences').value.trim();

  if (!join_code)   { alert('Please enter your director\'s join code.'); return; }
  if (!first_name || !last_name) { alert('First and last name are required.'); return; }

  const gradeRadio = document.querySelector('input[name="flexRadioDefault"]:checked');
  const grade      = gradeRadio ? gradeRadio.nextElementSibling.textContent.trim() : null;

  const SLOT_HEIGHT = 12.5, START_HOUR = 8, INCREMENT = 15;
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const gridEl   = document.getElementById('grid');
  const dayWidth = gridEl.clientWidth / 7;

  function toTimeString(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr   = h % 12 === 0 ? 12 : h % 12;
    return `${hr}:${m.toString().padStart(2,'0')} ${ampm}`;
  }

  const availability = [];
  document.querySelectorAll('#grid .block').forEach(block => {
    const topPx = parseFloat(block.style.top), heightPx = parseFloat(block.style.height);
    const leftPx = parseFloat(block.style.left);
    const dayIndex     = Math.round(leftPx / dayWidth);
    const startSlot    = Math.round(topPx / SLOT_HEIGHT);
    const endSlot      = startSlot + Math.round(heightPx / SLOT_HEIGHT);
    availability.push({
      day:       DAYS[dayIndex] || 'Unknown',
      startTime: toTimeString(startSlot * INCREMENT + START_HOUR * 60),
      endTime:   toTimeString(endSlot   * INCREMENT + START_HOUR * 60),
    });
  });

  const auditionNumEl  = document.getElementById('audition-number');
  const audition_number = auditionNumEl ? auditionNumEl.value.trim() || null : null;

  const data = { join_code, first_name, last_name, phone, address, grade, technique_classes, injuries, absences, availability, audition_number };

  // Check for existing submission with this join code
  try {
    const checkRes = await fetch(`/api/submissions/me?join_code=${encodeURIComponent(join_code)}`);
    if (checkRes.ok) {
      const existing = await checkRes.json();
      document.getElementById('existing-org-name').textContent = existing.org_name + ' — ' + existing.season_name;
      pendingSubmission = data;
      new bootstrap.Modal(document.getElementById('updateConfirmModal')).show();
      return;
    }
  } catch (err) { /* no existing — proceed */ }

  await submitToServer(data, false);
}
