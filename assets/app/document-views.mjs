const panels = {read:'reading', edit:'editing', review:'reviewing', source:'source-view'};
const modes = Object.keys(panels);

// Keep the active tab focusable, associate each tab with its panel, and provide
// the conventional arrow/Home/End navigation without capturing editor keys.
export function documentViews({$, view}) {
  $('document-tabs').addEventListener('keydown', event => {
    const current = modes.findIndex(mode => event.target === $('tab-' + mode));
    if (current < 0) return;
    let next;
    if (event.key === 'ArrowRight') next = (current + 1) % modes.length;
    else if (event.key === 'ArrowLeft') next = (current + modes.length - 1) % modes.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = modes.length - 1;
    else return;
    event.preventDefault();
    // Read-only documents disable editing; skip unavailable tabs in order.
    const step = event.key === 'ArrowLeft' || event.key === 'End' ? -1 : 1;
    for (let tried = 0; tried < modes.length; tried++) {
      const tab = $('tab-' + modes[next]);
      if (!tab.disabled) { view(modes[next]); tab.focus(); return; }
      next = (next + step + modes.length) % modes.length;
    }
  });
  return {update(mode) {
    for (const name of modes) {
      const selected = name === mode, tab = $('tab-' + name);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(panels[name]).hidden = !selected;
    }
  }};
}
