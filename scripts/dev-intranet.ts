import { spawn } from 'node:child_process';

// Start server, worker, and web with CQA_ALLOW_INTRANET=1
process.env.CQA_ALLOW_INTRANET = '1';
console.log('🚀 Starting Course QA with Intranet / LAN scanning enabled (CQA_ALLOW_INTRANET=1)...');

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const child = spawn(npmCmd, ['run', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CQA_ALLOW_INTRANET: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
