import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { buildIndex } from './index.mjs';
import { asString, toRepoPath, die, warn } from './util.mjs';
import { bold, green, yellow, dim } from './color.mjs';

let notionClient;
let notionToMd;

async function loadDeps() {
  if (notionClient) return;
  try {
    const { Client } = await import('@notionhq/client');
    const { NotionToMarkdown } = await import('notion-to-md');
    notionClient = Client;
    notionToMd = NotionToMarkdown;
  } catch {
    die('Notion dependencies not installed. Run: npm install @notionhq/client notion-to-md');
  }
}

function getClient(config) {
  const token = config.raw?.notion?.token ?? process.env.NOTION_TOKEN;
  if (!token) die('No Notion token. Set NOTION_TOKEN env var or add notion.token to your config.');
  return new notionClient({ auth: token });
}

function getDbId(argv, config) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }
  const id = positional[0] ?? config.raw?.notion?.database;
  if (!id) die('No database ID. Pass as argument or set notion.database in config.');
  return id;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

// ── Property mapping: Notion → frontmatter ─────────────────────────────

function mapPropertiesToFrontmatter(properties, config) {
  const fm = {};
  const map = config.raw?.notion?.propertyMap ?? {};

  for (const [name, prop] of Object.entries(properties)) {
    const key = map[name] ?? name.toLowerCase().replace(/\s+/g, '_');
    switch (prop.type) {
      case 'title':
        fm.title = prop.title.map(t => t.plain_text).join('');
        break;
      case 'rich_text':
        fm[key] = prop.rich_text.map(t => t.plain_text).join('');
        break;
      case 'select':
        fm[key] = prop.select?.name ?? null;
        break;
      case 'multi_select':
        fm[key] = prop.multi_select.map(o => o.name);
        break;
      case 'date':
        fm[key] = prop.date?.start ?? null;
        break;
      case 'checkbox':
        fm[key] = prop.checkbox;
        break;
      case 'number':
        fm[key] = prop.number;
        break;
      case 'url':
        fm[key] = prop.url;
        break;
      case 'email':
        fm[key] = prop.email;
        break;
      case 'status':
        fm[key] = prop.status?.name?.toLowerCase() ?? null;
        break;
      case 'people':
        fm[key] = prop.people.map(p => p.name ?? p.id);
        break;
      case 'relation':
        // Store as page IDs for now; could resolve titles
        fm[key] = prop.relation.map(r => r.id);
        break;
      case 'formula':
      case 'rollup':
      case 'created_time':
      case 'last_edited_time':
      case 'created_by':
      case 'last_edited_by':
        break; // skip computed/system
    }
  }
  return fm;
}

// ── Property mapping: frontmatter → Notion ─────────────────────────────

function mapFrontmatterToProperties(doc, dbProperties, config) {
  const reverseMap = {};
  const map = config.raw?.notion?.propertyMap ?? {};
  for (const [notionName, fmKey] of Object.entries(map)) {
    reverseMap[fmKey] = notionName;
  }

  const properties = {};

  for (const [notionName, propDef] of Object.entries(dbProperties)) {
    const fmKey = map[notionName] ?? notionName.toLowerCase().replace(/\s+/g, '_');

    // Title property
    if (propDef.type === 'title') {
      properties[notionName] = {
        title: [{ type: 'text', text: { content: doc.title ?? '' } }],
      };
      continue;
    }

    // Check if we have a frontmatter value for this property
    const value = doc[fmKey] ?? null;
    if (value === null || value === undefined) continue;

    switch (propDef.type) {
      case 'rich_text':
        properties[notionName] = {
          rich_text: [{ type: 'text', text: { content: String(value) } }],
        };
        break;
      case 'select':
        if (typeof value === 'string' && value) {
          properties[notionName] = { select: { name: value } };
        }
        break;
      case 'multi_select':
        if (Array.isArray(value)) {
          properties[notionName] = { multi_select: value.map(v => ({ name: String(v) })) };
        }
        break;
      case 'date':
        if (typeof value === 'string' && value) {
          properties[notionName] = { date: { start: value } };
        }
        break;
      case 'checkbox':
        properties[notionName] = { checkbox: Boolean(value) };
        break;
      case 'number':
        if (typeof value === 'number') {
          properties[notionName] = { number: value };
        }
        break;
      case 'url':
        if (typeof value === 'string' && value) {
          properties[notionName] = { url: value };
        }
        break;
      case 'email':
        if (typeof value === 'string' && value) {
          properties[notionName] = { email: value };
        }
        break;
      case 'status':
        if (typeof value === 'string' && value) {
          properties[notionName] = { status: { name: value } };
        }
        break;
      // Skip: formula, rollup, relation (complex), created_time, etc.
    }
  }

  return properties;
}

