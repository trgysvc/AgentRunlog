import { describe, it, expect } from 'vitest';
import { defaultSanitizer } from './index.js';

describe('Sanitizer', () => {
  it('redacts OpenAI api keys', () => {
    const raw = 'export OPENAI_API_KEY="sk-proj-12345678901234567890123456789012"';
    const clean = defaultSanitizer.redactText(raw);
    expect(clean).not.toContain('sk-proj-12345678901234567890123456789012');
    expect(clean).toMatch(/\[REDACTED:OPENAI_API_KEY:[a-f0-9]{6}\]/);
  });

  it('redacts Anthropic api keys', () => {
    const raw = 'const key = "sk-ant-api03-abcdef123456789012345678901234567890";';
    const clean = defaultSanitizer.redactText(raw);
    expect(clean).not.toContain('sk-ant-api03-abcdef123456789012345678901234567890');
    expect(clean).toMatch(/\[REDACTED:ANTHROPIC_API_KEY:[a-f0-9]{6}\]/);
  });

  it('redacts GitHub personal access tokens', () => {
    const raw = 'git clone https://ghp_123456789012345678901234567890123456@github.com/repo';
    const clean = defaultSanitizer.redactText(raw);
    expect(clean).not.toContain('ghp_123456789012345678901234567890123456');
    expect(clean).toMatch(/\[REDACTED:GITHUB_TOKEN:[a-f0-9]{6}\]/);
  });

  it('redacts DB connection string password while preserving database host', () => {
    const raw = 'postgres://postgres:supersecretpassword123@db.example.com:5432/production_db';
    const clean = defaultSanitizer.redactText(raw);
    expect(clean).not.toContain('supersecretpassword123');
    expect(clean).toContain('postgres://postgres:');
    expect(clean).toContain('@db.example.com:5432/production_db');
    expect(clean).toMatch(/\[REDACTED:PASSWORD:[a-f0-9]{6}\]/);
  });

  it('redacts key-value configuration passwords', () => {
    const raw = '{"database": "app", "password": "MySuperSecretPassword99!"}';
    const clean = defaultSanitizer.redactText(raw);
    expect(clean).not.toContain('MySuperSecretPassword99!');
    expect(clean).toMatch(/\[REDACTED:SECRET:[a-f0-9]{6}\]/);
  });

  it('deeply redacts nested JSON objects', () => {
    const obj = {
      user: 'alice',
      env: {
        AWS_KEY: 'AKIAIOSFODNN7EXAMPLE',
        SECRET_TOKEN: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      },
      tags: ['auth', 'production'],
    };

    const redacted = defaultSanitizer.redactObject(obj);
    expect(redacted.user).toBe('alice');
    expect(redacted.tags).toEqual(['auth', 'production']);
    expect(redacted.env.AWS_KEY).toMatch(/\[REDACTED:AWS_ACCESS_KEY:[a-f0-9]{6}\]/);
    expect(redacted.env.SECRET_TOKEN).toContain('Bearer [REDACTED:JWT_TOKEN:');
  });
});

describe('Sanitizer extra secret shapes', () => {
  it('redacts env-style assignments, opaque bearer, npm and stripe tokens', async () => {
    const { Sanitizer } = await import('./index.js');
    const s = new Sanitizer();
    const out = s.redactText(
      'DATABASE_PASSWORD=hunter2hunter2 AWS_SECRET_ACCESS_KEY=abcd1234efgh5678 Authorization: Bearer abcdefghijklmnopqrstuvwx1234 npm_abcdefghijklmnopqrstuvwxyz0123456789 sk_live_abcdefghijklmnopqrstu'
    );
    for (const leaked of ['hunter2hunter2', 'abcd1234efgh5678', 'abcdefghijklmnopqrstuvwx1234', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'sk_live_abcdefghijklmnopqrstu']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('DATABASE_PASSWORD=[REDACTED');
  });
});

import { describe as d2, it as i2, expect as e2 } from 'vitest';
import { Sanitizer as S2 } from './index.js';
d2('bare key=value secrets', () => {
  i2('redacts unquoted password=value', () => {
    const out = new S2().redactText('use password=hunter2hunter2 now');
    e2(out).not.toContain('hunter2hunter2');
  });
});
