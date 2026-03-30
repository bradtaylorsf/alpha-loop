/** Minimal config loader — stub from #73, will be expanded later. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

export interface LoopConfig {
  repo: string;
  project?: number;
  model: string;
  review_model?: string;
  max_turns: number;
  label: string;
  base_branch: string;
  test_command?: string;
  poll_interval: number;
  port?: number;
}

const DEFAULT_CONFIG: LoopConfig = {
  repo: '',
  model: 'opus',
  max_turns: 30,
  label: 'ready',
  base_branch: 'main',
  poll_interval: 60,
  port: 3000,
};

export function loadConfig(projectDir: string = process.cwd()): LoopConfig {
  const configPath = path.join(projectDir, '.alpha-loop.yaml');
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) ?? {};
  return { ...DEFAULT_CONFIG, ...parsed };
}
