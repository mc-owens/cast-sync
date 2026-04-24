/*
 * CastSync Guided Tour
 * Engine + step definitions for all pages.
 * Pages include this file and call CastSyncTour.maybeStart().
 */
(function () {
  'use strict';

  const LS_KEY        = 'csTour';
  const DONE_KEY      = 'csTourDone';
  const WORKSPACE_KEY = 'csWorkspaceTour';

  /* ── State ──────────────────────────────────────────────────── */
  function save(d)  { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch {} }
  function load()   { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } }
  function clear()  { localStorage.removeItem(LS_KEY); }
  function isDone() { return !!localStorage.getItem(DONE_KEY); }
  function markDone(){ localStorage.setItem(DONE_KEY, '1'); }

  /* ── Step definitions ───────────────────────────────────────── */
  const STEPS = {

    /* org-select: triggered by ?tour=1 from signup */
    'org-select': [
      {
        selector: null,
        title: 'Welcome to CastSync!',
        body: 'You\'re in your home base. This is where you manage your <strong>organizations</strong> and <strong>productions</strong>. Let\'s take a quick look around — it only takes a minute.',
      },
      {
        selector: 'button[data-bs-target="#newOrgModal"]',
        position: 'bottom',
        title: 'Create an Organization',
        body: 'An organization is your dance company or team. Start here — everything else lives inside it. You can have multiple organizations if you work with different companies.',
      },
      {
        selector: null,
        title: 'Productions & Join Codes',
        body: 'Inside each organization you create <strong>productions</strong> — a Fall Show, Spring Showcase, etc.<br><br>Each production gets a unique <strong>join code</strong> you share with your dancers. They use it to submit their audition info and availability.',
      },
      {
        selector: null,
        title: 'Invite a Co-Director',
        body: 'You can add a <strong>co-director</strong> to any production. They get full access to that show\'s data — scheduling, casting, publishing — without seeing your other productions.<br><br>Once you\'ve created a production and entered it, your full workspace tour will begin automatically.',
      },
    ],

    /* master.html: auto-starts on first production entry */
    'master': [
      {
        selector: '.navbar-collapse',
        position: 'bottom',
        title: 'Your Workspace Tabs',
        body: 'These tabs are your entire workflow. We\'re starting on <strong>Master Schedule</strong> — your production\'s choreographic timeline.',
      },
      {
        selector: '#grid',
        position: 'top',
        title: 'Master Schedule Grid',
        body: 'Build your rehearsal schedule here. Each colored block represents a piece. <strong>Drag</strong> to place a block, <strong>resize</strong> to adjust it. Overlapping blocks that exceed your room count are flagged in red automatically.',
      },
      {
        selector: '#pieces-legend',
        position: 'right',
        title: 'Pieces & Colors',
        body: 'Each piece in your production gets its own color. Create a piece first, then drag blocks onto the grid for that piece\'s rehearsal time slots.',
      },
      {
        selector: '#room-count-input',
        position: 'bottom',
        title: 'Room Count',
        body: 'Tell CastSync how many rehearsal rooms you have. If you schedule more pieces at the same time than you have rooms, those blocks turn red so you can fix the conflict.',
        nextPage: 'search.html',
      },
    ],

    /* search.html: Availability */
    'search': [
      {
        selector: '.schedule-wrapper',
        position: 'top',
        title: 'Availability Grid',
        body: 'This is your at-a-glance view of when dancers are free. Once auditionees submit, their availability blocks appear here — each piece gets its own color.',
      },
      {
        selector: null,
        title: 'Click Any Block to See Who\'s Free',
        body: 'Click on a time block in the grid to open a panel showing <strong>who is fully available</strong> and <strong>who is partially available</strong> during that window — making it easy to find dancers who can all rehearse together.',
      },
      {
        selector: null,
        title: 'Viewing Auditionee Profiles',
        body: 'Click any dancer\'s name to open their full profile — contact info, grade, technique background, injuries, known absences, and their complete availability schedule.',
        nextPage: 'cast.html',
      },
    ],

    /* cast.html: Cast Builder */
    'cast': [
      {
        selector: null,
        title: 'Cast Builder',
        body: 'This is where you build your cast piece by piece. Select a piece from the left panel, then see which dancers are available during its rehearsal window.',
      },
      {
        selector: '#view-all-btn',
        position: 'bottom',
        title: 'View Modes',
        body: '<strong>All Windows</strong> shows every time slot where your selected dancers are free. <strong>Open Rooms</strong> filters to only windows where a rehearsal room is also available — useful when rooms are your bottleneck.',
      },
      {
        selector: '#avail-grid-wrapper',
        position: 'top',
        title: 'Availability Overlay',
        body: 'Green slots = everyone in the current cast is free. Amber = rooms are full at that time. Gray blocks are already-scheduled rehearsals from the Master Schedule.',
      },
      {
        selector: '#action-panel',
        position: 'top',
        title: 'Assign Cast Members',
        body: 'Select dancers from the list on the left, then use this panel to assign them as <strong>Cast Members</strong> or <strong>Understudies</strong> for the selected piece.',
        nextPage: 'dancers.html',
      },
    ],

    /* dancers.html: Auditionees */
    'dancers': [
      {
        selector: '#search-input',
        position: 'bottom',
        title: 'Auditionees',
        body: 'Every dancer who submitted to this production appears here. Use the search bar to find someone quickly by name.',
      },
      {
        selector: '#dancers-table',
        position: 'top',
        title: 'Full Profiles at a Click',
        body: 'Click any row to open a dancer\'s full profile — contact info, grade, technique background, injuries, absences, audition number, and their complete availability grid.',
        nextPage: 'casting.html',
      },
    ],

    /* casting.html: Casting tab */
    'casting': [
      {
        selector: '#pieces-container',
        position: 'top',
        title: 'Casting Sheet',
        body: 'This is your master casting sheet. Each piece shows its choreographer info, cast members, and understudies. <strong>Click a piece</strong> to expand it and edit details.',
      },
      {
        selector: '#publish-toggle',
        position: 'top',
        title: 'Publish Toggle',
        body: 'When your cast is finalized, flip this toggle to <strong>publish</strong>. All auditionees can then see the full cast list — who got which role in every piece.',
      },
      {
        selector: 'a[href="publish.html"]',
        position: 'top',
        title: 'Email & Export',
        body: 'Use this button to <strong>email the cast list</strong> to all auditionees at once, or <strong>download a PDF or CSV</strong> for your records and rehearsal packets.<br><br>That\'s everything! You\'re ready to run your first production.',
      },
    ],

  };

  /* ── UI ─────────────────────────────────────────────────────── */
  let _steps, _page, _cur, _ring, _tip;

  function buildUI() {
    // Ring: highlight box + dark overlay via box-shadow
    _ring = document.createElement('div');
    _ring.id = 'tour-ring';
    Object.assign(_ring.style, {
      position: 'fixed', zIndex: '9998', pointerEvents: 'none',
      border: '2px solid #c4943a', borderRadius: '8px',
      boxShadow: '0 0 0 9999px rgba(0,0,0,.68), 0 0 20px rgba(196,148,58,.4)',
      transition: 'top .25s, left .25s, width .25s, height .25s',
      display: 'none',
    });
    document.body.appendChild(_ring);

    // Overlay: captures clicks so user can't interact with page during tour
    const ov = document.createElement('div');
    ov.id = 'tour-overlay';
    Object.assign(ov.style, { position: 'fixed', inset: '0', zIndex: '9997' });
    document.body.appendChild(ov);

    // Tooltip
    _tip = document.createElement('div');
    _tip.id = 'tour-tip';
    Object.assign(_tip.style, {
      position: 'fixed', zIndex: '9999', width: '310px',
      background: '#111', color: '#fff', borderRadius: '12px',
      padding: '22px 24px 18px', boxShadow: '0 16px 48px rgba(0,0,0,.55)',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    });
    _tip.innerHTML = `
      <div id="t-label" style="font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#c4943a;margin-bottom:8px;"></div>
      <div id="t-title" style="font-weight:700;font-size:15px;margin-bottom:8px;line-height:1.3;"></div>
      <div id="t-body"  style="font-size:13px;color:rgba(255,255,255,.75);line-height:1.62;margin-bottom:18px;"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <button id="t-skip" style="font-size:12px;color:rgba(255,255,255,.4);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px;">Skip tour</button>
        <div style="display:flex;gap:8px;">
          <button id="t-prev" style="font-size:12px;background:rgba(255,255,255,.1);border:none;color:rgba(255,255,255,.75);padding:5px 13px;border-radius:6px;cursor:pointer;">Back</button>
          <button id="t-next" style="font-size:13px;font-weight:600;background:#c4943a;border:none;color:#fff;padding:6px 18px;border-radius:6px;cursor:pointer;">Next →</button>
        </div>
      </div>`;
    document.body.appendChild(_tip);

    document.getElementById('t-skip').onclick = end;
    document.getElementById('t-prev').onclick = () => show(_cur - 1);
    document.getElementById('t-next').onclick = advance;
  }

  function show(i) {
    if (i < 0) i = 0;
    _cur = i;
    save({ page: _page, step: i });

    const step = _steps[i];
    document.getElementById('t-label').textContent = `Step ${i + 1} of ${_steps.length}`;
    document.getElementById('t-title').textContent = step.title;
    document.getElementById('t-body').innerHTML    = step.body;
    document.getElementById('t-prev').style.display = i === 0 ? 'none' : '';
    document.getElementById('t-next').textContent   = i === _steps.length - 1 ? 'Finish ✓' : 'Next →';

    const el = step.selector ? document.querySelector(step.selector) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        const pad = 7;
        Object.assign(_ring.style, {
          display: '',
          top:    `${r.top  - pad}px`,
          left:   `${r.left - pad}px`,
          width:  `${r.width  + pad * 2}px`,
          height: `${r.height + pad * 2}px`,
        });
        placeTip(r, step.position || 'bottom');
      }, 220);
    } else {
      _ring.style.display = 'none';
      centerTip();
    }
  }

  function placeTip(r, pos) {
    const W = 310, M = 14;
    const th = _tip.offsetHeight || 180;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top, left;
    if (pos === 'bottom') {
      top  = Math.min(r.bottom + M, vh - th - M);
      left = Math.max(M, Math.min(r.left + r.width / 2 - W / 2, vw - W - M));
    } else if (pos === 'top') {
      top  = Math.max(M, r.top - th - M);
      left = Math.max(M, Math.min(r.left + r.width / 2 - W / 2, vw - W - M));
    } else if (pos === 'right') {
      top  = Math.max(M, Math.min(r.top + r.height / 2 - th / 2, vh - th - M));
      left = Math.min(r.right + M, vw - W - M);
    } else if (pos === 'left') {
      top  = Math.max(M, Math.min(r.top + r.height / 2 - th / 2, vh - th - M));
      left = Math.max(M, r.left - W - M);
    } else {
      centerTip(); return;
    }
    Object.assign(_tip.style, { top: `${top}px`, left: `${left}px`, transform: 'none' });
  }

  function centerTip() {
    Object.assign(_tip.style, { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' });
  }

  function advance() {
    const next = _cur + 1;
    if (next >= _steps.length) {
      const step = _steps[_cur];
      if (step.nextPage) {
        save({ page: step.nextPage.replace('.html', ''), step: 0 });
        window.location.href = step.nextPage;
      } else if (_page === 'org-select') {
        // Onboarding complete — clear state but don't mark done yet.
        // The workspace tour starts automatically when they enter their first production.
        clear();
        document.getElementById('tour-ring')?.remove();
        document.getElementById('tour-overlay')?.remove();
        document.getElementById('tour-tip')?.remove();
      } else {
        end();
      }
    } else {
      show(next);
    }
  }

  function end() {
    markDone();
    clear();
    document.getElementById('tour-ring')?.remove();
    document.getElementById('tour-overlay')?.remove();
    document.getElementById('tour-tip')?.remove();
  }

  /* ── Public API ─────────────────────────────────────────────── */
  window.CastSyncTour = {

    /* Call from org-select.html when ?tour=1 */
    startOnboarding() {
      if (isDone()) return;
      _steps = STEPS['org-select'];
      _page  = 'org-select';
      _cur   = 0;
      buildUI();
      show(0);
    },

    /* Call from workspace pages — auto-continues or starts fresh */
    maybeStartWorkspace(pageKey) {
      if (isDone()) return;

      // Check if a workspace tour is already in progress for this page
      const state = load();
      const pageSteps = STEPS[pageKey];
      if (!pageSteps) return;

      // Continue if tour state says we're on this page
      if (state && state.page === pageKey) {
        _steps = pageSteps;
        _page  = pageKey;
        _cur   = state.step || 0;
        buildUI();
        show(_cur);
        return;
      }

      // Start fresh workspace tour on master page (first entry into a production)
      if (pageKey === 'master') {
        const started = localStorage.getItem(WORKSPACE_KEY);
        if (!started) {
          localStorage.setItem(WORKSPACE_KEY, '1');
          _steps = pageSteps;
          _page  = 'master';
          _cur   = 0;
          save({ page: 'master', step: 0 });
          buildUI();
          show(0);
        }
      }
    },
  };

})();
