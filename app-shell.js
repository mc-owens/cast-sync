(function () {
  // Single source of truth for the director sidebar. To add a future page, add one
  // entry here under whichever existing category it fits (Auditions / Production /
  // Operations / Settings) -- never add a new top-level category, and never touch the
  // 10 director pages' own HTML to add a nav item again.
  const NAV_SECTIONS = [
    { section: null, items: [
      { label: 'Dashboard', href: 'dashboard.html' },
    ]},
    { section: 'Auditions', items: [
      // id matters here: form-builder.html's own script looks up #form-nav-link
      // directly to remove the active state when viewing the org-level template
      // (scope=org) instead of a specific season's form -- keep this id stable.
      { label: 'Audition Form', href: 'form-builder.html?scope=season', matchHref: 'form-builder.html', id: 'form-nav-link' },
      { label: 'Auditionees',   href: 'dancers.html' },
    ]},
    { section: 'Production', items: [
      { label: 'Production Timeline', href: 'master.html' },
      { label: 'Casting Availability', href: 'search.html' },
      { label: 'Cast Builder',         href: 'cast.html' },
      { label: 'Cast List',            href: 'casting.html' },
    ]},
    { section: 'Operations', items: [
      { label: 'Attendance',       href: 'attendance.html' },
      { label: 'Absence Requests', href: 'absence-requests.html' },
      { label: 'Production Notes', href: 'notes.html' },
      { label: 'My Private Notes', href: 'my-notes.html' },
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
        ${section ? `<div class="app-sidebar-section-label">${section}</div>` : ''}
        ${items.map(renderSidebarItem).join('')}
      </div>
    `).join('');
    const guideActive = location.pathname.split('/').pop() === 'guide.html' ? ' active' : '';
    return `
      <nav class="app-sidebar offcanvas offcanvas-start" tabindex="-1" id="appSidebar" aria-labelledby="appSidebarLabel">
        <div class="offcanvas-header app-sidebar-mobile-header">
          <h5 class="offcanvas-title" id="appSidebarLabel">Menu</h5>
          <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
        </div>
        <div class="offcanvas-body app-sidebar-body">
          ${sections}
          <div class="app-sidebar-section" style="border-top:1px solid #f0f0f0;margin-top:4px;padding-top:4px;">
            <a class="app-sidebar-link${guideActive}" href="guide.html"
              style="font-size:12.5px;color:#9ca3af;">Help &amp; Guide</a>
          </div>
        </div>
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
        <button id="app-help-btn" type="button" aria-label="Open help"
          style="width:26px;height:26px;border-radius:50%;border:1.5px solid #d1d5db;background:transparent;font-size:12px;font-weight:700;color:#9ca3af;cursor:pointer;flex-shrink:0;margin-right:10px;line-height:1;padding:0;">?</button>
        <div id="right-nav" class="app-nav-right app-shell-right"></div>
      </header>
    `;
  }

  // ── Help system ────────────────────────────────────────────────────────────

  function renderHelpOffcanvas() {
    return `
      <div class="offcanvas offcanvas-end" id="helpOffcanvas" tabindex="-1" aria-labelledby="helpOffcanvasLabel"
        style="width:400px;max-width:90vw;">
        <div class="offcanvas-header" style="border-bottom:1px solid #f3f4f6;padding:16px 20px 14px;">
          <div>
            <h5 class="offcanvas-title mb-0" id="helpOffcanvasLabel"
              style="font-weight:700;font-size:15px;">Help</h5>
            <div id="help-page-label" style="font-size:12px;color:#9ca3af;margin-top:2px;"></div>
          </div>
          <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close help"></button>
        </div>
        <div class="offcanvas-body" id="help-body"
          style="padding:20px 24px;font-size:13.5px;line-height:1.6;overflow-y:auto;"></div>
      </div>
    `;
  }

  function openHelp() {
    const page    = location.pathname.split('/').pop() || 'dashboard.html';
    const content = window.HELP_CONTENT?.[page];
    const body    = document.getElementById('help-body');
    const label   = document.getElementById('help-page-label');

    if (!body) return;

    if (label) {
      const allItems = NAV_SECTIONS.flatMap(s => s.items);
      const navItem  = allItems.find(item => (item.matchHref || item.href).split('?')[0] === page);
      label.textContent = navItem ? navItem.label : '';
    }

    if (!content) {
      body.innerHTML = `
        <p style="color:#6b7280;margin-bottom:16px;">No specific help for this page yet.</p>
        <a href="guide.html" style="color:#111;font-size:13px;">Open Help &amp; Guide &rarr;</a>
      `;
    } else {
      let html = '';
      if (content.intro) {
        html += `<p style="color:#374151;margin-bottom:22px;">${content.intro}</p>`;
      }
      (content.sections || []).forEach(s => {
        html += `
          <div style="margin-bottom:18px;">
            <div style="font-weight:700;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;
              color:#374151;margin-bottom:5px;">${s.heading}</div>
            <div style="color:#4b5563;font-size:13px;line-height:1.6;">${s.body}</div>
          </div>
        `;
      });
      html += `
        <div style="margin-top:28px;padding-top:16px;border-top:1px solid #f3f4f6;">
          <a href="guide.html" style="color:#9ca3af;font-size:12px;">Full Help &amp; Guide &rarr;</a>
        </div>
      `;
      body.innerHTML = html;
    }

    if (window.bootstrap) {
      bootstrap.Offcanvas.getOrCreateInstance(
        document.getElementById('helpOffcanvas')
      ).show();
    }
  }

  function maybeShowHelpHint() {
    if (localStorage.getItem('csHelpHintDismissed')) return;
    const hint = document.createElement('div');
    hint.id = 'cs-help-hint';
    hint.innerHTML = `
      <div style="position:absolute;top:-8px;right:16px;width:14px;height:14px;background:#111;transform:rotate(45deg);border-radius:2px;"></div>
      <div style="font-weight:700;font-size:13px;margin-bottom:7px;color:#fff;">Finding your way around</div>
      <div style="font-size:12.5px;color:rgba(255,255,255,.8);line-height:1.55;">
        The <strong style="color:#fff;">?</strong> button at the top right opens a help panel specific to whichever page you're on. Each page has its own tips and explanations.<br><br>
        For full walkthroughs, open <strong style="color:#fff;">Help &amp; Guide</strong> at the bottom of the left sidebar.
      </div>
      <div style="text-align:right;margin-top:12px;">
        <button id="cs-help-hint-dismiss" style="background:rgba(255,255,255,.18);border:none;color:#fff;padding:5px 16px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600;">Got it</button>
      </div>
    `;
    Object.assign(hint.style, {
      position: 'fixed',
      top: '50px',
      right: '10px',
      width: '260px',
      background: '#111',
      borderRadius: '10px',
      padding: '16px 18px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)',
      zIndex: '8000',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    });
    document.body.appendChild(hint);
    document.getElementById('cs-help-hint-dismiss').addEventListener('click', () => {
      localStorage.setItem('csHelpHintDismissed', '1');
      hint.remove();
    });
    // Also dismiss if the user opens the ? help panel
    const helpBtn = document.getElementById('app-help-btn');
    if (helpBtn) {
      helpBtn.addEventListener('click', () => {
        localStorage.setItem('csHelpHintDismissed', '1');
        hint.remove();
      }, { once: true });
    }
  }

  function mountHelpSystem() {
    document.body.insertAdjacentHTML('beforeend', renderHelpOffcanvas());

    const helpBtn = document.getElementById('app-help-btn');
    if (helpBtn) helpBtn.addEventListener('click', openHelp);

    // Load help content eagerly so it is ready on first click.
    // The file is small and does not block rendering.
    const s   = document.createElement('script');
    s.src     = 'help-content.js';
    s.async   = true;
    document.head.appendChild(s);
  }

  // ── Production switcher ────────────────────────────────────────────────────

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
          <li><span class="dropdown-item-text text-muted" style="font-size:12px;">Loading&hellip;</span></li>
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
    mountHelpSystem();
    maybeShowHelpHint();
  }
})();
