import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = {
  version?: unknown;
};

export function getPackageVersion(): string {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;

  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('package.json is missing a valid version');
  }

  return packageJson.version;
}
