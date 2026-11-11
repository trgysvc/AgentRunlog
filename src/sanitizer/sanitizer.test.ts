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
