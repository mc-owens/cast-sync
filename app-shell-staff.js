(function () {
  // Director-lite sidebar for Production Staff. Mirrors app-shell.js's rendering
  // pattern, but with a short, fixed nav and no production switcher -- staff pages
  // query by user_id across every assigned piece, not a single active org/season.
  const NAV_SECTIONS = [
    { section: 'My Productions', items: [
      { label: 'My Pieces', href: 'staff-pieces.html' },
      { label: 'Schedule',  href: 'staff-schedule.html' },
    ]},
    { section: 'Operations', items: [
      { label: 'Attendance',       href: 'staff-attendance.html' },
      { label: 'Production Notes', href: 'staff-notes.html' },
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

  const root = document.getElementById('app-shell-root');
  if (root) {
    root.insertAdjacentHTML('beforebegin', renderHeader());
    root.insertAdjacentHTML('afterend', renderSidebar());
    root.remove();
    watchBreakpoint();
  }
})();
