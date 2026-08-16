// Extraction — LLM-based semantic extraction via configurable providers

import { createHash } from 'node:crypto';
import type { PreExtractedClaim } from '../layer0/types.js';
import type { Entity } from '../layer1/types.js';
import type { SmartwareConfig } from '../config.js';

const COMPILER_VERSION = '0.6.1';
const LLM_TIMEOUT_MS = 30_000;

const EXTRACT_SYSTEM = `You are a claim extractor for a personal knowledge management system.
Your job: read text and extract every meaningful fact as a structured claim.

CRITICAL RULES:
1. Extract SPECIFIC facts, not vague summaries. "Coffee is decision infrastructure for human-agent teams" is good. "Coffee is a product" is too vague.
2. Every named thing (product, tool, person, company, service) is a separate subject. Don't lump everything under one subject.
3. Capture relationships between entities: "RunLedger acts as CI regression gate for Coffee" → subject: RunLedger, predicate: description_is, object: "CI regression gate for Coffee"
4. Capture decisions and their rationale: "Chose X over Y because Z"
5. Set subject_type for each claim: person, tool, organisation, project, decision, concept, event, preference

PREDICATES (use these exactly):
- description_is: what something IS or DOES (most common — use for definitions, roles, purposes)
- status_is: current state (active, rejected, deployed, planned, viable, deprecated, chosen, evaluated)
- decided_on: a decision that was made
- belongs_to: part of a larger system/project
- related_to: connected to another entity (use entity_ref type)
- created_by: who made it
- deadline_is: target date
- preference_is: a stated preference or principle
- type_is: classification/category
- located_in: physical or logical location
- version_is: version number
- value_is: a quantitative value (price, cost, metric)
- completed_at: when something was finished

TYPED VALUES:
- { "type": "text", "value": "descriptive string" }
- { "type": "date", "value": "YYYY-MM-DD" }
- { "type": "number", "value": 42 }
- { "type": "enum", "value": "active" }
- { "type": "boolean", "value": true }
- { "type": "entity_ref", "value": "OtherEntityName" }

EPISTEMIC LABELS:
- observed: directly stated in text
- asserted: claimed as fact by the author
- inferred: derived from context, not explicitly stated

CONFIDENCE:
- 0.9: directly and unambiguously stated
- 0.8: clearly stated but requires minor interpretation
- 0.7: reasonable inference from context
- 0.5: speculative or loosely implied

Respond with ONLY a JSON array. No markdown fences. No explanation.
Each claim: { subject_name, subject_type, predicate, object, scope, validity: { from, to }, epistemic, confidence, sensitive }`;

type SupportedProvider = Exclude<SmartwareConfig['llm']['provider'], 'none'>;

function requireEnv(name: string, provider: SupportedProvider): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(name + ' is required for the ' + provider + ' provider');
  }
  return value;
}

async function requestAnthropicText(config: SmartwareConfig, system: string | undefined, prompt: string, maxTokens: number): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': requireEnv('ANTHROPIC_API_KEY', 'anthropic'),
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error('Anthropic request failed (' + response.status + ')');
  }

  const data = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = data.content?.find(item => item.type === 'text')?.text?.trim();
  if (!text) throw new Error('Anthropic returned no text');
  return text;
}

async function requestOpenAIText(config: SmartwareConfig, system: string | undefined, prompt: string, maxTokens: number): Promise<string> {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + requireEnv('OPENAI_API_KEY', 'openai'),
    'content-type': 'application/json',
  };
  const orgId = process.env['OPENAI_ORG_ID']?.trim();
  if (orgId) {
    headers['OpenAI-Organization'] = orgId;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error('OpenAI request failed (' + response.status + ')');
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content)
      ? content.map(part => typeof part.text === 'string' ? part.text : '').join('').trim()
      : '';
  if (!text) throw new Error('OpenAI returned no text');
  return text;
}

// OpenRouter speaks the OpenAI chat-completions API — same request/response
// shape, different base URL and key. Reuse the OpenAI parsing.
async function requestOpenRouterText(config: SmartwareConfig, system: string | undefined, prompt: string, maxTokens: number): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + requireEnv('OPENROUTER_API_KEY', 'openrouter'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error('OpenRouter request failed (' + response.status + ')');
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content)
      ? content.map(part => typeof part.text === 'string' ? part.text : '').join('').trim()
      : '';
  if (!text) throw new Error('OpenRouter returned no text');
  return text;
}

async function requestLLMText(config: SmartwareConfig, options: { system?: string; prompt: string; maxTokens: number }): Promise<string> {
  if (config.llm.provider === 'none') {
    return '';
  }
  if (config.llm.provider === 'anthropic') {
    return requestAnthropicText(config, options.system, options.prompt, options.maxTokens);
  }
  if (config.llm.provider === 'openai') {
    return requestOpenAIText(config, options.system, options.prompt, options.maxTokens);
  }
  if (config.llm.provider === 'openrouter') {
    return requestOpenRouterText(config, options.system, options.prompt, options.maxTokens);
  }
  throw new Error('Unsupported llm provider: ' + config.llm.provider);
}

import type { RelationProposal } from './deterministic.js';

export interface LLMExtractionResult {
  claims: PreExtractedClaim[];
  relation_proposals: RelationProposal[];
  model: string;
  promptHash: string;
}

