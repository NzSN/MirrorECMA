import {rmSync} from 'node:fs';
// Removed source modules must not survive into a packed next-major package.
rmSync(new URL('../dist', import.meta.url), {recursive: true, force: true});
