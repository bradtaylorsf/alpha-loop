import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectSecuritySurfaces,
  parseModelApplicationSurfaces,
  surfacesForSelector,
} from '../../src/lib/security-surfaces.js';

describe('security surfaces', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-surfaces-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('fixture with .mcp.json and no cloud SDK offers mcp and omits cloud', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: { express: '4.0.0' },
    }));
    mkdirSync(join(tempDir, '.alpha-loop'), { recursive: true });
    writeFileSync(
      join(tempDir, '.alpha-loop', 'context.md'),
      '## Architecture\n- Express server mounts public HTTP routes\n- Auth stores credentials at rest\n',
    );
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://example.com/mcp' },
      },
    }));
    mkdirSync(join(tempDir, 'auth'), { recursive: true });
    writeFileSync(join(tempDir, 'auth', 'store.ts'), 'export const secrets = {};\n');

    const result = detectSecuritySurfaces({ projectDir: tempDir, agent: 'claude' });

    expect(result.detected).toEqual(
      expect.arrayContaining(['public-http', 'credentials-at-rest', 'mcp']),
    );
    expect(result.detected).not.toContain('cloud-control-plane');
    expect(result.agentSurface).toBe(true);
    expect(result.mcpServers).toEqual(['docs']);

    const offered = surfacesForSelector(result, false);
    expect(offered).toContain('mcp');
    expect(offered).not.toContain('cloud-control-plane');
  });

  test('agent surface stays absent without MCP even when showUndetected is true', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'fixture' }));
    mkdirSync(join(tempDir, 'terraform'), { recursive: true });
    writeFileSync(join(tempDir, 'terraform', 'main.tf'), 'resource "null_resource" "x" {}\n');

    const result = detectSecuritySurfaces({ projectDir: tempDir, agent: 'claude' });
    expect(result.detected).toContain('cloud-control-plane');
    expect(result.agentSurface).toBe(false);

    expect(surfacesForSelector(result, true)).toEqual([
      'public-http',
      'credentials-at-rest',
      'command-execution',
      'cloud-control-plane',
    ]);
  });

  test('optional model call accepts only the closed application-surface set', () => {
    expect(parseModelApplicationSurfaces(['public-http', 'cloud-control-plane'])).toEqual([
      'public-http',
      'cloud-control-plane',
    ]);
    expect(parseModelApplicationSurfaces({ surfaces: ['credentials-at-rest'] })).toEqual([
      'credentials-at-rest',
    ]);
    expect(parseModelApplicationSurfaces(['public-http', 'mcp'])).toBeNull();
    expect(parseModelApplicationSurfaces({ surfaces: ['vault'] })).toBeNull();
    expect(parseModelApplicationSurfaces({ techniqueIds: ['T1190'] })).toBeNull();
  });

  test('invalid model JSON is discarded and file signals stand', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: { next: '15.0.0' },
    }));
    mkdirSync(join(tempDir, 'app', 'api', 'health'), { recursive: true });
    writeFileSync(join(tempDir, 'app', 'api', 'health', 'route.ts'), 'export const GET = () => Response.json({ok:true});\n');

    const result = detectSecuritySurfaces({
      projectDir: tempDir,
      agent: 'claude',
      modelSurfaces: { techniqueIds: ['T1190'], surfaces: ['vault', 'mcp'] },
    });

    expect(result.detected).toContain('public-http');
    expect(result.detected).not.toContain('cloud-control-plane');
    expect(result.agentSurface).toBe(false);
  });

  test('codex agent reads mcp_servers from .codex/config.toml', () => {
    mkdirSync(join(tempDir, '.codex'), { recursive: true });
    writeFileSync(
      join(tempDir, '.codex', 'config.toml'),
      '[mcp_servers.tools]\ncommand = "npx"\nargs = ["-y", "server"]\n',
    );

    const result = detectSecuritySurfaces({ projectDir: tempDir, agent: 'codex' });
    expect(result.agentSurface).toBe(true);
    expect(result.mcpServers).toEqual(['tools']);
  });
});
