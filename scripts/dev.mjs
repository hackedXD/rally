/**
 * One command to bring the whole thing up: server, display, controller.
 *
 * Output from all three is prefixed and interleaved. Ctrl-C stops everything, so
 * no port is left held on the next run.
 */

import { spawn } from 'node:child_process';

const ESC = '\u001b';
const COLORS = [`${ESC}[36m`, `${ESC}[35m`, `${ESC}[33m`];
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;

const tasks = [
  {
    name: 'server',
    cmd: 'npx',
    args: ['tsx', 'watch', '--tsconfig', 'tsconfig.node.json', 'apps/server/src/index.ts'],
  },
  { name: 'display', cmd: 'npx', args: ['vite', '--config', 'apps/display/vite.config.ts'] },
  { name: 'phone', cmd: 'npx', args: ['vite', '--config', 'apps/controller/vite.config.ts'] },
];

const children = [];
let shuttingDown = false;

for (const [i, task] of tasks.entries()) {
  const color = COLORS[i % COLORS.length];
  const child = spawn(task.cmd, task.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);

  const prefix = `${color}${task.name.padEnd(8)}${RESET}`;
  const pipe = (stream, isError) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(`${prefix} ${isError ? DIM + line + RESET : line}\n`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix} exited with code ${code}\n`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

setTimeout(() => {
  process.stdout.write(
    `\n  ${COLORS[1]}Display${RESET}    http://localhost:5173\n` +
      `  ${COLORS[2]}Controller${RESET} http://localhost:5174/c  ${DIM}(the QR code points here)${RESET}\n` +
      `  ${COLORS[0]}Server${RESET}     http://localhost:8787/healthz\n\n` +
      `  ${DIM}A phone needs HTTPS for motion access: run 'npm run tunnel' in another shell.${RESET}\n\n`,
  );
}, 2500);
