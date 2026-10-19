// Condense cycles before propagating outer categories through local hub indexes.
export function resolveHubCategories(hubs, rows) {
  const next = new Map(hubs.map(hub => [hub, new Set()]));
  const prev = new Map(hubs.map(hub => [hub, new Set()]));
  for (const child of hubs) for (const row of rows.get(child) ?? []) {
    if (!next.has(row.hub)) continue;
    next.get(row.hub).add(child);
    prev.get(child).add(row.hub);
  }
  const seen = new Set(), order = [];
  for (const hub of hubs) {
    if (seen.has(hub)) continue;
    seen.add(hub);
    const stack = [[hub, next.get(hub).values()]];
    while (stack.length) {
      const [node, children] = stack.at(-1), child = children.next();
      if (child.done) { order.push(node); stack.pop(); }
      else if (!seen.has(child.value)) {
        seen.add(child.value);
        stack.push([child.value, next.get(child.value).values()]);
      }
    }
  }
  const component = new Map(), groups = [];
  for (const hub of order.reverse()) {
    if (component.has(hub)) continue;
    const id = groups.length, stack = [hub];
    groups.push({ categories: new Set(), fallback: new Set(), children: new Map(), incoming: 0 });
    component.set(hub, id);
    while (stack.length) for (const parent of prev.get(stack.pop())) {
      if (!component.has(parent)) { component.set(parent, id); stack.push(parent); }
    }
  }
  for (const child of hubs) for (const row of rows.get(child) ?? []) {
    if (!component.has(row.hub)) continue;
    const from = component.get(row.hub), to = component.get(child);
    if (from === to) { if (row.category) groups[to].fallback.add(row.category); continue; }
    if (!groups[from].children.has(to)) {
      groups[from].children.set(to, new Set());
      groups[to].incoming++;
    }
    if (row.category) groups[from].children.get(to).add(row.category);
  }
  const queue = groups.flatMap((group, id) => group.incoming === 0 ? [id] : []);
  for (let i = 0; i < queue.length; i++) {
    const group = groups[queue[i]];
    if (!group.categories.size) for (const label of group.fallback) group.categories.add(label);
    for (const [child, labels] of group.children) {
      for (const label of group.categories.size ? group.categories : labels) groups[child].categories.add(label);
      if (--groups[child].incoming === 0) queue.push(child);
    }
  }
  return new Map(hubs.map(hub => [hub, groups[component.get(hub)].categories]));
}
