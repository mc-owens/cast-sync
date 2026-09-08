(function () {
  // Director-lite sidebar for Production Staff. Mirrors app-shell.js's rendering
  // pattern, but with a short, fixed nav and no production switcher -- staff pages
  // query by user_id across every assigned piece, not a single active org/season.
  const NAV_SECTIONS = [
    { section: 'My Productions', items: [
      { label: 'My Pieces',    href: 'staff-pieces.html' },
      { label: 'Schedule',     href: 'staff-schedule.html' },
      { label: 'Audition Day', href: 'audition-day.html' },
    ]},
    { section: 'Operations', items: [
      { label: 'Attendance',        href: 'staff-attendance.html' },
      { label: 'Absence Requests',  href: 'staff-absence-requests.html' },
      { label: 'Production Notes',  href: 'staff-notes.html' },
      { label: 'My Private Notes',  href: 'staff-my-notes.html' },
    ]},
    { section: 'Settings', items: [
      { label: 'Account', href: 'staff-account.html' },
    ]},
  ];

  function isActive(item) {
    if (!item.href) return false;
    const current = location.pathname.split('/').pop();
    const target = (item.matchHref || item.href).split('?')[0];
    return current === target;
  }

  function renderSidebarItem(item) {
    if (!item.href) {
      return `<span class="app-sidebar-link disabled">${item.label}</span>`;
    }
    const activeClass = isActive(item) ? ' active' : '';
    const idAttr = item.id ? ` id="${item.id}"` : '';
    return `<a class="app-sidebar-link${activeClass}"${idAttr} href="${item.href}">${item.label}</a>`;
  }

  function renderSidebar() {
    const sections = NAV_SECTIONS.map(({ section, items }) => `
      <div class="app-sidebar-section">
        <div class="app-sidebar-section-label">${section}</div>
        ${items.map(renderSidebarItem).join('')}
      </div>
    `).join('');
    return `
      <nav class="app-sidebar offcanvas offcanvas-start" tabindex="-1" id="appSidebar" aria-labelledby="appSidebarLabel">
        <div class="offcanvas-header app-sidebar-mobile-header">
          <h5 class="offcanvas-title" id="appSidebarLabel">Menu</h5>
          <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
        </div>
        <div class="offcanvas-body app-sidebar-body">${sections}</div>
      </nav>
    `;
  }

  function renderHeader() {
    return `
      <header class="app-shell-header">
        <button class="app-hamburger" type="button" data-bs-toggle="offcanvas" data-bs-target="#appSidebar" aria-controls="appSidebar" aria-label="Open navigation">
          <span></span><span></span><span></span>
        </button>
        <a class="navbar-brand app-shell-brand" href="#"><img src="logo-nav.png" width="22" height="22" alt="" style="vertical-align:middle;margin-right:6px;margin-bottom:2px;">CastSync</a>
        <ul class="navbar-nav app-shell-context-seam"><li class="nav-item"><span class="nav-link nav-context">Production Staff</span></li></ul>
        <div id="right-nav" class="app-nav-right app-shell-right"></div>
      </header>
    `;
  }

  // Closes the mobile drawer if the viewport is resized past the desktop breakpoint
  // while it's open, since Bootstrap's offcanvas has no native concept of "responsive."
  function watchBreakpoint() {
    const bp = window.matchMedia('(min-width: 992px)');
    bp.addEventListener('change', e => {
      if (!e.matches) return;
      const sidebarEl = document.getElementById('appSidebar');
      const instance = window.bootstrap && window.bootstrap.Offcanvas.getInstance(sidebarEl);
      if (instance) instance.hide();
    });
  }

  // Builds and wires the right-nav for staff pages. Call after auth resolves.
  // Replaces the old per-page right-nav setup pattern.
  window.buildStaffRightNav = async function (user, el) {
    function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    let dropdownHtml = '';
    if (user.isDirector) {
      let seasons = [];
      try {
        const r = await fetch('/api/my-director-seasons');
        if (r.ok) seasons = await r.json();
      } catch (_) {}
      const items = seasons.map(s =>
        `<li><a class="dropdown-item staff-nav-prod-link" href="#"
            data-org-id="${s.org_id}" data-season-id="${s.season_id}"
            style="font-size:13px;padding:6px 14px;line-height:1.3;">
           <div style="font-weight:500;">${esc(s.season_name)}</div>
           <div style="font-size:11px;color:#6b7280;">${esc(s.org_name)} &middot; ${s.role === 'owner' ? 'Director' : 'Co-Director'}</div>
         </a></li>`
      ).join('');
      dropdownHtml = `
        <div class="dropdown" style="display:inline-block;">
          <button class="btn btn-outline-secondary btn-sm dropdown-toggle" style="font-size:12px;" type="button" data-bs-toggle="dropdown" aria-expanded="false">
            My Productions
          </button>
          <ul class="dropdown-menu dropdown-menu-end" style="min-width:220px;">
            ${items}
            ${items ? '<li><hr class="dropdown-divider my-1"></li>' : ''}
            <li><a class="dropdown-item" href="#" id="all-orgs-link" style="font-size:13px;padding:6px 14px;font-weight:500;">All Organizations</a></li>
          </ul>
        </div>`;
    }

    el.innerHTML =
      `<a href="account.html" style="font-size:13px;">Account</a>` +
      dropdownHtml +
      (user.hasSubmissions ? `<button id="switch-auditionee-btn" class="btn btn-outline-secondary btn-sm" style="font-size:12px;">Switch to Auditionee</button>` : '') +
      `<button class="btn-nav-logout" id="logout-btn">Log Out</button>`;

    el.querySelectorAll('.staff-nav-prod-link').forEach(a => {
      a.addEventListener('click', async e => {
        e.preventDefault();
        await fetch('/api/auth/switch-mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode:'director' }) });
        await fetch('/api/session/org', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ orgId: +a.dataset.orgId, seasonId: +a.dataset.seasonId }) });
        window.location.href = 'dashboard.html';
      });
    });

    const allOrgs = el.querySelector('#all-orgs-link');
    if (allOrgs) allOrgs.addEventListener('click', async e => {
      e.preventDefault();
      await fetch('/api/auth/switch-mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode:'director' }) });
      window.location.href = 'org-select.html';
    });

    const switchAud = el.querySelector('#switch-auditionee-btn');
    if (switchAud) switchAud.addEventListener('click', async () => {
      await fetch('/api/auth/switch-mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode:'auditionee' }) });
      window.location.href = 'auditionForm.html';
    });

    el.querySelector('#logout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = 'login.html';
    });
  };

  const root = document.getElementById('app-shell-root');
  if (root) {
    root.insertAdjacentHTML('beforebegin', renderHeader());
    root.insertAdjacentHTML('afterend', renderSidebar());
    root.remove();
    watchBreakpoint();
  }
})();
