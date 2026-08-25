import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// TypeScript does not remove outputs for deleted source files. Always rebuild the publishable
// package from an empty generated directory so removed public modules cannot survive a migration.
rmSync(fileURLToPath(new URL('../dist/', import.meta.url)), { force: true, recursive: true });
