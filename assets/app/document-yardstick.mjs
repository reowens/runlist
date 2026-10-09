// Saved Markdown and explicit human choices; no inferred ranking or assessment.
export function documentYardstick({ state, $, api, checkout, open, library, notice }) {
  const panel = $('yardstick-panel');
  let info = null, pending = null, working = false, sequence = 0, dialog = null, activePath = null;
  const labels = { serves: 'Serves the goal', clear: 'Clear assessment', fold: 'Fold into another plan', close: 'Close plan' };
  const isPlan = () => state.doc?.type ? state.doc.type === 'plan' : state.doc?.kind === 'plan';
  const excerpt = (text, limit = 2000) => text?.length > limit
    ? `${text.slice(0, limit).trimEnd()}… [shortened; read the source for the full text]` : text;
  const key = path => `runlist:yardstick:${checkout()}:${encodeURIComponent(path)}`;
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const retained = path => {
    try {
      const direct = JSON.parse(localStorage.getItem(key(path)) ?? 'null');
      if (direct) return direct;
      for (let i = 0; i < localStorage.length; i++) {
        const location = localStorage.key(i);
        if (location.startsWith(`runlist:yardstick:${checkout()}:`)) {
          const value = JSON.parse(localStorage.getItem(location));
          if (value?.newPath === path) return value;
        }
      }
    } catch { /* Disk receipts remain discoverable in Recovery. */ }
    return null;
  };
  const remember = () => {
    try { localStorage.setItem(key(pending.path), JSON.stringify(pending)); }
    catch { notice('This review is retained on disk. Reopen it from Recovery if this window closes.', true); }
  };
  const forget = path => { try { localStorage.removeItem(key(path)); } catch {} };
  const blocked = () => state.dirty || state.pending || state.recovery && (state.recovery.source !== state.recovery.baseSource || state.recovery.pending);
  const unavailable = action => !info?.enabled || !info.actions.includes(action) || blocked() || state.busy || working;

  function update() {
    if (!panel || !info || activePath !== state.doc?.path) return;
    const note = panel.querySelector('.yardstick-availability');
    if (note) note.textContent = blocked() ? 'Save or discard the plan draft before recording an assessment.' : info.reason ?? '';
    for (const button of panel.querySelectorAll('[data-yardstick-action]')) button.disabled = unavailable(button.dataset.yardstickAction);
    if (dialog?.open) {
      const apply = dialog.querySelector('[data-yardstick-apply]');
      if (apply) apply.disabled = !pending?.comparison || pending.state !== 'reviewed' || unavailable(pending.action);
    }
  }
  function render() {
    panel.replaceChildren();
    panel.hidden = !isPlan() || !info?.comparison.goal.enabled;
    if (panel.hidden) return;
    const { goal, delivers, assessment } = info.comparison;
    const details = node('details', undefined, 'yardstick-summary');
    const assessmentLabel = assessment.issues.length ? 'Assessment needs repair'
      : ({ serves: 'Serves the goal', folded: 'Folded into another plan', closed: 'Closed' }[assessment.disposition] ?? 'Not reviewed');
    const summary = node('summary', `Product goal · ${assessmentLabel}`);
    const goalExcerpt = goal.statement?.length > 2000
      ? `${goal.statement.slice(0, 2000).trimEnd()}… [shortened; open the goal document for the full text]` : goal.statement;
    const goalText = node('p', goal.state === 'ready' ? goalExcerpt : `Goal unavailable: ${goal.message}`, 'yardstick-goal');
    details.append(summary, goalText);
    if (goal.source) {
      const source = node('button', `Open goal · ${goal.source}`, 'quiet small'); source.type = 'button';
      source.onclick = () => { if (state.busy || working) return; open(goal.source).catch(error => notice(error.message, true)); };
      details.append(source);
    }
    details.append(node('h3', 'This saved plan delivers'), node('p', delivers || 'Unset', 'yardstick-delivers'), node('h3', 'Owner assessment'), node('p', assessmentLabel));
    if (assessment.reason) details.append(node('p', assessment.reason, 'yardstick-reason'));
    if (assessment.into) {
      const replacement = node('button', `Replacement · ${assessment.into}`, 'quiet small'); replacement.type = 'button';
      replacement.onclick = async () => {
        try { const target = await api(`link?${new URLSearchParams({ ref: assessment.into, from: state.doc.path })}`); if (!target) throw new Error('The replacement plan is unavailable.'); await open(target.path); }
        catch (error) { notice(error.message, true); }
      };
      details.append(replacement);
    }
    if (assessment.reviewedEarlierGoal) details.append(node('p', 'Reviewed against an earlier goal. Review it again before keeping this assessment.', 'inline-note'));
    for (const issue of assessment.issues) details.append(node('p', issue, 'inline-note'));
    const actions = node('div', undefined, 'yardstick-actions');
    for (const action of ['serves', 'clear', 'fold', 'close']) {
      const button = node('button', labels[action], action === 'close' || action === 'fold' ? 'quiet' : 'quiet small');
      button.type = 'button'; button.dataset.yardstickAction = action;
      button.onclick = () => show(action).catch(error => notice(error.message, true)); actions.append(button);
    }
    const availability = node('p', undefined, 'yardstick-availability inline-note'); availability.setAttribute('role', 'status');
    details.append(actions, availability); panel.append(details); update();
  }
  async function opened() {
    const path = state.doc?.path, own = ++sequence;
    info = null; activePath = path;
    panel.replaceChildren(); panel.hidden = true;
    if (!isPlan()) return;
    try {
      const result = await api(`yardstick?path=${encodeURIComponent(path)}`);
      if (own !== sequence || state.doc?.path !== path) return;
      info = result; render();
    } catch (error) { if (own === sequence) notice(`Product goal unavailable. ${error.message}`, true); }
  }
  function makeDialog() {
    if (dialog) return dialog;
    dialog = node('dialog', undefined, 'yardstick-dialog'); dialog.id = 'yardstick-dialog';
    dialog.setAttribute('aria-labelledby', 'yardstick-dialog-title'); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
    return dialog;
  }
  function closeDialog() { if (!working) dialog.close(); }
  function dialogShell(title) {
    const root = makeDialog(); root.replaceChildren();
    const heading = node('h2', title); heading.id = 'yardstick-dialog-title';
    const close = node('button', 'Close', 'quiet'); close.type = 'button'; close.dataset.yardstickDismiss = ''; close.onclick = closeDialog;
    const header = node('div', undefined, 'dialog-header'); header.append(heading, close);
    root.append(header, node('p', `${state.doc.title} · ${state.doc.path}`, 'muted'));
    return root;
  }
  async function busyRun(task) {
    working = true; state.busy = true; update();
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    try { return await task(); }
    finally { working = false; state.busy = false; for (const button of dialog.querySelectorAll('button')) button.disabled = false; update(); }
  }
  async function show(action, saved = null) {
    if (state.busy || working || !state.doc) return;
    if (saved) { pending = saved; renderReview(); dialog.showModal(); return; }
    if (unavailable(action)) return;
    pending = retained(state.doc.path);
    if (pending) { renderReview(); dialog.showModal(); return; }
    form(action); dialog.showModal(); dialog.querySelector('textarea')?.focus();
  }
  function form(action, previous = {}) {
    const root = dialogShell(labels[action]), form = node('form'); form.className = 'yardstick-form';
    const description = node('p', action === 'clear' ? 'Clear the owner assessment. An archived plan stays archived; execution status is unchanged.'
      : action === 'serves' ? 'Record your assessment that this plan serves the product goal. Execution status is unchanged.'
      : action === 'fold' ? 'Archive this plan and link it to an existing replacement plan. Review the move and reference repairs before applying.'
      : 'Archive this plan with your reason. Review the move and reference repairs before applying.', 'muted');
    const reasonLabel = node('label', action === 'serves' || action === 'clear' ? 'Owner reason (optional)' : 'Owner reason');
    const reason = node('textarea'); reason.rows = 3; reason.maxLength = 4000; reason.required = action === 'fold' || action === 'close'; reason.value = previous.reason ?? ''; reasonLabel.append(reason);
    form.append(description);
    if (action !== 'clear') form.append(reasonLabel);
    let into = null;
    if (action === 'fold') {
      const searchLabel = node('label', 'Find replacement plan'), query = node('input'); query.type = 'search'; query.maxLength = 300; searchLabel.append(query);
      const find = node('button', 'Find plans', 'quiet'); find.type = 'button';
      const targetLabel = node('label', 'Replacement plan'), select = node('select'); select.required = true;
      select.add(new Option('Choose a plan', '')); targetLabel.append(select); form.append(searchLabel, find, targetLabel);
      if (previous.into) select.add(new Option(previous.into, previous.into)); select.value = previous.into ?? '';
      let searchSequence = 0;
      find.onclick = async () => {
        const own = ++searchSequence; find.disabled = true;
        try {
          const result = await api(`library?${new URLSearchParams({ kind: 'plans', q: query.value, limit: '50', archived: '1' })}`);
          if (own !== searchSequence || !dialog.open) return;
          select.replaceChildren(new Option('Choose a plan', ''), ...result.documents.filter(doc => doc.path !== state.doc.path && doc.type === 'plan').map(doc => new Option(`${doc.title} · ${doc.path}`, doc.path)));
          feedback.textContent = result.hasMore ? 'Showing 50 matching plans. Narrow the search to find another.' : result.documents.length ? '' : 'No plans matched this search.';
        } catch (error) { feedback.textContent = error.message; }
        finally { if (own === searchSequence) find.disabled = false; }
      };
      into = select;
    }
    const review = node('button', 'Review assessment', 'primary'); review.type = 'submit';
    const feedback = node('p', undefined, 'inline-note'); feedback.setAttribute('role', 'status'); form.append(review, feedback); root.append(form);
    form.onsubmit = async event => {
      event.preventDefault(); if (unavailable(action)) return;
      const request = { path: state.doc.path, action, expectedRevision: state.doc.revision, operationId: crypto.randomUUID(),
        ...(reason.value.trim() ? { reason: reason.value.trim() } : {}), ...(into ? { into: into.value } : {}) };
      pending = { ...request, newPath: request.path, state: 'preparing', report: 'Review not yet received.' }; remember();
      try {
        await busyRun(async () => { const result = await api('yardstick/preview', request); pending = { ...pending, ...result }; remember(); renderReview(); });
        dialog.querySelector('[data-yardstick-apply]')?.focus();
      }
      catch (error) { renderReview(); dialog.querySelector('.yardstick-feedback').textContent = `${error.message} Inspect the retained review or return to the form.`; notice(error.message, true); }
    };
  }
  function renderReview() {
    const root = dialogShell(labels[pending.action] ?? 'Yardstick assessment');
    if (pending.comparison) {
      const { goal, delivers, assessment } = pending.comparison;
      const reviewed = node('section', undefined, 'yardstick-reviewed-comparison');
      reviewed.append(node('h3', 'Product goal for this review'), node('p', goal.state === 'ready' ? excerpt(goal.statement)
        : goal.enabled ? `Goal unavailable: ${goal.message}` : 'Not configured', 'yardstick-reviewed-goal'));
      if (goal.source) reviewed.append(node('p', `Goal source · ${goal.source}`, 'muted'));
      reviewed.append(node('h3', 'This saved plan delivers'), node('p', excerpt(delivers, 1000) || 'Unset', 'yardstick-reviewed-delivers'),
        node('h3', 'Assessment to record'), node('p', pending.action === 'clear' ? 'Clear the assessment; execution status is unchanged.'
          : ({ serves: 'Serves the goal', folded: 'Folded into another plan', closed: 'Closed' }[assessment.disposition] ?? 'Not reviewed'), 'yardstick-reviewed-assessment'));
      root.append(reviewed);
    } else root.append(node('p', 'The prepared comparison is unavailable. Return to the form and review again before applying.', 'inline-note'));
    const report = node('pre', pending.report ?? 'Review not yet received.', 'lifecycle-report');
    const feedback = node('p', undefined, 'yardstick-feedback inline-note'); feedback.setAttribute('role', 'status');
    const apply = node('button', pending.action === 'fold' ? 'Archive and fold plan' : pending.action === 'close' ? 'Archive and close plan' : 'Apply assessment', 'primary');
    apply.type = 'button'; apply.dataset.yardstickApply = '';
    const back = node('button', 'Back to form', 'quiet'); back.type = 'button';
    const inspect = node('button', 'Inspect operation', 'quiet'); inspect.type = 'button';
    root.append(report, apply, back, inspect, feedback);
    back.onclick = () => {
      if (working) return;
      if (pending.state === 'running') { feedback.textContent = 'Inspect this interrupted operation before starting another review.'; return; }
      const prior = pending; forget(prior.path); pending = null; form(prior.action, prior); update();
    };
    inspect.onclick = async () => {
      if (working) return;
      try {
        await busyRun(async () => {
          const result = await api('yardstick/inspect', { operationId: pending.operationId });
          if (!result) { pending.state = 'missing'; feedback.textContent = 'No review was retained. Return to the form and review again.'; return; }
          pending = { ...pending, ...result }; remember(); report.textContent = result.report;
          feedback.textContent = `Operation is ${result.state}.${result.failure ? ` ${result.failure.message}` : ''}`;
          if (result.state === 'committed') {
            const old = pending.path, destination = result.newPath; forget(old); pending = null;
            library.relocated(old, destination); dialog.close(); working = false; state.busy = false;
            await open(destination); await library.load({ refresh: true }); notice('This assessment was already saved.');
          } else if (result.state === 'running') {
            feedback.textContent += ' Inspect the source and CLI transactions before starting another change.';
            if (result.canAcknowledge && result.current) acknowledgement(result, root, feedback);
          }
        });
      } catch (error) { feedback.textContent = error.message; }
    };
    apply.onclick = async () => {
      if (!pending?.comparison || pending.state !== 'reviewed' || unavailable(pending.action)) return;
      try {
        await busyRun(async () => {
          const result = await api('yardstick/commit', { operationId: pending.operationId });
          const old = pending.path; library.relocated(old, result.newPath); forget(old); pending = null; dialog.close();
          working = false; state.busy = false; await open(result.newPath); await library.load({ refresh: true });
          notice('Owner assessment saved. The Markdown source follows the CLI rules.');
        });
      } catch (error) { if (pending) { pending.state = 'uncertain'; remember(); } feedback.textContent = `${error.message} Inspect the retained operation before retrying.`; notice(feedback.textContent, true); }
    };
    update();
  }
  function acknowledgement(result, root, feedback) {
    root.querySelector('.yardstick-acknowledgement')?.remove();
    const form = node('form', undefined, 'yardstick-acknowledgement'), label = node('label', 'What did you verify?');
    const note = node('textarea'); note.required = true; note.maxLength = 4000; note.rows = 3; label.append(note);
    form.append(label, node('p', 'Acknowledge the inspected outcome without replaying the operation. It remains marked uncertain.', 'muted'));
    const submit = node('button', 'Acknowledge inspected outcome', 'quiet'); submit.type = 'submit'; form.append(submit); root.append(form);
    form.onsubmit = async event => {
      event.preventDefault(); if (working) return;
      try {
        await busyRun(async () => {
          const settled = await api('yardstick/settle', { operationId: pending.operationId, expectedRevision: result.current.revision, note: note.value });
          forget(pending.path); pending = null; dialog.close(); working = false; state.busy = false;
          await open(settled.current.path); notice('Interrupted assessment acknowledged without replay.');
        });
      } catch (error) { feedback.textContent = error.message; }
    };
  }
  async function resolveInitial(path) {
    const old = retained(path);
    if (!old) return path;
    const result = await api('yardstick/inspect', { operationId: old.operationId });
    if (result?.state === 'committed') { library.relocated(old.path, result.newPath); forget(old.path); return result.newPath; }
    return result?.current?.path ?? path;
  }
  async function resume(item) {
    const operationId = typeof item === 'string' ? item : item.operationId;
    const result = await api('yardstick/inspect', { operationId });
    if (!result) throw new Error('The assessment is unavailable; its recovery entry has been kept.');
    await open(result.current?.path ?? result.newPath ?? result.path);
    if (result.state === 'committed') { forget(result.path); notice('The owner assessment was already saved.'); return; }
    pending = result; remember(); await show(result.action, result);
  }
  function beforeLeave() { if (working || dialog?.open) throw new Error('Close the current yardstick review before switching folders or quitting.'); }
  return { opened, update, resolveInitial, resume, beforeLeave, busy: () => working };
}
