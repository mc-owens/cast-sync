/* Password show/hide toggle — drop <script src="pw-toggle.js"> into any page */
(function () {
  const EYE_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_OFF  = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  function init() {
    document.querySelectorAll('input[type="password"]').forEach(input => {
      // Don't double-wrap
      if (input.parentElement.classList.contains('pw-wrap')) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'pw-wrap';
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'pw-eye';
      btn.title     = 'Show/hide password';
      btn.innerHTML = EYE_OPEN;
      wrapper.appendChild(btn);

      btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type    = showing ? 'password' : 'text';
        btn.innerHTML = showing ? EYE_OPEN : EYE_OFF;
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
