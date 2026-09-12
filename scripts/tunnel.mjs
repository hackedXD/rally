/**
 * HTTPS tunnel helper.
 *
 * iOS will not grant motion permission over plain HTTP, so a phone cannot act as
 * a controller against `http://localhost` no matter what else is right. That is a
 * Stage 0 blocker rather than a deployment task, which is why it has its own
 * command.
 *
 *   npm run tunnel
 *   npm run tunnel -- --port 8787
 */

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? args[portIndex + 1] : '8787';

const CANDIDATES = [
  { cmd: 'cloudflared', args: ['tunnel', '--url', `http://localhost:${port}`] },
  { cmd: 'ngrok', args: ['http', port] },
];

function have(cmd) {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
    });
    probe.on('exit', (code) => resolve(code === 0));
    probe.on('error', () => resolve(false));
  });
}

const found = [];
for (const c of CANDIDATES) if (await have(c.cmd)) found.push(c);

if (!found.length) {
  console.error(
    'No tunnel tool found. Install one of:\n' +
      '  brew install cloudflared     (recommended, no account needed)\n' +
      '  brew install ngrok\n\n' +
      'Then run this again. The server should already be serving the built bundles:\n' +
      '  npm run serve\n\n' +
      'Once the tunnel prints an https URL, restart the server with it so the QR\n' +
      'code points at the tunnel rather than at localhost:\n' +
      '  RALLY_PUBLIC_ORIGIN=https://your-tunnel.example npm run serve',
  );
  process.exit(1);
}

const tool = found[0];
console.log(`[tunnel] starting ${tool.cmd} for port ${port}`);
console.log(
  '[tunnel] when it prints an https URL, restart the server with\n' +
    '         RALLY_PUBLIC_ORIGIN=<that url> so the QR code points at it.\n',
);

const child = spawn(tool.cmd, tool.args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
