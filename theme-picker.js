(function () {
  var THEMES = [
    // flat colors
    { id: 'plain',       label: 'Plain',   bg: '#f9fafb',                                          type: 'color' },
    { id: 'pink',        label: 'Pink',    bg: '#fce4ec',                                          type: 'color' },
    { id: 'sky',         label: 'Sky',     bg: '#e3f2fd',                                          type: 'color' },
    { id: 'sage',        label: 'Sage',    bg: '#e8f5e9',                                          type: 'color' },
    { id: 'butter',      label: 'Butter',  bg: '#fffde7',                                          type: 'color' },
    { id: 'lilac',       label: 'Lilac',   bg: '#f3e5f5',                                          type: 'color' },
    // ombre
    { id: 'ombre-rose',  label: 'Rose',    bg: 'linear-gradient(150deg,#fce4ec,#e0c8f0)',          type: 'ombre' },
    { id: 'ombre-ocean', label: 'Ocean',   bg: 'linear-gradient(150deg,#d8eeff,#c0f0e0)',          type: 'ombre' },
    { id: 'ombre-peach', label: 'Peach',   bg: 'linear-gradient(150deg,#ffe0c8,#fce4ec)',          type: 'ombre' },
    // animated
    { id: 'funfetti',    label: 'Funfetti', bg: '#fff',    icon: '🎊', type: 'fun' },
    { id: 'glitter',     label: 'Glitter',  bg: '#faf7ff', icon: '✨', type: 'fun' },
  ];

  var LS_KEY = 'auditionee_theme';
  var active  = localStorage.getItem(LS_KEY) || 'plain';
  var overlay = null;

  function applyTheme(id) {
    active = id;
    localStorage.setItem(LS_KEY, id);

    if (id === 'plain') {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.dataset.theme = id;
    }

    if (overlay) { overlay.remove(); overlay = null; }
    if (id === 'funfetti') spawnFunfetti();
    if (id === 'glitter')  spawnGlitter();

    document.querySelectorAll('.tp-swatch').forEach(function (el) {
      el.classList.toggle('tp-active', el.dataset.themeId === id);
    });
  }

  function makeOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'tp-overlay';
    document.body.appendChild(overlay);
    return overlay;
  }

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function spawnFunfetti() {
    var c = makeOverlay();
    var colors = ['#FF6B9D','#FFD166','#06D6A0','#118AB2','#EF476F','#9C89B8','#F4A261','#43BCCD','#FF99C8','#C3F73A','#FF85A1','#70D6FF'];
    for (var i = 0; i < 70; i++) {
      var el   = document.createElement('div');
      el.className = 'tp-confetti';
      var size   = rand(5, 14);
      var isRect = Math.random() > 0.55;
      var rot    = Math.round(rand(0, 360));
      el.style.cssText = [
        'left:'    + rand(0,100).toFixed(1) + '%',
        'top:'     + rand(0,100).toFixed(1) + '%',
        'width:'   + size.toFixed(1) + 'px',
        'height:'  + (isRect ? size * 0.42 : size).toFixed(1) + 'px',
        'background:' + colors[Math.floor(Math.random() * colors.length)],
        'border-radius:' + (isRect ? '2px' : '50%'),
        '--dur:'   + rand(2, 4.5).toFixed(2) + 's',
        '--delay:' + rand(0, 3).toFixed(2) + 's',
        '--rot:'   + rot + 'deg',
      ].join(';');
      c.appendChild(el);
    }
  }

  function spawnGlitter() {
    var c = makeOverlay();
    var chars  = ['✦','✧','✴','⋆','✱','✸','·','★','✵'];
    var colors = ['#FFD700','#C0C0C0','#FF69B4','#D8B4FE','#F8C8E4','#E0B0FF','#FFFACD','#B8D4FF','#FFB6C1'];
    for (var i = 0; i < 60; i++) {
      var el = document.createElement('span');
      el.className = 'tp-sparkle';
      el.textContent = chars[Math.floor(Math.random() * chars.length)];
      el.style.cssText = [
        'left:'     + rand(0,100).toFixed(1) + '%',
        'top:'      + rand(0,100).toFixed(1) + '%',
        'font-size:'+ rand(8, 22).toFixed(1) + 'px',
        'color:'    + colors[Math.floor(Math.random() * colors.length)],
        '--dur:'    + rand(1.4, 4).toFixed(2) + 's',
        '--delay:'  + rand(0, 5).toFixed(2) + 's',
      ].join(';');
      c.appendChild(el);
    }
  }

  function buildPicker() {
    var container = document.createElement('div');
    container.id = 'tp-container';

    function swatchHTML(t) {
      var cls = 'tp-swatch' + (t.id === active ? ' tp-active' : '');
      var inner = t.icon || '';
      return '<button class="' + cls + '" data-theme-id="' + t.id + '" title="' + t.label + '" style="background:' + t.bg + ';">' + inner + '</button>';
    }

    var colorRow  = THEMES.filter(function (t) { return t.type === 'color'; }).map(swatchHTML).join('');
    var ombreRow  = THEMES.filter(function (t) { return t.type === 'ombre'; }).map(swatchHTML).join('');
    var funRow    = THEMES.filter(function (t) { return t.type === 'fun';   }).map(swatchHTML).join('');

    container.innerHTML =
      '<button id="tp-btn" title="Change theme" aria-label="Change theme">🎨</button>' +
      '<div id="tp-panel">' +
        '<div class="tp-panel-title">Your vibe</div>' +
        '<div class="tp-section-label">Colors</div>' +
        '<div class="tp-row">' + colorRow + '</div>' +
        '<div class="tp-section-label">Ombre</div>' +
        '<div class="tp-row">' + ombreRow + '</div>' +
        '<div class="tp-section-label">Fun</div>' +
        '<div class="tp-row">' + funRow + '</div>' +
      '</div>';

    document.body.appendChild(container);

    var btn   = document.getElementById('tp-btn');
    var panel = document.getElementById('tp-panel');

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('tp-open');
    });

    document.addEventListener('click', function (e) {
      if (!container.contains(e.target)) panel.classList.remove('tp-open');
    });

    container.querySelectorAll('.tp-swatch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        applyTheme(sw.dataset.themeId);
        panel.classList.remove('tp-open');
      });
    });
  }

  function init() {
    buildPicker();
    applyTheme(active);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
