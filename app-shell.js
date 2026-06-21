(function () {
  // Single source of truth for the director sidebar. To add a future page, add one
  // entry here under whichever existing category it fits (Auditions / Production /
  // Operations / Settings) -- never add a new top-level category, and never touch the
  // 10 director pages' own HTML to add a nav item again.
  const NAV_SECTIONS = [
    { section: 'Auditions', items: [
      // id matters here: form-builder.html's own script looks up #form-nav-link
      // directly to remove the active state when viewing the org-level template
      // (scope=org) instead of a specific season's form -- keep this id stable.
      { label: 'Audition Form', href: 'form-builder.html?scope=season', matchHref: 'form-builder.html', id: 'form-nav-link' },
      { label: 'Auditionees',   href: 'dancers.html' },
    ]},
    { section: 'Production', items: [
      { label: 'Master Schedule',       href: 'master.html' },
      { label: 'Availability Analysis', href: 'search.html' },
      { label: 'Piece Builder',         href: 'cast.html' },
      { label: 'Cast List',             href: 'casting.html' },
    ]},
    { section: 'Operations', items: [
      { label: 'Attendance',       href: 'attendance.html' },
      { label: 'Absence Requests', href: 'absence-requests.html' },
      { label: 'Production Notes', href: 'notes.html' },
    ]},
    { section: 'Settings', items: [
      { label: 'Production Settings', href: 'production-settings.html' },
      { label: 'Faculty',             href: 'faculty.html' },
      { label: 'Account',             href: 'account.html' },
      { label: 'Billing',             href: 'billing.html' },
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
      return `<span class="app-sidebar-link disabled">${item.label}${item.comingSoon ? ' <span class="badge-coming-soon">Coming Soon</span>' : ''}</span>`;
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
        <ul class="navbar-nav app-shell-context-seam"></ul>
        <div id="right-nav" class="app-nav-right app-shell-right"></div>
      </header>
    `;
  }

  // Replaces the old "Account" link in the header's right-nav (Account now lives in the
  // sidebar above, making that link redundant) with a dropdown for switching between
  // productions -- most director pages had no way back to the org/production hub at all
  // before this. Synchronous like the rest of this file; the actual production list is
  // fetched lazily by initProductionSwitcher() only once the dropdown is opened, not on
  // every page load.
  window.renderProductionSwitcher = function (user) {
    return `
      <div class="dropdown d-inline-block">
        <button class="btn-nav-account dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" id="prod-switcher-btn">
          ${user.seasonName || 'Productions'}
        </button>
        <ul class="dropdown-menu dropdown-menu-end" id="prod-switcher-menu" style="min-width:220px;font-size:13px;">
          <li><span class="dropdown-item-text text-muted" style="font-size:12px;">Loading…</span></li>
        </ul>
      </div>
    `;
  };

  window.initProductionSwitcher = function () {
    const btn  = document.getElementById('prod-switcher-btn');
    const menu = document.getElementById('prod-switcher-menu');
    if (!btn || !menu) return;
    let loaded = false;
    btn.addEventListener('show.bs.dropdown', async () => {
      if (loaded) return;
      loaded = true;
      try {
        const orgsRes = await fetch('/api/orgs');
        const orgs = await orgsRes.json();
        const allSeasons = [];
        for (const org of orgs) {
          const seasonsRes = await fetch(`/api/orgs/${org.id}/seasons`);
          const seasons = await seasonsRes.json();
          seasons.forEach(s => allSeasons.push({ orgId: org.id, orgName: org.name, seasonId: s.id, seasonName: s.name }));
        }
        if (allSeasons.length === 0) {
          menu.innerHTML = `<li><a class="dropdown-item" href="org-select.html">Go to Organizations</a></li>`;
          return;
        }
        menu.innerHTML = allSeasons.map(s => `
          <li><a class="dropdown-item prod-switch-item" href="#" data-org-id="${s.orgId}" data-season-id="${s.seasonId}">
            ${s.seasonName}
            <div class="text-muted" style="font-size:11px;">${s.orgName}</div>
          </a></li>`).join('') +
          `<li><hr class="dropdown-divider"></li>
           <li><a class="dropdown-item" href="org-select.html">All Organizations</a></li>`;
        menu.querySelectorAll('.prod-switch-item').forEach(item => {
          item.addEventListener('click', async (e) => {
            e.preventDefault();
            await fetch('/api/session/org', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orgId: item.dataset.orgId, seasonId: item.dataset.seasonId }),
            });
            window.location.reload();
          });
        });
      } catch (e) {
        menu.innerHTML = `<li><span class="dropdown-item-text text-danger" style="font-size:12px;">Could not load productions.</span></li>`;
      }
    });
  };

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

  const root = document.getElementById('app-shell-root');
  if (root) {
    root.insertAdjacentHTML('beforebegin', renderHeader());
    root.insertAdjacentHTML('afterend', renderSidebar());
    root.remove();
    watchBreakpoint();
  }
})();
