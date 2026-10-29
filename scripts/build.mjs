import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(projectRoot, 'dist');

await rm(distRoot, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    join(projectRoot, 'tsconfig.json'),
  ],
  { cwd: projectRoot, stdio: 'inherit' },
);

await mkdir(distRoot, { recursive: true });
await copyFile(join(projectRoot, 'public', 'index.html'), join(distRoot, 'index.html'));
await copyFile(join(projectRoot, 'public', 'styles.css'), join(distRoot, 'styles.css'));
await copyFile(join(projectRoot, 'public', 'favicon.svg'), join(distRoot, 'favicon.svg'));
