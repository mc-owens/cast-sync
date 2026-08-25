(function () {
  var THEMES = [
    // flat colors
    { id: 'plain',       label: 'Plain',   bg: '#f9fafb',                                 type: 'color' },
    { id: 'pink',        label: 'Pink',    bg: '#fce4ec',                                 type: 'color' },
    { id: 'sky',         label: 'Sky',     bg: '#e3f2fd',                                 type: 'color' },
    { id: 'sage',        label: 'Sage',    bg: '#e8f5e9',                                 type: 'color' },
    { id: 'butter',      label: 'Butter',  bg: '#fffde7',                                 type: 'color' },
    { id: 'lilac',       label: 'Lilac',   bg: '#f3e5f5',                                 type: 'color' },
    // ombre
    { id: 'ombre-rose',  label: 'Rose',    bg: 'linear-gradient(150deg,#fce4ec,#e0c8f0)', type: 'ombre' },
    { id: 'ombre-ocean', label: 'Ocean',   bg: 'linear-gradient(150deg,#d8eeff,#c0f0e0)', type: 'ombre' },
    { id: 'ombre-peach', label: 'Peach',   bg: 'linear-gradient(150deg,#ffe0c8,#fce4ec)', type: 'ombre' },
    // animated
    { id: 'funfetti',    label: 'Funfetti', bg: '#fff',    icon: '🎊', type: 'fun' },
    { id: 'glitter',     label: 'Glitter',  bg: '#faf7ff', icon: '✨', type: 'fun' },
  ];

  var LS_KEY = 'auditionee_theme';
  var active  = localStorage.getItem(LS_KEY) || 'plain';
  var overlay = null;
  var panel   = null;

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

  function rand(min, max) { return Math.random() * (max - min) + min; }
  function pick(arr)       { return arr[Math.floor(Math.random() * arr.length)]; }

  function spawnFunfetti() {
    var c = makeOverlay();
    var colors = ['#FF6B9D','#FFD166','#06D6A0','#118AB2','#EF476F','#9C89B8','#F4A261','#43BCCD','#FF99C8','#C3F73A','#FF85A1','#70D6FF','#FFBE0B','#FB5607'];

    // Colored shape pieces
    for (var i = 0; i < 80; i++) {
      var el   = document.createElement('div');
      el.className = 'tp-confetti';
      var size   = rand(7, 16);
      var shape  = Math.random();
      var rot    = Math.round(rand(0, 360));
      el.style.cssText = [
        'left:'    + rand(0, 100).toFixed(1) + '%',
        'top:'     + rand(0, 100).toFixed(1) + '%',
        'width:'   + size.toFixed(1) + 'px',
        'height:'  + (shape > 0.6 ? size * 0.42 : shape > 0.3 ? size : size * 0.7).toFixed(1) + 'px',
        'background:' + pick(colors),
        'border-radius:' + (shape > 0.6 ? '2px' : shape > 0.3 ? '50%' : '3px'),
        '--dur:'   + rand(2, 4.5).toFixed(2) + 's',
        '--delay:' + rand(0, 3).toFixed(2)   + 's',
        '--rot:'   + rot + 'deg',
      ].join(';');
      c.appendChild(el);
    }

    // Star characters scattered in
    var starChars  = ['★','✦','✧','✴','✸'];
    var starColors = ['#FF6B9D','#FFD166','#06D6A0','#EF476F','#9C89B8','#F4A261','#43BCCD','#FF99C8','#FFBE0B'];
    for (var j = 0; j < 30; j++) {
      var star = document.createElement('span');
      star.className = 'tp-confetti-star';
      star.textContent = pick(starChars);
      var rot2 = Math.round(rand(0, 360));
      star.style.cssText = [
        'left:'      + rand(0, 100).toFixed(1) + '%',
        'top:'       + rand(0, 100).toFixed(1) + '%',
        'font-size:' + rand(14, 26).toFixed(1) + 'px',
        'color:'     + pick(starColors),
        '--dur:'     + rand(2.5, 5).toFixed(2) + 's',
        '--delay:'   + rand(0, 3.5).toFixed(2) + 's',
        '--rot:'     + rot2 + 'deg',
      ].join(';');
      c.appendChild(star);
    }
  }

  function spawnGlitter() {
    var c = makeOverlay();
    var chars  = ['✦','✧','★','✴','✸','✵','✰','⭐','✱','✲'];
    var colors = ['#FFD700','#C0C0C0','#FF69B4','#D8B4FE','#F8C8E4','#FFE066','#B0C4FF','#FFB6C1','#E0B0FF','#FFFACD','#D4AF37','#A8D8FF'];

    for (var i = 0; i < 85; i++) {
      var el  = document.createElement('span');
      var dim = Math.random() > 0.45; // half stay partially visible at all times
      el.className = 'tp-sparkle' + (dim ? ' tp-dim' : '');
      el.textContent = pick(chars);
      el.style.cssText = [
        'left:'      + rand(0, 100).toFixed(1) + '%',
        'top:'       + rand(0, 100).toFixed(1) + '%',
        'font-size:' + rand(12, 30).toFixed(1) + 'px',
        'color:'     + pick(colors),
        '--dur:'     + rand(1.3, 4).toFixed(2) + 's',
        '--delay:'   + rand(0, 5).toFixed(2)   + 's',
      ].join(';');
      c.appendChild(el);
    }
  }

  function swatchHTML(t) {
    var cls   = 'tp-swatch' + (t.id === active ? ' tp-active' : '');
    var inner = t.icon || '';
    return '<button class="' + cls + '" data-theme-id="' + t.id + '" title="' + t.label + '" style="background:' + t.bg + ';">' + inner + '</button>';
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'tp-panel';

    var colorRow = THEMES.filter(function (t) { return t.type === 'color'; }).map(swatchHTML).join('');
    var ombreRow = THEMES.filter(function (t) { return t.type === 'ombre'; }).map(swatchHTML).join('');
    var funRow   = THEMES.filter(function (t) { return t.type === 'fun';   }).map(swatchHTML).join('');

    panel.innerHTML =
      '<div class="tp-panel-title">Your vibe</div>' +
      '<div class="tp-section-label">Colors</div>'  +
      '<div class="tp-row">' + colorRow + '</div>'  +
      '<div class="tp-section-label">Ombre</div>'   +
      '<div class="tp-row">' + ombreRow + '</div>'  +
      '<div class="tp-section-label">Fun</div>'     +
      '<div class="tp-row">' + funRow + '</div>';

    document.body.appendChild(panel);

    panel.querySelectorAll('.tp-swatch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        applyTheme(sw.dataset.themeId);
        panel.classList.remove('tp-open');
      });
    });

    document.addEventListener('click', function (e) {
      var btn = document.getElementById('tp-btn');
      if (panel.classList.contains('tp-open') && e.target !== btn && !panel.contains(e.target)) {
        panel.classList.remove('tp-open');
      }
    });
  }

  function injectNavBtn() {
    var rn = document.getElementById('right-nav');
    if (!rn || rn.querySelector('#tp-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'tp-btn';
    btn.textContent = '🎨';
    btn.title = 'Change theme';
    btn.setAttribute('aria-label', 'Change theme');
    rn.prepend(btn);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('tp-open');
    });
  }

  function init() {
    buildPanel();
    injectNavBtn();

    // Re-inject button if page JS overwrites #right-nav content
    var rn = document.getElementById('right-nav');
    if (rn) {
      new MutationObserver(injectNavBtn).observe(rn, { childList: true });
    }

    applyTheme(active);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
