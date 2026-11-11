import { createHash } from 'node:crypto';

export interface SanitizerRule {
  name: string;
  pattern: RegExp;
  maskGenerator?: (match: string) => string;
}

/**
 * Creates a deterministic, non-reversible mask for redacted secrets.
 * e.g. [REDACTED:GITHUB_TOKEN:a1b2c3]
 */
function createSecretMask(kind: string, secret: string): string {
  const hash = createHash('sha256').update(secret).digest('hex').slice(0, 6);
  return `[REDACTED:${kind}:${hash}]`;
}

export const DEFAULT_RULES: SanitizerRule[] = [
  // 1. Anthropic API Keys (tested before generic sk- keys)
  {
    name: 'ANTHROPIC_API_KEY',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    maskGenerator: (m) => createSecretMask('ANTHROPIC_API_KEY', m),
  },
  // 2. OpenAI API Keys (sk-..., sk-proj-...)
  {
    name: 'OPENAI_API_KEY',
    pattern: /\bsk-(?!(?:ant)-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
    maskGenerator: (m) => createSecretMask('OPENAI_API_KEY', m),
  },
  // 3. GitHub Tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  {
    name: 'GITHUB_TOKEN',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
    maskGenerator: (m) => createSecretMask('GITHUB_TOKEN', m),
  },
  // 4. AWS Access Key ID
  {
    name: 'AWS_ACCESS_KEY',
    pattern: /\b(?:AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g,
    maskGenerator: (m) => createSecretMask('AWS_ACCESS_KEY', m),
  },
  // 5. Google Cloud API Key
  {
    name: 'GOOGLE_API_KEY',
    pattern: /\bAIza[0-9A-Za-z-_]{35}\b/g,
    maskGenerator: (m) => createSecretMask('GOOGLE_API_KEY', m),
  },
  // 6. Slack Tokens (xoxb-, xoxp-, xapp-)
  {
    name: 'SLACK_TOKEN',
    pattern: /\bxox[bpa]-[0-9A-Za-z-]{20,}\b/g,
    maskGenerator: (m) => createSecretMask('SLACK_TOKEN', m),
  },
  // 7. Generic JWT & Bearer Tokens
  {
    name: 'BEARER_TOKEN',
    pattern: /Bearer\s+([A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+)/g,
    maskGenerator: (m) => {
      const parts = m.split(/\s+/);
      const token = parts[1] || m;
      return `Bearer ${createSecretMask('JWT_TOKEN', token)}`;
    },
  },
  // 8. PEM Private Keys
  {
    name: 'PRIVATE_KEY',
    pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[A-Za-z0-9+/=\s\r\n]+-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
    maskGenerator: (m) => createSecretMask('PRIVATE_KEY', m),
  },
  // 9. Database Connection URIs with credentials (postgres, mysql, mongodb, redis)
  {
    name: 'DB_CONNECTION_URI',
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s\/]+):([^@\s\/]+)(@[^\s]+)/gi,
    maskGenerator: (fullMatch) => {
      return fullMatch.replace(
        /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s\/]+):([^@\s\/]+)(@[^\s]+)/i,
        (_all, prefix, password, suffix) => {
          if (password.startsWith('[REDACTED:')) return fullMatch;
          return `${prefix}:${createSecretMask('PASSWORD', password)}${suffix}`;
        }
      );
    },
  },
  // 10. Key-Value Secret assignments (only when not already redacted)
  {
    name: 'KV_SECRET',
    pattern: /(["']?(?:api[_-]?key|secret|password|passwd|auth[_-]?token)["']?\s*[:=]\s*["'])(?!\s*\[REDACTED:)([^"'\r\n\s]{8,})(["'])/gi,
    maskGenerator: (fullMatch) => {
      return fullMatch.replace(
        /(["']?(?:api[_-]?key|secret|password|passwd|auth[_-]?token)["']?\s*[:=]\s*["'])(?!\s*\[REDACTED:)([^"'\r\n\s]{8,})(["'])/i,
        (_all, prefix, secret, suffix) => {
          if (secret.startsWith('[REDACTED:')) return fullMatch;
          return `${prefix}${createSecretMask('SECRET', secret)}${suffix}`;
        }
      );
    },
  },
];

export class Sanitizer {
  private rules: SanitizerRule[];

  constructor(customPatterns: string[] = []) {
    this.rules = [...DEFAULT_RULES];

    for (const pat of customPatterns) {
      try {
        this.rules.push({
          name: 'CUSTOM_PATTERN',
          pattern: new RegExp(pat, 'g'),
          maskGenerator: (m) => createSecretMask('CUSTOM', m),
        });
      } catch (err) {
        console.error(`Invalid custom regex pattern in sanitizer: ${pat}`, err);
      }
    }
  }

  /**
   * Redacts all sensitive patterns from a given string.
   */
  public redactText(text: string): string {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;
    for (const rule of this.rules) {
      sanitized = sanitized.replace(rule.pattern, (match) => {
        return rule.maskGenerator ? rule.maskGenerator(match) : `[REDACTED:${rule.name}]`;
      });
    }
    return sanitized;
  }

  /**
   * Deeply redacts an arbitrary JSON/JS object or primitive recursively.
   */
  public redactObject<T>(input: T): T {
    if (input === null || input === undefined) return input;

    if (typeof input === 'string') {
      return this.redactText(input) as unknown as T;
    }

    if (Array.isArray(input)) {
      return input.map((item) => this.redactObject(item)) as unknown as T;
    }

    if (typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        result[key] = this.redactObject(value);
      }
      return result as T;
    }

    return input;
  }
}

export const defaultSanitizer = new Sanitizer();
