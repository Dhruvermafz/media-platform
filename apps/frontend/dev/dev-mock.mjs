#!/usr/bin/env node
// Starts the mock API and Vite together and stops both on exit (Ctrl+C), on any OS.
// Vite is launched directly (not via `npx`) so there is no wrapper process chain
// that could survive a SIGTERM and leave a dev server running.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

const run = (args) => spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
const children = [run(['dev/mock-server.mjs']), run([viteBin])];
const stop = () => { for (const c of children) c.kill('SIGTERM'); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
for (const c of children) c.on('exit', (code) => { stop(); process.exit(code ?? 0); });
