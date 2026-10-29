#!/usr/bin/env node
/**
 * 可被 agent 调用的结构化工具面。
 *
 * 设计原则：**复用生产路径，不另写一套**。
 * - `resolve_seed` / `get_candidates` 直接打应用自己的 HTTP 接口
 *   （`/api/resolve`、`/api/candidates`），所以请求预算、凭据、响应解析、
 *   消歧与重排全都走产品那条路。指向回放服务时，走的就是保存响应那条路。
 * - `reorder_candidates` 在本地复用生产重排器（`dist/assets/core/service.js`），
 *   不发任何请求。
 *
 * 用法：
 *   node scripts/tool.mjs list-tools
 *   node scripts/tool.mjs call resolve_seed '{"seed":"..."}'
 *   node scripts/tool.mjs call get_candidates '{"entity_id":"...","limit":5}'
 *   node scripts/tool.mjs call reorder_candidates '{"candidates":[...]}'
 *
 * 目标服务：`--base-url` 或 `TASTE_TUNER_BASE_URL`（默认 http://127.0.0.1:4173）。
 * 输出一律是 JSON（stdout），方便 agent 直接解析；失败也是 JSON，带明确的 status。
 *
 * 这里**没有**任何合成兜底：后端没配好就如实说 not_configured / upstream_error。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * 项目根 = 往上第一个含 `tools/tools.json` 的目录。
 * 这样同一个文件在源码树与发布候选树里都找得到自己的 schema 与构建产物。
 */
function findProjectRoot(start = scriptDir) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'tools', 'tools.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

const projectRoot = findProjectRoot();

/** 工具声明（输入 JSON Schema 也在里面）。 */
export function loadToolRegistry(root = projectRoot) {
  const raw = readFileSync(join(root, 'tools', 'tools.json'), 'utf8');
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      positional.push(item);
    }
  }
  return { positional, options };
}

function fail(message, extra = {}) {
  return { status: 'invalid_input', message, ...extra };
}

/** 最小校验：只查声明里 required 的字段与类型，不引依赖。 */
function validateInput(schema, input) {
  const required = schema.required ?? [];
  for (const key of required) {
    if (input[key] === undefined) return `Missing required field: ${key}`;
  }
  const properties = schema.properties ?? {};
  for (const [key, value] of Object.entries(input)) {
    const declared = properties[key];
    if (declared === undefined) {
      if (schema.additionalProperties === false) return `Unknown field: ${key}`;
      continue;
    }
    const types = Array.isArray(declared.type) ? declared.type : [declared.type];
    if (types.includes('null') && value === null) continue;
    const actual =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
    if (declared.type === 'integer' && actual !== 'integer') return `Field ${key} must be an integer`;
    if (declared.type !== 'integer' && !types.includes(actual)) return `Field ${key} has the wrong type (expected ${types.join('/')})`;
    if (declared.enum !== undefined && !declared.enum.includes(value)) {
      return `Field ${key} must be one of ${declared.enum.join(' / ')}`;
    }
    if (declared.minimum !== undefined && value < declared.minimum) {
      return `Field ${key} must not be smaller than ${declared.minimum}`;
    }
    if (declared.maximum !== undefined && value > declared.maximum) {
      return `Field ${key} must not be larger than ${declared.maximum}`;
    }
  }
  return undefined;
}

async function callHttp(tool, input, baseUrl) {
  const { method, path } = tool.transport;
  const body =
    tool.name === 'resolve_seed'
      ? { seed: input.seed, entityType: input.entity_type ?? 'movie' }
      : { entityId: input.entity_id, limit: input.limit ?? 5 };
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      status: 'upstream_error',
      message: `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return {
      status: 'upstream_error',
      message: `The backend did not return JSON (HTTP ${response.status})`,
    };
  }
  if (!response.ok) {
    return {
      status: payload.status ?? 'upstream_error',
      message: payload.message ?? `The backend returned HTTP ${response.status}`,
    };
  }
  return { status: payload.status ?? 'ok', data: payload };
}

async function callLocal(tool, input, options = {}) {
  const modulePath =
    options.env?.TASTE_TUNER_SERVICE_MODULE ??
    join(projectRoot, 'dist', 'assets', 'core', 'service.js');
  const service = await import(modulePath);
  const weights = input.weights ?? {};
  const controls = {
    affinityWeight: weights.affinity ?? 100,
    popularityWeight: weights.popularity ?? 0,
    tagSimilarityWeight: weights.tag_similarity ?? 0,
  };
  const constraint = {
    maxContentRating: input.constraint?.max_content_rating ?? null,
    minReleaseYear: input.constraint?.min_release_year ?? null,
  };
  const filtered = service.applyServiceConstraint(input.candidates, constraint);
  const ranked = service.rankServiceCandidates(filtered.kept, controls, input.seed_tags ?? []);
  return {
    status: 'ok',
    data: {
      candidates: ranked.map((item) => ({
        id: item.candidate.id,
        name: item.candidate.name,
        rank: item.rank,
        service_rank: item.serviceRank,
        score: item.score,
        delta_rank: item.deltaRank,
        affinity_contribution: item.affinityContribution,
        popularity_contribution: item.popularityContribution,
        tag_similarity_raw: item.tagSimilarityRaw,
      })),
      blocked_by_constraint: filtered.violated.map((item) => ({
        id: item.id,
        name: item.name,
      })),
      unverifiable_under_constraint: filtered.unverifiable.map((item) => ({
        id: item.id,
        name: item.name,
      })),
    },
  };
}

export async function runTool(argv, options = {}) {
  const registry = loadToolRegistry(options.root ?? projectRoot);
  const { positional, options: flags } = parseArgs(argv);
  const command = positional[0] ?? 'list-tools';

  if (command === 'list-tools') {
    return { status: 'ok', data: registry };
  }
  if (command !== 'call') {
    return fail('Usage: list-tools or call <tool> <json arguments>');
  }

  const name = positional[1];
  const tool = registry.tools.find((item) => item.name === name);
  if (tool === undefined) {
    return fail(`Unknown tool: ${name}`, { available: registry.tools.map((item) => item.name) });
  }
  let input;
  try {
    input = positional[2] === undefined ? {} : JSON.parse(positional[2]);
  } catch (error) {
    return fail(`Arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const invalid = validateInput(tool.input_schema, input);
  if (invalid !== undefined) return fail(invalid);

  const baseUrl =
    flags['base-url'] ??
    options.env?.TASTE_TUNER_BASE_URL ??
    registry.base_url.default;
  const source =
    flags['source-label'] ??
    options.env?.TASTE_TUNER_SOURCE_LABEL ??
    (tool.transport.kind === 'local' ? 'local' : 'app');

  const outcome =
    tool.transport.kind === 'local'
      ? await callLocal(tool, input, options)
      : await callHttp(tool, input, baseUrl);

  return {
    tool: tool.name,
    source,
    ...(tool.transport.kind === 'local' ? {} : { base_url: baseUrl }),
    ...outcome,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const result = await runTool(process.argv.slice(2), { env: process.env });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'ok' ? 0 : 1;
}
