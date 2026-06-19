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
      { label: 'Availability',  href: 'search.html' },
    ]},
    { section: 'Production', items: [
      { label: 'Master Schedule', href: 'master.html' },
      { label: 'Cast Builder',    href: 'cast.html' },
      { label: 'Casting',         href: 'casting.html' },
    ]},
    { section: 'Operations', items: [
      { label: 'Attendance',       href: 'attendance.html' },
      { label: 'Absence Requests', href: 'absence-requests.html' },
      { label: 'Production Notes', href: 'notes.html' },
    ]},
    { section: 'Settings', items: [
      { label: 'Production Settings', href: null, comingSoon: true },
      { label: 'Billing',             href: 'account.html' },
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
