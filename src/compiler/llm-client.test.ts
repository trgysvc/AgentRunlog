import { describe, it, expect } from 'vitest';
import { resolveLLMConfig } from './llm-client.js';

const keys = { ANTHROPIC_API_KEY: 'sk-ant-secret' } as NodeJS.ProcessEnv;

describe('resolveLLMConfig (NFR-02)', () => {
  it("'local' never uses the network, even when API keys exist", () => {
    expect(resolveLLMConfig({ provider: 'local' }, keys).provider).toBe('heuristic');
  });

  it('undefined provider defaults to offline heuristic', () => {
    expect(resolveLLMConfig({}, keys).provider).toBe('heuristic');
  });

  it("'cloud' picks the vendor that matches the available key", () => {
    const r = resolveLLMConfig({ provider: 'cloud', model: 'fast-default' }, keys);
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBe('sk-ant-secret');
    expect(r.model).toBeUndefined(); // placeholder model never forwarded
  });

  it("'cloud' without any key stays offline", () => {
    expect(resolveLLMConfig({ provider: 'cloud' }, {} as NodeJS.ProcessEnv).provider).toBe('heuristic');
  });

  it('a key is never sent to a different vendor', () => {
    const r = resolveLLMConfig({ provider: 'openai' }, keys);
    expect(r.provider).toBe('openai');
    expect(r.apiKey).toBeUndefined();
  });
});
