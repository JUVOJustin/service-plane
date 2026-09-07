import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';

const docsDirectory = new URL('../docs/', import.meta.url);
const referencesDirectory = new URL('../.apm/skills/service-plane/references/', import.meta.url);

await mkdir(referencesDirectory, { recursive: true });

const sourceFiles = (await readdir(docsDirectory)).filter((name) => name.endsWith('.md')).sort();
const sourceNames = new Set(sourceFiles);
const staleReferences = (await readdir(referencesDirectory)).filter((name) => name.endsWith('.md') && !sourceNames.has(name));

await Promise.all([
  ...sourceFiles.map((name) => copyFile(new URL(name, docsDirectory), new URL(name, referencesDirectory))),
  ...staleReferences.map((name) => rm(new URL(name, referencesDirectory))),
]);

console.log(`synced ${sourceFiles.length} Service Plane skill references`);