// ── Serialization helpers ──────────────────────────────────────────────

function serializeFrontmatter(fm) {
  const lines = [];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function slugify(text) {
  return text.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

function loadBody(doc, config) {
  const raw = readFileSync(path.join(config.repoRoot, doc.path), 'utf8');
  const { body } = extractFrontmatter(raw);
  return body ?? '';
}

// ── Paginated query helper ─────────────────────────────────────────────

async function queryAllPages(client, dbId) {
  const pages = [];
  let cursor;
  do {
    const response = await client.databases.query({
      database_id: dbId,
      start_cursor: cursor,
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function findPageByTitle(client, dbId, title) {
  const response = await client.databases.query({
    database_id: dbId,
    filter: { property: 'title', title: { equals: title } },
    page_size: 1,
  });
  return response.results[0] ?? null;
}

// ── Import: Notion → local .md ─────────────────────────────────────────

export async function runNotionImport(argv, config, opts = {}) {
  await loadDeps();
  const client = getClient(config);
  const n2m = new notionToMd({ notionClient: client });
  const dbId = getDbId(argv, config);
  const force = hasFlag(argv, '--force');
  const dryRun = opts.dryRun || hasFlag(argv, '--dry-run') || hasFlag(argv, '-n');

  process.stdout.write(`Importing from Notion database ${dim(dbId)}...\n`);

  const pages = await queryAllPages(client, dbId);
  process.stdout.write(`Found ${pages.length} pages.\n\n`);

  let created = 0, skipped = 0, updated = 0;
  const prefix = dryRun ? dim('[dry-run] ') : '';

  for (const page of pages) {
    const fm = mapPropertiesToFrontmatter(page.properties, config);
    const title = fm.title ?? 'Untitled';
    delete fm.title; // title goes in heading, not frontmatter

    // Add notion_id for sync tracking
    fm.notion_id = page.id;
    if (!fm.updated) fm.updated = page.last_edited_time?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

    const slug = slugify(title);
    const filePath = path.join(config.docsRoot, slug + '.md');
    const repoPath = toRepoPath(filePath, config.repoRoot);

    if (existsSync(filePath) && !force) {
      process.stdout.write(`${prefix}${dim('skip')}  ${repoPath} (exists, use --force to overwrite)\n`);
      skipped++;
      continue;
    }

    // Convert blocks to markdown
    let body = '';
    try {
      const mdBlocks = await n2m.pageToMarkdown(page.id);
      body = n2m.toMarkdownString(mdBlocks).parent ?? '';
    } catch (err) {
      warn(`Failed to convert blocks for "${title}": ${err.message}`);
    }

    const content = `---\n${serializeFrontmatter(fm)}\n---\n\n# ${title}\n\n${body}`;

    if (!dryRun) {
      writeFileSync(filePath, content, 'utf8');
    }

    const action = existsSync(filePath) ? 'update' : 'create';
    process.stdout.write(`${prefix}${green(action)}  ${repoPath}\n`);
    if (action === 'update') updated++;
    else created++;
  }

  process.stdout.write(`\n${prefix}Done: ${created} created, ${updated} updated, ${skipped} skipped.\n`);
}

// ── Export: local docs → Notion ─────────────────────────────────────────

export async function runNotionExport(argv, config, opts = {}) {
  await loadDeps();
  const client = getClient(config);
  const dbId = getDbId(argv, config);
  const dryRun = opts.dryRun || hasFlag(argv, '--dry-run') || hasFlag(argv, '-n');

  process.stdout.write(`Exporting to Notion database ${dim(dbId)}...\n`);

  // Get database schema for property mapping
  const dbInfo = await client.databases.retrieve({ database_id: dbId });
  const dbProperties = dbInfo.properties;

  const index = buildIndex(config);
  process.stdout.write(`Found ${index.docs.length} local docs.\n\n`);

  let created = 0, updated = 0;
  const prefix = dryRun ? dim('[dry-run] ') : '';

  for (const doc of index.docs) {
    const properties = mapFrontmatterToProperties(doc, dbProperties, config);
    const body = loadBody(doc, config);

    const existing = await findPageByTitle(client, dbId, doc.title);

    if (dryRun) {
      process.stdout.write(`${prefix}${existing ? 'update' : 'create'}  ${doc.path}\n`);
      if (existing) updated++;
      else created++;
      continue;
    }

    try {
      if (existing) {
        await client.pages.update({
          page_id: existing.id,
          properties,
          markdown: body,
        });
        process.stdout.write(`${green('update')}  ${doc.path}\n`);
        updated++;
      } else {
        await client.pages.create({
          parent: { database_id: dbId },
          properties,
          markdown: body,
        });
        process.stdout.write(`${green('create')}  ${doc.path}\n`);
        created++;
      }
    } catch (err) {
      warn(`Failed to export "${doc.title}": ${err.message}`);
    }
  }

  process.stdout.write(`\n${prefix}Done: ${created} created, ${updated} updated.\n`);
}

// ── Sync: bidirectional merge ───────────────────────────────────────────

export async function runNotionSync(argv, config, opts = {}) {
  await loadDeps();
  const client = getClient(config);
  const n2m = new notionToMd({ notionClient: client });
  const dbId = getDbId(argv, config);
  const dryRun = opts.dryRun || hasFlag(argv, '--dry-run') || hasFlag(argv, '-n');

  process.stdout.write(`Syncing with Notion database ${dim(dbId)}...\n\n`);

  // Get database schema
  const dbInfo = await client.databases.retrieve({ database_id: dbId });
  const dbProperties = dbInfo.properties;

  // Get remote pages
  const remotePages = await queryAllPages(client, dbId);
  const remoteBySlug = new Map();
  for (const page of remotePages) {
    const title = page.properties.title?.title?.map(t => t.plain_text).join('') ??
                  Object.values(page.properties).find(p => p.type === 'title')?.title?.map(t => t.plain_text).join('') ?? '';
    const slug = slugify(title);
    remoteBySlug.set(slug, { page, title });
  }

  // Get local docs
  const index = buildIndex(config);
  const localBySlug = new Map();
  for (const doc of index.docs) {
    const slug = path.basename(doc.path, '.md');
    localBySlug.set(slug, doc);
  }

  const allSlugs = new Set([...remoteBySlug.keys(), ...localBySlug.keys()]);
  let pulled = 0, pushed = 0, conflicts = 0, skipped = 0;
  const prefix = dryRun ? dim('[dry-run] ') : '';

  for (const slug of allSlugs) {
    const remote = remoteBySlug.get(slug);
    const local = localBySlug.get(slug);

    if (remote && !local) {
      // New in Notion → pull
      const fm = mapPropertiesToFrontmatter(remote.page.properties, config);
      const title = fm.title ?? remote.title;
      delete fm.title;
      fm.notion_id = remote.page.id;
      if (!fm.updated) fm.updated = remote.page.last_edited_time?.slice(0, 10);

      let body = '';
      try {
        const mdBlocks = await n2m.pageToMarkdown(remote.page.id);
        body = n2m.toMarkdownString(mdBlocks).parent ?? '';
      } catch (err) { warn(`Could not convert Notion page body for "${title}": ${err.message}`); }

      const content = `---\n${serializeFrontmatter(fm)}\n---\n\n# ${title}\n\n${body}`;
      const filePath = path.join(config.docsRoot, slug + '.md');

      if (!dryRun) writeFileSync(filePath, content, 'utf8');
      process.stdout.write(`${prefix}${green('pull')}   ${slug} (new in Notion)\n`);
      pulled++;
      continue;
    }

    if (local && !remote) {
      // New locally → push
      const properties = mapFrontmatterToProperties(local, dbProperties, config);
      const body = loadBody(local, config);

      if (!dryRun) {
        try {
          await client.pages.create({
            parent: { database_id: dbId },
            properties,
            markdown: body,
          });
        } catch (err) {
          warn(`Failed to push "${local.title}": ${err.message}`);
          continue;
        }
      }
      process.stdout.write(`${prefix}${green('push')}   ${slug} (new locally)\n`);
      pushed++;
      continue;
    }

    // Both exist — compare timestamps
    const remoteTime = remote.page.last_edited_time?.slice(0, 10) ?? '';
    const localTime = local.updated ?? '';

    if (remoteTime === localTime) {
      skipped++;
      continue;
    }

    if (remoteTime > localTime) {
      // Notion is newer → pull
      const fm = mapPropertiesToFrontmatter(remote.page.properties, config);
      const title = fm.title ?? remote.title;
      delete fm.title;
      fm.notion_id = remote.page.id;
      fm.updated = remoteTime;

      let body = '';
      try {
        const mdBlocks = await n2m.pageToMarkdown(remote.page.id);
        body = n2m.toMarkdownString(mdBlocks).parent ?? '';
      } catch (err) { warn(`Could not convert Notion page body for "${title}": ${err.message}`); }

      const content = `---\n${serializeFrontmatter(fm)}\n---\n\n# ${title}\n\n${body}`;
      const filePath = path.join(config.repoRoot, local.path);

      if (!dryRun) writeFileSync(filePath, content, 'utf8');
      process.stdout.write(`${prefix}${green('pull')}   ${slug} (Notion newer: ${remoteTime} > ${localTime})\n`);
      pulled++;
    } else {
      // Local is newer → push
      const properties = mapFrontmatterToProperties(local, dbProperties, config);
      const body = loadBody(local, config);

      if (!dryRun) {
        try {
          await client.pages.update({
            page_id: remote.page.id,
            properties,
            markdown: body,
          });
        } catch (err) {
          warn(`Failed to push "${local.title}": ${err.message}`);
          continue;
        }
      }
      process.stdout.write(`${prefix}${green('push')}   ${slug} (local newer: ${localTime} > ${remoteTime})\n`);
      pushed++;
    }
  }

  process.stdout.write(`\n${prefix}Done: ${pulled} pulled, ${pushed} pushed, ${skipped} unchanged.\n`);
}

// ── CLI dispatcher ──────────────────────────────────────────────────────

export async function runNotion(argv, config, opts = {}) {
  // Filter out global flags before finding subcommand
  const filtered = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i] === '--verbose') continue;
    filtered.push(argv[i]);
  }
  const subcommand = filtered[0];
  const restArgs = filtered.slice(1);

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`dotmd notion — Notion database integration

Subcommands:
  import <database-id>   Pull Notion database → local .md files
  export <database-id>   Push local docs → Notion database rows
  sync <database-id>     Bidirectional sync (merge by slug)

Options:
  --force                Overwrite existing files on import
  --dry-run, -n          Preview without changes

Requires NOTION_TOKEN env var or notion.token in config.
Database ID can be set in config as notion.database.
`);
    return;
  }

  if (subcommand === 'import') return runNotionImport(restArgs, config, opts);
  if (subcommand === 'export') return runNotionExport(restArgs, config, opts);
  if (subcommand === 'sync') return runNotionSync(restArgs, config, opts);

  die(`Unknown notion subcommand: ${subcommand}\nRun \`dotmd notion --help\` for usage.`);
}
