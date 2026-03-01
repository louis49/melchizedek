/**
 * Golden prompt set — validates tool descriptions contain the right keywords
 * so that an LLM can discover the right tool for each use case.
 *
 * Structural test (no LLM in CI): checks that tool descriptions contain
 * expected keywords for each prompt scenario.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { openMemoryDatabase, closeDatabase } from '../src/db.js';
import type Database from 'better-sqlite3';

interface GoldenPrompt {
  category: string;
  prompt: string;
  expectedTool: string;
  keywords: string[];
}

const GOLDEN_PROMPTS: GoldenPrompt[] = [
  // --- Dev ---
  {
    category: 'dev',
    prompt: 'I have a CORS error in my Express middleware, how did we fix it last time?',
    expectedTool: 'm9k_errors',
    keywords: ['error', 'solution', 'resolved'],
  },
  {
    category: 'dev',
    prompt: 'What changes have we made to src/auth.ts across sessions?',
    expectedTool: 'm9k_file_history',
    keywords: ['file', 'conversations', 'touched'],
  },
  {
    category: 'dev',
    prompt: 'I need to refactor the database layer, have we done something similar before?',
    expectedTool: 'm9k_similar_work',
    keywords: ['similar', 'past', 'approaches'],
  },
  // --- Créatif ---
  {
    category: 'creative',
    prompt: 'What did we decide about the narrative structure of chapter 14?',
    expectedTool: 'm9k_search',
    keywords: ['search', 'past', 'conversations'],
  },
  {
    category: 'creative',
    prompt: 'Show me the full discussion we had about the character arc',
    expectedTool: 'm9k_full',
    keywords: ['full', 'content', 'complete'],
  },
  {
    category: 'creative',
    prompt: 'What was the context around that brainstorming session?',
    expectedTool: 'm9k_context',
    keywords: ['context', 'surrounding', 'conversation'],
  },
  // --- Analytique ---
  {
    category: 'analytics',
    prompt: 'How many sessions are indexed and how much memory is used?',
    expectedTool: 'm9k_info',
    keywords: ['information', 'corpus', 'usage'],
  },
  {
    category: 'analytics',
    prompt: 'List all recent sessions on this project',
    expectedTool: 'm9k_sessions',
    keywords: ['sessions', 'project'],
  },
  {
    category: 'analytics',
    prompt: 'Is the reranker enabled and what backend is it using?',
    expectedTool: 'm9k_config',
    keywords: ['config', 'view', 'update'],
  },
  // --- Référence ---
  {
    category: 'reference',
    prompt: 'Remember that we always use UUID v7, not v4, on this project',
    expectedTool: 'm9k_save',
    keywords: ['save', 'memory', 'note'],
  },
  {
    category: 'reference',
    prompt: 'What tools are available and how should I use them?',
    expectedTool: '__USAGE_GUIDE',
    keywords: ['tools', 'search', 'context'],
  },
  {
    category: 'reference',
    prompt: 'Find the first time we discussed the migration strategy',
    expectedTool: 'm9k_search',
    keywords: ['search', 'conversations'],
  },
  // --- Management ---
  {
    category: 'management',
    prompt: 'Delete that old test session from the index, it is cluttering results',
    expectedTool: 'm9k_delete_session',
    keywords: ['delete', 'session', 'remove'],
  },
  {
    category: 'management',
    prompt: 'Change the reranker top N setting to 15',
    expectedTool: 'm9k_config',
    keywords: ['config', 'update'],
  },
  {
    category: 'management',
    prompt: 'How is my memory performing? Show me search stats and token savings',
    expectedTool: 'm9k_info',
    keywords: ['information', 'usage', 'metrics'],
  },
];

describe('Golden prompt set', () => {
  let db: Database.Database;
  let client: Client;
  let toolDescriptions: Map<string, string>;

  beforeAll(async () => {
    db = openMemoryDatabase().db;
    const result = createServer({}, db);
    client = new Client({ name: 'golden-test', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([result.server.connect(st), client.connect(ct)]);

    const tools = await client.listTools();
    toolDescriptions = new Map(tools.tools.map((t) => [t.name, t.description ?? '']));
  });

  afterAll(() => {
    closeDatabase(db);
  });

  it('should have at least 15 prompts', () => {
    expect(GOLDEN_PROMPTS.length).toBeGreaterThanOrEqual(15);
  });

  it('should cover all 5 categories', () => {
    const categories = new Set(GOLDEN_PROMPTS.map((p) => p.category));
    expect(categories).toContain('dev');
    expect(categories).toContain('creative');
    expect(categories).toContain('analytics');
    expect(categories).toContain('reference');
    expect(categories).toContain('management');
  });

  it('should reference only existing tools', () => {
    for (const prompt of GOLDEN_PROMPTS) {
      expect(
        toolDescriptions.has(prompt.expectedTool),
        `Tool ${prompt.expectedTool} not found (prompt: "${prompt.prompt}")`,
      ).toBe(true);
    }
  });

  it('should have ≥80% keyword matching in tool descriptions', () => {
    let matches = 0;

    for (const prompt of GOLDEN_PROMPTS) {
      const description = (toolDescriptions.get(prompt.expectedTool) ?? '').toLowerCase();
      const hasAllKeywords = prompt.keywords.every((kw) => description.includes(kw.toLowerCase()));
      if (hasAllKeywords) matches++;
    }

    const ratio = matches / GOLDEN_PROMPTS.length;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it('__USAGE_GUIDE should mention all expected tools', () => {
    const guideDesc = toolDescriptions.get('__USAGE_GUIDE') ?? '';
    const expectedTools = new Set(GOLDEN_PROMPTS.map((p) => p.expectedTool));

    for (const tool of expectedTools) {
      if (tool === '__USAGE_GUIDE') continue; // Self-reference not needed
      expect(guideDesc.includes(tool), `__USAGE_GUIDE description should mention ${tool}`).toBe(
        true,
      );
    }
  });
});
