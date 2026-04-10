import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mock the Anthropic SDK. We capture every request body passed to
 * messages.create and hand back a deterministic response so we can
 * assert on what the ClaudeClient wrapper actually sends over the wire.
 */
const capturedRequests: Array<Record<string, unknown>> = [];
const mockResponse = {
  content: [{ type: 'text', text: 'hello from mock' }],
  model: 'claude-sonnet-4-20250514',
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = {
      create: vi.fn(async (body: Record<string, unknown>) => {
        capturedRequests.push(body);
        return mockResponse;
      }),
    };
  }
  return { default: MockAnthropic };
});

// Must be imported *after* the mock is registered so the mocked SDK is used.
const { ClaudeClient } = await import('../src/claude/client.js');

beforeEach(() => {
  capturedRequests.length = 0;
  mockResponse.usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
});

describe('ClaudeClient.prompt — backward compatibility', () => {
  it('still accepts a plain string as the first argument', async () => {
    const client = new ClaudeClient();
    const res = await client.prompt('What is 2+2?');

    expect(res.content).toBe('hello from mock');
    expect(capturedRequests).toHaveLength(1);
    const body = capturedRequests[0];
    expect(body.messages).toEqual([{ role: 'user', content: 'What is 2+2?' }]);
    // No system prompt was given, so none should be sent
    expect(body.system).toBeUndefined();
  });

  it('forwards systemPrompt as a plain string when caching is not requested', async () => {
    const client = new ClaudeClient();
    await client.prompt('hello', {
      systemPrompt: 'You are a helpful assistant.',
    });

    const body = capturedRequests[0];
    expect(body.system).toBe('You are a helpful assistant.');
  });
});

describe('ClaudeClient.prompt — prompt caching', () => {
  it('sends the system prompt as a cache_control block when cacheSystemPrompt is true', async () => {
    const client = new ClaudeClient();
    await client.prompt('user message content', {
      systemPrompt: 'LARGE compilation instructions that rarely change',
      cacheSystemPrompt: true,
    });

    const body = capturedRequests[0];
    expect(Array.isArray(body.system)).toBe(true);
    const systemBlocks = body.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].type).toBe('text');
    expect(systemBlocks[0].text).toBe(
      'LARGE compilation instructions that rarely change'
    );
    expect(systemBlocks[0].cache_control).toEqual({ type: 'ephemeral' });

    // The user message (which changes every call) must NOT carry a cache marker
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toEqual([
      { role: 'user', content: 'user message content' },
    ]);
  });

  it('parses cache_read_input_tokens and cache_creation_input_tokens from the response', async () => {
    mockResponse.usage = {
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 45_231,
      cache_creation_input_tokens: 0,
    };

    const client = new ClaudeClient();
    const res = await client.prompt('anything', {
      systemPrompt: 'cached system',
      cacheSystemPrompt: true,
    });

    expect(res.tokensUsed).toBeDefined();
    expect(res.tokensUsed!.input).toBe(200);
    expect(res.tokensUsed!.output).toBe(80);
    expect(res.tokensUsed!.cacheRead).toBe(45_231);
    expect(res.tokensUsed!.cacheCreation).toBe(0);
  });

  it('reports cacheCreation tokens on first call (cache miss / write)', async () => {
    mockResponse.usage = {
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 12_000,
    };

    const client = new ClaudeClient();
    const res = await client.prompt('first call', {
      systemPrompt: 'cached system',
      cacheSystemPrompt: true,
    });

    expect(res.tokensUsed!.cacheCreation).toBe(12_000);
    expect(res.tokensUsed!.cacheRead).toBe(0);
  });
});

describe('Prompt caching cost math', () => {
  // Claude Sonnet 4 input pricing from src/costs/tracker.ts: $3/M input tokens
  const SONNET_INPUT_PER_MTOK = 3;

  /**
   * Mirrors the savings calculation used in src/cli/commands/ingest.ts:
   * cached reads are billed at 10% of normal input, so savings = 90% of normal.
   */
  function calcCacheSavings(cacheReadTokens: number, pricePerMtok: number): number {
    return (cacheReadTokens / 1_000_000) * pricePerMtok * 0.9;
  }

  it('saves ~90% of normal input cost on cache reads', () => {
    // 1M cached tokens would normally cost $3; with cache it costs $0.30 → save $2.70
    const saved = calcCacheSavings(1_000_000, SONNET_INPUT_PER_MTOK);
    expect(saved).toBeCloseTo(2.7, 2);
  });

  it('matches the savings message format for a realistic 45k-token hit', () => {
    // 45,231 tokens * $3/M * 0.9 = ~$0.12212
    const saved = calcCacheSavings(45_231, SONNET_INPUT_PER_MTOK);
    expect(saved).toBeGreaterThan(0.12);
    expect(saved).toBeLessThan(0.13);
  });

  it('returns zero savings when no cache hit occurred', () => {
    expect(calcCacheSavings(0, SONNET_INPUT_PER_MTOK)).toBe(0);
  });
});
