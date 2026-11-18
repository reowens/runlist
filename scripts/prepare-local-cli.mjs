#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { prepareLocalCLI, validateLocalCLI, selectLocalCLI, installLocalCLI } from '../src/local-cli.mjs';
export { prepareLocalCLI, validateLocalCLI, selectLocalCLI, installLocalCLI };

// Compared through realpath: a script run from a symlinked folder, such as a
// macOS temporary folder under /var, has a module URL under the link's target.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [operation, request] = process.argv.slice(2);
  const operations = { prepare: prepareLocalCLI, validate: validateLocalCLI, select: selectLocalCLI, install: installLocalCLI };
  if (!Object.hasOwn(operations, operation) || !request || process.argv.length !== 4) throw new Error('expected prepare|validate|select|install request.json');
  const result = operations[operation](JSON.parse(readFileSync(request)));
  console.log(JSON.stringify(result, null, 2));
}
