// Codex CLI fallback. Used when MODE=agent (full cascade in the agent) or
// MODE=hybrid (agent only handles bucket 3/4/5 residuals).
//
// We shell out to `codex exec`, hand it a prompt that inlines the candidate
// list (plus pre-fetched bodies), and let the model decide. The agent is
// expected to call back into the host via the side-effect helpers we expose
// — but to keep this stripped-down repo simple, we instead use codex in
// "structured output" mode: ask it for a JSON array of decisions and apply
// them ourselves on the host. No MCP server, no tool round-trips.

import { spawn } from 'child_process';

import { CODEX_BIN, CODEX_MODEL } from './config.js';
import { log } from './log.js';
import { composeSystemPrompt } from './prompts.js';
import { ClassificationResult, LlmCandidate, Taxonomy } from './types.js';

interface AgentBatchResult {
  email_id: string;
  needs_task: boolean;
  sort_folder: string;
  task_title: string;
  reasoning: string;
}

export interface CodexUsage {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  latency_ms: number;
}

interface CodexExecResult {
  agentMessage: string;
  usage: CodexUsage | null;
}

function buildBatchPrompt(
  candidates: LlmCandidate[],
  taxonomy: Taxonomy,
): string {
  const folderBullets = taxonomy.folders
    .map((f) => {
      const hint = taxonomy.context[f];
      return hint ? `  ${f} — ${hint}` : `  ${f}`;
    })
    .join('\n');

  const candidateRows = candidates
    .map((c, i) => {
      const head = `${i + 1}. id=${c.id} account=${c.account} from=${c.from} subject="${(c.subject || '').slice(0, 120)}" hint=${c.bucket_hint}`;
      const body = c.body
        ? `\n   body: ${c.body}`
        : `\n   body: (host body-fetch failed)`;
      return head + body;
    })
    .join('\n\n');

  // Persona + skill body live in AGENT.md and skills/triage/SKILL.md.
  // Runtime-computed appendix (taxonomy + candidate list) is appended below.
  const appendix = [
    `Taxonomy (pick exactly one for sort_folder):`,
    folderBullets,
    '',
    'Candidates:',
    candidateRows,
  ].join('\n');

  return composeSystemPrompt('triage', appendix);
}

function runCodexExec(prompt: string): Promise<CodexExecResult> {
  const startMs = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(
      CODEX_BIN,
      [
        'exec',
        '--model',
        CODEX_MODEL,
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`codex exec exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(parseCodexJsonl(stdout, Date.now() - startMs));
      } catch (err) {
        reject(err);
      }
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function parseCodexJsonl(raw: string, latencyMs: number): CodexExecResult {
  let agentMessage = '';
  let usage: CodexUsage | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type === 'item.completed') {
      const item = evt.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        agentMessage = item.text;
      }
    } else if (evt.type === 'turn.completed') {
      const u = evt.usage as
        | {
            input_tokens?: number;
            cached_input_tokens?: number;
            output_tokens?: number;
            reasoning_output_tokens?: number;
          }
        | undefined;
      if (u) {
        usage = {
          model: CODEX_MODEL,
          input_tokens: u.input_tokens ?? 0,
          cached_input_tokens: u.cached_input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          reasoning_output_tokens: u.reasoning_output_tokens ?? 0,
          latency_ms: latencyMs,
        };
      }
    }
  }
  return { agentMessage, usage };
}

function extractJsonArray(raw: string): string | null {
  // Codex sometimes wraps output in ```json fences or a leading sentence.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

export interface CodexBatchOutput {
  results: Map<string, ClassificationResult>;
  usage: CodexUsage | null;
}

export async function classifyBatchWithCodex(
  candidates: LlmCandidate[],
  taxonomy: Taxonomy,
): Promise<CodexBatchOutput> {
  const out: CodexBatchOutput = { results: new Map(), usage: null };
  if (candidates.length === 0) return out;
  const prompt = buildBatchPrompt(candidates, taxonomy);
  let exec: CodexExecResult;
  try {
    exec = await runCodexExec(prompt);
  } catch (err) {
    log.warn('codex exec failed', { err: String(err) });
    return out;
  }
  out.usage = exec.usage;
  const json = extractJsonArray(exec.agentMessage);
  if (!json) {
    log.warn('codex output did not contain a JSON array', {
      preview: exec.agentMessage.slice(0, 200),
    });
    return out;
  }
  let parsed: AgentBatchResult[];
  try {
    parsed = JSON.parse(json) as AgentBatchResult[];
  } catch (err) {
    log.warn('codex output JSON parse failed', { err: String(err) });
    return out;
  }
  for (const r of parsed) {
    if (!r.email_id) continue;
    out.results.set(r.email_id, {
      needs_task: Boolean(r.needs_task),
      sort_folder: String(r.sort_folder || 'To Delete'),
      task_title: String(r.task_title || '').slice(0, 120),
      reasoning: String(r.reasoning || '').slice(0, 500),
    });
  }
  return out;
}
