/** Read-only filing report. Construction never requests or scans documents. */
export function filingNavigation({ state, $, api, open, showLibrary, checkout, notice }) {
  const root = $('filing-home');
  let scanId = null, sequence = 0, detailSequence = 0, offset = 0, selected = null, timer, owner;
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (label, action) => { const node = element('button', label, 'quiet small'); node.type = 'button'; node.onclick = run(action); return node; };
  const run = fn => async () => { try { await fn(); } catch (error) { notice(error.message, true); } };
  const heading = element('h1', 'Filing'); heading.id = 'filing-title'; heading.tabIndex = -1;
  const description = element('p', 'Where live plans are homed in status-bearing hub table rows. Links in prose are references. This report changes no files.', 'muted');
  const feedback = element('p'); feedback.id = 'filing-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const totals = element('div', undefined, 'filing-totals'); totals.id = 'filing-totals';
  const controls = element('div', undefined, 'filing-controls');
  const searchLabel = element('label', 'Find a plan');
  const search = element('input'); search.type = 'search'; search.id = 'filing-search'; search.placeholder = 'Title or path…'; searchLabel.append(search);
  const groupLabel = element('label', 'Show');
  const group = element('select'); group.id = 'filing-group';
  for (const [value, label] of [['all', 'All plans'], ['unfiled', 'Unfiled'], ['multiple', 'Multiple homes'], ['no-category', 'No category'], ['parent', 'Through parent'], ['direct', 'Direct home']]) {
    const option = element('option', label); option.value = value; group.append(option);
  }
  groupLabel.append(group);
  const refresh = button('Refresh', () => load({ refresh: true })); refresh.id = 'filing-refresh';
  controls.append(searchLabel, groupLabel, refresh);
  const range = element('p', '', 'muted'); range.id = 'filing-range';
  const layout = element('div', undefined, 'filing-layout');
  const list = element('div', undefined, 'filing-list'); list.id = 'filing-list';
  const detail = element('section', undefined, 'filing-detail'); detail.id = 'filing-detail'; detail.setAttribute('aria-label', 'Filing evidence');
  layout.append(list, detail);
  const pager = element('div', undefined, 'filing-pagination');
  const previous = button('Previous', () => { offset = Math.max(0, offset - 50); return load(); }); previous.id = 'filing-previous';
  const next = button('Next', () => { offset += 50; return load(); }); next.id = 'filing-next';
  pager.append(previous, next);
  root.replaceChildren(heading, description, controls, feedback, totals, range, layout, pager);
  const visible = () => state.mode === 'filing' && !root.hidden;
  const call = (op, params = {}) => api(`filing?${new URLSearchParams({ op, ...(scanId ? { scanId } : {}), ...params })}`);
  const label = plan => plan.filing === 'parent' ? `Through parent · ${plan.filedThrough}` : plan.filing === 'direct' ? 'Direct home' : plan.filing === 'unfiled' ? 'Unfiled' : plan.filing === 'observed' ? 'Observed home evidence · incomplete scan' : 'Home unknown · incomplete scan';
  function deactivate() { sequence++; detailSequence++; clearTimeout(timer); root.hidden = true; $('library-filing').setAttribute('aria-pressed', 'false'); }
  function invalidate() {
    sequence++; detailSequence++; scanId = null;
    if (visible()) { feedback.textContent = 'Saved files changed. Refresh to review current filing evidence.'; list.setAttribute('aria-busy', 'false'); refresh.disabled = false; search.disabled = false; group.disabled = false; previous.disabled = true; next.disabled = true; }
  }
  function renderSummary(result) {
    if (!result.enabled) feedback.textContent = result.reason;
    else if (result.state === 'scanning') feedback.textContent = `Reading filing evidence… ${result.progress.done} of ${result.progress.total} documents checked.`;
    else if (!result.complete) feedback.textContent = result.reason ?? 'Scan incomplete. Observed evidence is available; unfiled and unique-home findings are unavailable. Refresh to retry.';
    else feedback.textContent = `${result.totals.plans} live plans checked. Finding groups may overlap.`;
    totals.replaceChildren();
    if (result.totals) for (const [key, title] of [['unfiled', 'Unfiled'], ['multiplyFiled', 'Multiple homes'], ['noCategory', 'No category'], ['filedThroughParent', 'Through parent']]) totals.append(element('span', `${title}: ${result.totals[key]}`));
    if (result.failureCount) {
      const failures = element('details'), summary = element('summary', `${result.failureCount} unavailable sources or folders`); failures.append(summary);
      for (const failure of result.failures ?? []) failures.append(element('p', `${failure.path ?? 'Inventory'}: ${failure.message}`));
      if (result.failureCount > (result.failures?.length ?? 0)) failures.append(element('p', 'Additional failures omitted. Narrow the source problem and refresh.'));
      totals.append(failures);
    }
    for (const option of group.options) option.disabled = option.value !== 'all' && !result.complete;
    if (!result.complete) group.value = 'all';
  }
  function renderPage(result) {
    renderSummary(result); offset = result.offset ?? 0;
    range.textContent = result.total ? `${offset + 1}–${offset + result.plans.length} of ${result.total} plans` : '0 plans';
    previous.disabled = !offset; next.disabled = !result.hasMore;
    list.replaceChildren(...(result.plans ?? []).map(plan => {
      const row = button('', () => inspect(plan.path)); row.className = 'filing-plan quiet'; row.setAttribute('aria-pressed', String(selected === plan.path)); row.dataset.path = plan.path;
      row.append(element('strong', plan.title), element('span', plan.path, 'muted'), element('span', label(plan)));
      if (plan.multiplyFiled) row.append(element('small', 'Multiple homes'));
      if (plan.noCategory) row.append(element('small', 'No category'));
      return row;
    }));
    if (!result.plans?.length) list.append(element('p', result.complete ? 'No plans match this filter.' : result.enabled ? 'No plan evidence is available in this scan.' : 'Enable filing in the repository configuration to use this report.', 'library-no-results'));
  }
  async function inspect(path, homeOffset = 0) {
    if (!scanId || !visible()) return;
    const own = ++detailSequence; selected = path;
    for (const row of list.querySelectorAll('[data-path]')) row.setAttribute('aria-pressed', String(row.dataset.path === path));
    detail.setAttribute('aria-busy', 'true');
    try {
      const result = await call('detail', { path, homeOffset: String(homeOffset), homeLimit: '20' });
      if (own !== detailSequence || !visible()) return;
      const nodes = [element('h2', result.title), element('p', result.path, 'muted'), element('p', label(result)), button('Open plan', () => open(result.path))];
      if (result.filedThrough && result.filedThrough !== result.path) nodes.push(button('Open parent home', () => open(result.filedThrough)));
      if (!result.homes.length) nodes.push(element('p', result.complete ? 'No status-bearing hub subject row homes this plan.' : 'No home observed. Missing sources prevent an unfiled finding.'));
      for (const home of result.homes) {
        const row = element('article', undefined, 'filing-home-row');
        row.append(element('h3', `${home.hub}:${home.line}`), element('p', `Categories: ${home.categories.join(', ') || (result.complete ? 'No category' : 'No category observed · incomplete scan')}`), element('p', `Subject: ${home.subject} · Printed status: ${home.printedStatus}`));
        if (home.categoriesShortened) row.append(element('p', 'Category display shortened. Open the hub for its full categories.', 'muted'));
        if (home.current === 'unchanged') row.append(button('Open hub row', () => open(home.hub, { line: home.line, expectedRevision: home.revision })));
        else { row.append(element('p', home.current === 'changed' ? 'Hub changed after this scan. Refresh before using this row location.' : 'Hub source is currently unavailable.', 'inline-note')); row.append(button('Open current hub', () => open(home.hub))); }
        nodes.push(row);
      }
      if (result.totalHomes) nodes.push(element('p', `${result.homeOffset + 1}–${result.homeOffset + result.homes.length} of ${result.totalHomes} home rows`, 'muted'));
      if (result.homeOffset) nodes.push(button('Previous home rows', () => inspect(path, Math.max(0, result.homeOffset - 20))));
      if (result.hasMoreHomes) nodes.push(button('More home rows', () => inspect(path, result.homeOffset + 20)));
      detail.replaceChildren(...nodes);
    } catch (error) { if (own === detailSequence && visible()) detail.replaceChildren(element('p', `${error.message} Refresh to review current evidence.`, 'inline-note')); throw error; }
    finally { if (own === detailSequence) detail.setAttribute('aria-busy', 'false'); }
  }
  async function load({ refresh: force = false } = {}) {
    if (!visible()) return;
    if (!force && !scanId) { feedback.textContent = 'Refresh to review current filing evidence.'; return; }
    const own = ++sequence; list.setAttribute('aria-busy', 'true'); refresh.disabled = true;
    if (force) { search.disabled = true; group.disabled = true; previous.disabled = true; next.disabled = true; }
    try {
      if (force) {
        selected = null; detailSequence++; offset = 0; detail.replaceChildren(element('p', 'Select a plan to inspect its exact home evidence.', 'muted'));
        let result = await call('start', { refresh: '1' });
        if (own !== sequence || !visible()) return;
        scanId = result.scanId ?? null; renderSummary(result);
        while (result.state === 'scanning') {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (own !== sequence || !visible()) return;
          result = await call('advance');
          if (own !== sequence || !visible()) return;
          renderSummary(result);
        }
        if (!result.enabled) { renderPage({ ...result, plans: [], total: 0 }); return; }
      }
      const result = await call('page', { q: search.value, group: group.value, offset: String(offset), limit: '50' });
      if (own !== sequence || !visible()) return;
      renderPage(result);
    } catch (error) {
      if (own === sequence && visible()) { feedback.textContent = `${error.message} Try Refresh.`; if (error.code === 'filing-scan-stale') scanId = null; }
      throw error;
    } finally { if (own === sequence) { list.setAttribute('aria-busy', 'false'); refresh.disabled = false; search.disabled = false; group.disabled = false; } }
  }
  async function show() {
    await showLibrary();
    if (owner !== checkout()) { owner = checkout(); scanId = null; offset = 0; search.value = ''; group.value = 'all'; }
    state.mode = 'filing'; root.hidden = false; $('empty').hidden = true; $('document').hidden = true;
    for (const id of ['records-home', 'changes-home']) if ($(id)) $(id).hidden = true;
    $('workspace').classList.add('library-start'); $('doc-title').textContent = 'Filing';
    for (const name of ['all', 'hubs', 'plans', 'documents', 'flags', 'decisions', 'changes']) $('library-' + name)?.setAttribute('aria-pressed', 'false');
    $('library-filing').setAttribute('aria-pressed', 'true');
    await load({ refresh: true }); heading.focus();
  }
  $('library-filing').onclick = run(show);
  search.oninput = () => { if (search.disabled) return; clearTimeout(timer); offset = 0; timer = setTimeout(() => run(load)(), 200); };
  group.onchange = run(() => { offset = 0; return load(); });
  return { show, load, deactivate, invalidate, visible };
}
