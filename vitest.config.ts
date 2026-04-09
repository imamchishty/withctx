import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/rag-export.test.ts'],
    testTimeout: 30000,
    server: {
      deps: {
        external: [
          'chromadb',
          '@google/generative-ai',
          '@modelcontextprotocol/sdk',
          '@anthropic-ai/sdk',
          'openai',
          'xlsx',
          'pdf-parse',
          'mammoth',
          'jszip',
        ],
      },
    },
  },
});
