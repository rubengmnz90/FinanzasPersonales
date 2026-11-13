import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverDir = resolve(here, '../../server');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/test/e2e-setup.ts'], {
    cwd: serverDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env },
  });
}
