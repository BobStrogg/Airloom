// Fix execute permissions on native binary helpers that pnpm strips from tarballs.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmDir = join(root, 'node_modules', '.pnpm');

const fixes = [
  // node-pty: spawn-helper must be executable or posix_spawnp fails
  { pkg: 'node-pty', glob: 'prebuilds/*/spawn-helper' },
];

if (!existsSync(pnpmDir)) process.exit(0);

for (const { pkg, glob } of fixes) {
  const parts = glob.split('/');
  try {
    const entries = readdirSync(pnpmDir).filter((e) => e.startsWith(`${pkg}@`));
    for (const entry of entries) {
      // Walk the glob segments (supports one wildcard '*' segment)
      const base = join(pnpmDir, entry, 'node_modules', pkg);
      let dirs = [base];
      for (const part of parts) {
        if (part === '*') {
          dirs = dirs.flatMap((d) => {
            try { return readdirSync(d).map((c) => join(d, c)); } catch { return []; }
          });
        } else {
          dirs = dirs.map((d) => join(d, part));
        }
      }
      for (const file of dirs) {
        if (existsSync(file)) {
          chmodSync(file, 0o755);
          console.log(`[postinstall] chmod +x ${file}`);
        }
      }
    }
  } catch (err) {
    // Non-fatal — package may not be installed on this platform
    console.warn(`[postinstall] Could not fix ${pkg}: ${err.message}`);
  }
}
