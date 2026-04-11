import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, findConfigFile } from '../src/config/loader.js';

describe('findConfigFile', () => {
  it('returns null when no config exists', () => {
    const noConfigDir = join(tmpdir(), `withctx-test-${randomUUID()}`);
    mkdirSync(noConfigDir, { recursive: true });
    const result = findConfigFile(noConfigDir);
    expect(result).toBeNull();
    rmSync(noConfigDir, { recursive: true, force: true });
  });

  it('finds ctx.yaml in the given directory', () => {
    const dir = join(tmpdir(), `withctx-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ctx.yaml'), 'project: test\n');
    const result = findConfigFile(dir);
    expect(result).toBe(join(dir, 'ctx.yaml'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks up directories to find ctx.yaml', () => {
    const root = join(tmpdir(), `withctx-test-${randomUUID()}`);
    const child = join(root, 'sub', 'deep');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, 'ctx.yaml'), 'project: test\n');
    const result = findConfigFile(child);
    expect(result).toBe(join(root, 'ctx.yaml'));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when no ctx.yaml found', () => {
    expect(() => loadConfig(join(tempDir, 'nonexistent.yaml'))).toThrow();
  });

  it('loads a valid ctx.yaml', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    writeFileSync(configPath, 'project: my-project\n');
    const config = loadConfig(configPath);
    expect(config.project).toBe('my-project');
  });

  it('resolves ${VAR} environment variables in string values', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    const originalEnv = process.env.WITHCTX_TEST_TOKEN;
    process.env.WITHCTX_TEST_TOKEN = 'secret-123';

    writeFileSync(
      configPath,
      [
        'project: test-env',
        'sources:',
        '  jira:',
        '    - name: my-jira',
        '      base_url: https://jira.example.com',
        '      token: ${WITHCTX_TEST_TOKEN}',
        '      project: PROJ',
      ].join('\n')
    );

    const config = loadConfig(configPath);
    expect(config.sources?.jira?.[0].token).toBe('secret-123');

    // Cleanup
    if (originalEnv === undefined) {
      delete process.env.WITHCTX_TEST_TOKEN;
    } else {
      process.env.WITHCTX_TEST_TOKEN = originalEnv;
    }
  });

  it('resolves missing env vars to empty string', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    delete process.env.WITHCTX_DEFINITELY_MISSING_VAR;

    writeFileSync(
      configPath,
      [
        'project: test-missing',
        'sources:',
        '  jira:',
        '    - name: my-jira',
        '      base_url: https://jira.example.com',
        '      token: ${WITHCTX_DEFINITELY_MISSING_VAR}',
      ].join('\n')
    );

    const config = loadConfig(configPath);
    expect(config.sources?.jira?.[0].token).toBe('');
  });

  it('resolves env vars in nested credential fields', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    const originalEnv = process.env.WITHCTX_TEST_NESTED;
    process.env.WITHCTX_TEST_NESTED = 'resolved-value';

    writeFileSync(
      configPath,
      [
        'project: test-nested',
        'sources:',
        '  jira:',
        '    - name: my-jira',
        '      base_url: https://jira.example.com',
        '      token: ${WITHCTX_TEST_NESTED}',
        '      project: PROJ',
      ].join('\n')
    );

    const config = loadConfig(configPath);
    expect(config.sources?.jira?.[0].token).toBe('resolved-value');

    if (originalEnv === undefined) {
      delete process.env.WITHCTX_TEST_NESTED;
    } else {
      process.env.WITHCTX_TEST_NESTED = originalEnv;
    }
  });

  it('rejects ${VAR} placeholders in non-credential fields (security)', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    // A malicious / careless config tries to smuggle an env var into a
    // filesystem path. The loader must refuse, not silently substitute.
    writeFileSync(
      configPath,
      [
        'project: test-leak',
        'sources:',
        '  local:',
        '    - name: leaky',
        '      path: /tmp/${ANTHROPIC_API_KEY}',
      ].join('\n')
    );

    expect(() => loadConfig(configPath)).toThrow(
      /environment-variable interpolation is only allowed/
    );
  });

  it('rejects ${VAR} placeholders in project name', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    writeFileSync(configPath, 'project: ${ANTHROPIC_API_KEY}\n');
    expect(() => loadConfig(configPath)).toThrow(
      /environment-variable interpolation is only allowed/
    );
  });

  it('allows ${VAR} in ai.headers child values', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    const originalEnv = process.env.WITHCTX_TEST_HEADER;
    process.env.WITHCTX_TEST_HEADER = 'header-secret-value';

    writeFileSync(
      configPath,
      [
        'project: test-headers',
        'ai:',
        '  provider: anthropic',
        '  headers:',
        '    api-key: ${WITHCTX_TEST_HEADER}',
        '    x-ms-region: eu-west',
      ].join('\n')
    );

    const config = loadConfig(configPath);
    expect(config.ai?.headers?.['api-key']).toBe('header-secret-value');
    expect(config.ai?.headers?.['x-ms-region']).toBe('eu-west');

    if (originalEnv === undefined) {
      delete process.env.WITHCTX_TEST_HEADER;
    } else {
      process.env.WITHCTX_TEST_HEADER = originalEnv;
    }
  });
});

describe('SafeHttpUrl SSRF guard', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-ssrf-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // A matrix of (connector, base_url, expectRejection) cases. The guard
  // has to fire uniformly across every source that takes a URL from
  // ctx.yaml, not just the ones we remembered to test.
  const rejectCases: Array<{ label: string; yaml: string[] }> = [
    {
      label: 'jira base_url on AWS metadata endpoint',
      yaml: [
        'project: ssrf-jira',
        'sources:',
        '  jira:',
        '    - name: evil',
        '      base_url: http://169.254.169.254/',
        '      token: x',
      ],
    },
    {
      label: 'confluence base_url on localhost',
      yaml: [
        'project: ssrf-confluence',
        'sources:',
        '  confluence:',
        '    - name: evil',
        '      base_url: http://127.0.0.1:8080/',
        '      token: x',
      ],
    },
    {
      label: 'notion base_url with file:// scheme',
      yaml: [
        'project: ssrf-notion',
        'sources:',
        '  notion:',
        '    - name: evil',
        '      base_url: file:///etc/passwd',
      ],
    },
    {
      label: 'slack base_url on RFC1918 10.x',
      yaml: [
        'project: ssrf-slack',
        'sources:',
        '  slack:',
        '    - name: evil',
        '      channels: [general]',
        '      base_url: http://10.0.0.1/',
      ],
    },
    {
      label: 'github base_url on metadata endpoint',
      yaml: [
        'project: ssrf-github',
        'sources:',
        '  github:',
        '    - name: evil',
        '      token: x',
        '      owner: acme',
        '      base_url: http://169.254.169.254/',
      ],
    },
    {
      label: 'openapi url on internal elasticsearch',
      yaml: [
        'project: ssrf-openapi',
        'sources:',
        '  openapi:',
        '    - name: evil',
        '      url: http://127.0.0.1:9200/openapi.json',
      ],
    },
    {
      label: 'openapi url with ftp:// scheme',
      yaml: [
        'project: ssrf-openapi-ftp',
        'sources:',
        '  openapi:',
        '    - name: evil',
        '      url: ftp://example.com/openapi.yaml',
      ],
    },
  ];

  for (const { label, yaml } of rejectCases) {
    it(`rejects ${label}`, () => {
      const configPath = join(tempDir, 'ctx.yaml');
      writeFileSync(configPath, yaml.join('\n'));
      expect(() => loadConfig(configPath)).toThrow();
    });
  }

  it('accepts a normal public https base_url', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    writeFileSync(
      configPath,
      [
        'project: ssrf-ok',
        'sources:',
        '  jira:',
        '    - name: prod',
        '      base_url: https://acme.atlassian.net',
        '      token: x',
      ].join('\n')
    );
    const config = loadConfig(configPath);
    expect(config.sources?.jira?.[0].base_url).toBe('https://acme.atlassian.net');
  });

  it('honours WITHCTX_ALLOW_PRIVATE_URLS=1 escape hatch for dev', () => {
    const configPath = join(tempDir, 'ctx.yaml');
    writeFileSync(
      configPath,
      [
        'project: ssrf-dev',
        'sources:',
        '  jira:',
        '    - name: dev',
        '      base_url: http://127.0.0.1:8080',
        '      token: x',
      ].join('\n')
    );
    const original = process.env.WITHCTX_ALLOW_PRIVATE_URLS;
    process.env.WITHCTX_ALLOW_PRIVATE_URLS = '1';
    try {
      const config = loadConfig(configPath);
      expect(config.sources?.jira?.[0].base_url).toBe('http://127.0.0.1:8080');
    } finally {
      if (original === undefined) {
        delete process.env.WITHCTX_ALLOW_PRIVATE_URLS;
      } else {
        process.env.WITHCTX_ALLOW_PRIVATE_URLS = original;
      }
    }
  });
});
