import { createHash } from 'node:crypto';
import { type ExtractedBundle } from './extractor.js';
import { type RawSessionEvent } from '../types/schemas.js';

function deterministicShortId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 6).toUpperCase();
}

export interface LLMClientConfig {
  provider?: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'heuristic';
  apiKey?: string;
  endpoint?: string;
  model?: string;
}

export class LLMCompilerClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig = {}) {
    this.config = {
      provider:
        config.provider ||
        (process.env.ANTHROPIC_API_KEY
          ? 'anthropic'
          : process.env.OPENAI_API_KEY
            ? 'openai'
            : process.env.GEMINI_API_KEY
              ? 'gemini'
              : 'heuristic'),
      apiKey:
        config.apiKey ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.GEMINI_API_KEY,
      endpoint: config.endpoint,
      model: config.model,
    };
  }

  /**
   * Calls the configured LLM provider and parses the extracted bundle.
   */
  public async extract(prompt: string, events: RawSessionEvent[]): Promise<ExtractedBundle> {
    if (this.config.provider === 'heuristic' || (!this.config.apiKey && this.config.provider !== 'ollama')) {
      return this.heuristicFallbackExtract(events);
    }

    try {
      let rawResponse: string;

      if (this.config.provider === 'anthropic') {
        rawResponse = await this.callAnthropic(prompt);
      } else if (this.config.provider === 'gemini') {
        rawResponse = await this.callGemini(prompt);
      } else if (this.config.provider === 'ollama') {
        rawResponse = await this.callOllama(prompt);
      } else {
        rawResponse = await this.callOpenAICompatible(prompt);
      }

      return this.parseJSONBundle(rawResponse);
    } catch (err) {
      console.warn('LLM compilation request failed, falling back to heuristic extraction:', err);
      return this.heuristicFallbackExtract(events);
    }
  }

  private async callOpenAICompatible(prompt: string): Promise<string> {
    const endpoint = this.config.endpoint || 'https://api.openai.com/v1/chat/completions';
    const model = this.config.model || 'gpt-4o-mini';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data?.choices?.[0]?.message?.content || '{}';
  }

  private async callAnthropic(prompt: string): Promise<string> {
    const endpoint = this.config.endpoint || 'https://api.anthropic.com/v1/messages';
    const model = this.config.model || 'claude-3-5-haiku-20241022';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data?.content?.[0]?.text || '{}';
  }

  private async callGemini(prompt: string): Promise<string> {
    const model = this.config.model || 'gemini-1.5-flash';
    const endpoint =
      this.config.endpoint ||
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.config.apiKey}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  }

  private async callOllama(prompt: string): Promise<string> {
    const endpoint = this.config.endpoint || 'http://localhost:11434/api/generate';
    const model = this.config.model || 'qwen2.5-coder:7b';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data?.response || '{}';
  }

  /**
   * Safely parses JSON output from LLM, stripping markdown codeblocks if present.
   */
  public parseJSONBundle(raw: string): ExtractedBundle {
    let clean = raw.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    }

    const parsed = JSON.parse(clean);
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      rcas: Array.isArray(parsed.rcas) ? parsed.rcas : [],
      deadEnds: Array.isArray(parsed.deadEnds) ? parsed.deadEnds : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  }

  /**
   * Heuristic fallback when running completely offline without API keys.
   * Automatically scans events for:
   * - Natural language architectural decisions (FR-03)
   * - Repeated consecutive failures -> DeadEnds (FR-05, FR-20)
   * - Single tool crashes -> RCAs (FR-04)
   * - Initial session prompt -> Tasks (FR-02)
   */
  public heuristicFallbackExtract(events: RawSessionEvent[]): ExtractedBundle {
    const bundle: ExtractedBundle = {
      decisions: [],
      rcas: [],
      deadEnds: [],
      tasks: [],
    };

    if (events.length === 0) return bundle;
    const sessionId = events[0].sessionId;
    const isHistoricalImport = sessionId.startsWith('import_');
    const failureCounts = new Map<string, { count: number; lastError: string; timestamp: string; turnIndex: number }>();

    const decisionSignalRegex =
      /\b(let'?s use|decided to|we will use|switch to|migrate to|instead of|adopt|use .+ over|kullanalım|kullanacağız|karar|yerine|geçelim|tercih)\b/i;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const payload = e.payload || {};
      const promptText = String(payload.text || payload.prompt || payload.rawText || '');

      // 1. Detect natural-language engineering decisions automatically (cap 5 per session)
      // NFR-08: Historical heuristic extractions are marked status: 'draft' and confidence: 'low'
      // so they do NOT pollute push cache until verified.
      if (
        bundle.decisions.length < 5 &&
        e.eventType === 'prompt_submit' &&
        promptText.length > 10 &&
        promptText.length < 500 &&
        decisionSignalRegex.test(promptText)
      ) {
        const cleanSingleLine = promptText.replace(/\s+/g, ' ').trim();
        bundle.decisions.push({
          id: `DEC-${deterministicShortId(`${sessionId}:dec:${i}`)}`,
          title: cleanSingleLine.slice(0, 65),
          status: isHistoricalImport ? 'draft' : 'active',
          decidedBy: isHistoricalImport ? 'historical-candidate' : 'user',
          author: 'user',
          context: `User directive captured during session ${sessionId}`,
          choice: cleanSingleLine.slice(0, 280),
          supersedes: [],
          supersededBy: null,
          affectsModules: [],
          evidence: {
            sessionId,
            turnIndex: i + 1,
            timestamp: e.timestamp,
          },
          confidence: isHistoricalImport ? 'low' : 'medium',
          createdAt: e.timestamp,
          updatedAt: e.timestamp,
        });
      }

      // 2. Detect failed tool calls & repeated dead-end failures
      if (e.eventType === 'post_tool_use' && (payload.error || (payload.exitCode !== undefined && payload.exitCode !== 0))) {
        const cmdKey = String(payload.command || payload.tool || 'Tool');
        const errMsg = String(payload.error || `Exit code ${payload.exitCode}`);

        const prev = failureCounts.get(cmdKey) || { count: 0, lastError: '', timestamp: e.timestamp, turnIndex: i + 1 };
        prev.count += 1;
        prev.lastError = errMsg;
        prev.timestamp = e.timestamp;
        prev.turnIndex = i + 1;
        failureCounts.set(cmdKey, prev);

        if (prev.count === 1) {
          bundle.rcas.push({
            id: `RCA-${deterministicShortId(`${sessionId}:rca:${i}`)}`,
            title: `Command Failed: ${cmdKey}`,
            incident: errMsg,
            rootCause: 'Command returned non-zero exit code during execution',
            resolution: 'Investigate error output and fix failing command arguments',
            preventativeActions: ['Check syntax and dependencies before execution'],
            affectsFiles: [],
            evidence: {
              sessionId,
              turnIndex: i + 1,
              timestamp: e.timestamp,
            },
            confidence: isHistoricalImport ? 'low' : 'medium',
            createdAt: e.timestamp,
          });
        }
      }

      // 3. Detect task descriptions from initial prompt
      if (e.eventType === 'prompt_submit' && promptText && bundle.tasks.length === 0) {
        bundle.tasks.push({
          id: `TASK-${deterministicShortId(`${sessionId}:task:${i}`)}`,
          title: promptText.slice(0, 60),
          summary: promptText,
          filesModified: [],
          status: 'completed',
          evidence: {
            sessionId,
            turnIndex: i + 1,
            timestamp: e.timestamp,
          },
          createdAt: e.timestamp,
        });
      }
    }

    // Promote repeated failures (2+ failures on same command/tool) to a Soft Guardrail DeadEnd
    for (const [cmdKey, stats] of failureCounts.entries()) {
      if (stats.count >= 2) {
        bundle.deadEnds.push({
          id: `DEAD-${deterministicShortId(`${sessionId}:dead:${cmdKey}`)}`,
          title: `Repeated Failure on ${cmdKey}`,
          rootCauseType: 'incompatibility',
          approach: cmdKey,
          whyFailed: `Failed ${stats.count} times in session. Last error: ${stats.lastError}`,
          retryConditions: 'Verify environment configuration, dependencies, or alternative command flags before retrying.',
          affectsModules: [],
          evidence: {
            sessionId,
            turnIndex: stats.turnIndex,
            timestamp: stats.timestamp,
          },
          confidence: isHistoricalImport ? 'low' : 'medium',
          createdAt: stats.timestamp,
        });
      }
    }

    return bundle;
  }
}
