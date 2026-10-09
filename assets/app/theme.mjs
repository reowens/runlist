// Run before the stylesheet so a saved theme also applies to the first paint.
(() => {
  const key = 'runlist:appearance', system = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = valid(localStorage.getItem(key)); } catch { /* A theme still works without storage. */ }
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    const control = document.getElementById('theme-mode');
    if (control) control.value = preference;
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.getElementById('theme-mode');
    apply();
    control.addEventListener('change', () => {
      preference = valid(control.value); apply();
      try { localStorage.setItem(key, preference); } catch { /* Keep the selected appearance for this tab. */ }
    });
  });
})();