export async function extractClaimsLLM(
  content: string,
  scope: string,
  validityFrom: string,
  existingEntities: Entity[],
  config: SmartwareConfig,
): Promise<LLMExtractionResult> {
  if (config.llm.provider === 'none') {
    return { claims: [], relation_proposals: [], model: 'none', promptHash: '' };
  }

  const entityContext = existingEntities
    .slice(0, 50)
    .map(e => ({ id: e.id, name: e.canonical_name, type: e.type }));

  const userContent = `Extract claims from the following content. Use scope: "${scope}" and validity.from: "${validityFrom}" for all claims unless the text indicates otherwise.\n\nContent:\n${content}\n\nKnown entities (use these IDs when applicable):\n${JSON.stringify(entityContext)}`;

  const text = await requestLLMText(config, {
    system: EXTRACT_SYSTEM,
    prompt: userContent,
    maxTokens: 2000,
  });
  const promptHash = computePromptHash(EXTRACT_SYSTEM + userContent);

  let rawClaims: unknown[] = [];
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    rawClaims = JSON.parse(cleaned);
    if (!Array.isArray(rawClaims)) rawClaims = [];
  } catch {
    rawClaims = [];
  }

  const claims: PreExtractedClaim[] = rawClaims
    .filter(c => isValidRawClaim(c))
    .map(c => normaliseRawClaim(
      c as Record<string, unknown>,
      scope,
      validityFrom,
      config.llm.model,
      promptHash,
    ));

  const relation_proposals: RelationProposal[] = [];
  for (const claim of claims) {
    if (claim.predicate === 'related_to' && claim.object.type === 'entity_ref') {
      relation_proposals.push({
        kind: 'references',
        source_content: claim.subject_name,
        target_content: String(claim.object.value),
        rule_id: 'llm_entity_ref',
        observation_ids: [],
        origin: 'deterministic',
      });
    }
  }
  return { claims, relation_proposals, model: config.llm.model, promptHash };
}

function isValidRawClaim(c: unknown): boolean {
  if (typeof c !== 'object' || c === null) return false;
  const r = c as Record<string, unknown>;
  return typeof r['subject_name'] === 'string' &&
    typeof r['predicate'] === 'string' &&
    typeof r['object'] === 'object';
}

function normaliseRawClaim(
  raw: Record<string, unknown>,
  defaultScope: string,
  defaultFrom: string,
  model: string,
  promptHash: string,
): PreExtractedClaim {
  const validity = (raw['validity'] as { from?: string; to?: string | null } | undefined) ?? {};
  const from = validity.from ?? defaultFrom;
  const to = validity.to ?? null;

  return {
    subject_name: raw['subject_name'] as string,
    subject_type: (raw['subject_type'] as string) ?? undefined,
    predicate: raw['predicate'] as string,
    object: raw['object'] as PreExtractedClaim['object'],
    scope: (raw['scope'] as string) ?? defaultScope,
    validity: {
      from,
      to,
    },
    t_valid_from: { value: from, state: validity.from ? 'known' : 'inferred', basis: validity.from ? undefined : 'source_observed_at' },
    t_valid_to: to ? { value: to, state: 'known' } : { value: null, state: 'null' },
    epistemic: (raw['epistemic'] as PreExtractedClaim['epistemic']) ?? 'inferred',
    confidence: typeof raw['confidence'] === 'number' ? raw['confidence'] : 0.7,
    sensitive: !!(raw['sensitive']),
    extraction: {
      method: 'llm',
      model,
      compiler_version: COMPILER_VERSION,
      prompt_hash: promptHash,
    },
  };
}

function computePromptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Generate a compiled markdown page using the active LLM provider */
export async function compileMarkdownLLM(
  entityName: string,
  entityType: string,
  claims: Array<{ predicate: string; object: { type: string; value: unknown }; epistemic: string; confidence: number }>,
  existingPage: string | null,
  config: SmartwareConfig,
): Promise<{ oneliner: string; paragraph: string; fullPage: string }> {
  if (config.llm.provider === 'none' || claims.length === 0) {
    const oneliner = `${entityName} (${entityType})`;
    const paragraph = claims.map(c => `${c.predicate}: ${JSON.stringify(c.object.value)}`).join('. ');
    const fullPage = `## ${entityName}\n\n${paragraph}`;
    return { oneliner, paragraph, fullPage };
  }

  const claimSummary = claims
    .map(c => `- ${c.predicate}: ${JSON.stringify(c.object.value)} (${c.epistemic}, conf: ${c.confidence.toFixed(2)})`)
    .join('\n');

  const prompt = `Synthesise the following claims about "${entityName}" (type: ${entityType}) into a concise knowledge page.

Claims:
${claimSummary}

${existingPage ? `Existing page:\n${existingPage}\n\n` : ''}Produce three sections:
1. ONE_LINER: A single sentence summary (under 100 characters)
2. PARAGRAPH: A 2-4 sentence paragraph with the key facts
3. FULL_PAGE: A complete markdown page with headings and details

Format your response as JSON:
{ "oneliner": "...", "paragraph": "...", "fullPage": "..." }`;

  const text = await requestLLMText(config, {
    prompt,
    maxTokens: 3000,
  });
  try {
    const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as { oneliner?: string; paragraph?: string; fullPage?: string };
    return {
      oneliner: parsed.oneliner ?? `${entityName} (${entityType})`,
      paragraph: parsed.paragraph ?? claimSummary,
      fullPage: parsed.fullPage ?? `## ${entityName}\n\n${claimSummary}`,
    };
  } catch {
    return {
      oneliner: `${entityName} (${entityType})`,
      paragraph: claimSummary,
      fullPage: `## ${entityName}\n\n${claimSummary}`,
    };
  }
}
