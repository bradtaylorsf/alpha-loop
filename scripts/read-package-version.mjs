import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('package.json is missing a valid version');
}

process.stdout.write(packageJson.version);
