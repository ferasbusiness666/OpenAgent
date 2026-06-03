#!/usr/bin/env node
/**
 * Global launcher for Open Agent: `openagent` runs the TypeScript entry point
 * through tsx from any directory, forwarding all CLI args and the exit code.
 *
 * Rather than spawning the platform-specific tsx shim (./node_modules/.bin/tsx,
 * which is tsx.cmd on Windows and needs a shell), we resolve tsx's own CLI
 * script from its package and run it with the current Node binary. This works
 * identically on Windows, macOS, and Linux, with no shell quoting pitfalls, and
 * keeps working after `npm install -g .` (tsx is a runtime dependency).
 */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve tsx's CLI entry from its package.json "bin" field.
const tsxPkgPath = require.resolve('tsx/package.json');
const tsxPkg = require('tsx/package.json');
const binRel = typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx;
const tsxCli = path.join(path.dirname(tsxPkgPath), binRel);

const entry = path.join(__dirname, '..', 'src', 'index.ts');

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`Failed to launch Open Agent: ${err.message}`);
  process.exit(1);
});
