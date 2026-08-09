/**
 * SignalPublisher backed by the documented OKX.AI A2A CLI seam.
 *
 * The strategy remains TypeScript and the delivery daemon remains external.
 * This adapter is the narrow boundary: it discovers active provider jobs,
 * creates the A2A session required by a new subscriber, and waits for every
 * `onchainos agent deliver` call to succeed before the engine executes an
 * entry. It uses execFile, never a shell, so signal text cannot become command
 * syntax.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { SignalPublisher } from '../engine/loop.js';

const execFile = promisify(execFileCallback);

export class A2aPublisherError extends Error {
  override readonly name = 'A2aPublisherError';
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (binary: string, args: readonly string[]) => Promise<CommandResult>;

export interface A2aSignalPublisherOptions {
  readonly agentId: string;
  readonly onchainosBinary?: string;
  readonly a2aBinary?: string;
  readonly runner?: CommandRunner;
  /** Fail closed when no subscriber would receive the signal. */
  readonly requireActiveSubscribers?: boolean;
}

interface ActiveJob {
  readonly jobId: string;
}

interface ProviderSubscription {
  readonly jobId: string;
  readonly buyerAgentId?: string;
}

const defaultRunner: CommandRunner = async (binary, args) => {
  try {
    const result = await execFile(binary, [...args], { encoding: 'utf8' });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : String(failure.message ?? error),
    };
  }
};

function jsonOutput(result: CommandResult, command: string): unknown {
  if (result.exitCode !== 0) {
    throw new A2aPublisherError(`${command} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new A2aPublisherError(`${command} did not return JSON`, { cause });
  }
}

function assertOk(value: unknown, command: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new A2aPublisherError(`${command} returned a non-object`);
  const row = value as Record<string, unknown>;
  if (row.ok === false) throw new A2aPublisherError(`${command} returned ok=false: ${JSON.stringify(row)}`);
  return row;
}

function activeJobs(value: unknown): readonly ActiveJob[] {
  const row = assertOk(value, 'onchainos agent subscribe-active');
  if (!Array.isArray(row.data)) throw new A2aPublisherError('subscribe-active returned no data array');
  return row.data.map((item, index) => {
    const jobId = typeof item === 'string' ? item : (item as Record<string, unknown>)?.jobId;
    if (typeof jobId !== 'string' || jobId === '') throw new A2aPublisherError(`active job ${index} has no jobId`);
    return { jobId };
  });
}

function providerSubscriptions(value: unknown): readonly ProviderSubscription[] {
  const row = assertOk(value, 'onchainos agent my-subscriptions');
  const data = row.data as Record<string, unknown> | undefined;
  const list = data?.list;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new A2aPublisherError('provider subscription list is not an array');
  return list.flatMap((item) => {
    const row = item as Record<string, unknown>;
    if (typeof row.jobId !== 'string' || row.jobId === '') return [];
    return [{
      jobId: row.jobId,
      ...(typeof row.buyerAgentId === 'string' ? { buyerAgentId: row.buyerAgentId } : {}),
    }];
  });
}

export class A2aSignalPublisher implements SignalPublisher {
  readonly #agentId: string;
  readonly #onchainos: string;
  readonly #a2a: string;
  readonly #run: CommandRunner;
  readonly #requireActiveSubscribers: boolean;
  readonly #sessions = new Set<string>();

  constructor(options: A2aSignalPublisherOptions) {
    if (options.agentId.trim() === '') throw new A2aPublisherError('ASP agent id is required');
    this.#agentId = options.agentId;
    this.#onchainos = options.onchainosBinary ?? 'onchainos';
    this.#a2a = options.a2aBinary ?? 'okx-a2a';
    this.#run = options.runner ?? defaultRunner;
    this.#requireActiveSubscribers = options.requireActiveSubscribers ?? true;
  }

  async publish(text: string): Promise<void> {
    if (text.trim() === '') throw new A2aPublisherError('cannot deliver an empty signal');

    await this.#deliver(text, this.#requireActiveSubscribers);
  }

  async publishStatus(text: string): Promise<void> {
    if (text.trim() === '') throw new A2aPublisherError('cannot deliver an empty status');

    // A status update is useful only when a subscriber is present, but an
    // empty subscriber set is normal during an idle period and must not turn
    // a healthy engine cycle into an error.
    await this.#deliver(text, false);
  }

  async #deliver(text: string, requireActiveSubscribers: boolean): Promise<void> {

    const activeResult = await this.#run(this.#onchainos, [
      'agent', 'subscribe-active', '--agent-id', this.#agentId,
    ]);
    const active = activeJobs(jsonOutput(activeResult, 'onchainos agent subscribe-active'));
    if (active.length === 0) {
      if (requireActiveSubscribers) {
        throw new A2aPublisherError('no active subscribers would receive the signal');
      }
      return;
    }

    const providerResult = await this.#run(this.#onchainos, [
      'agent', 'my-subscriptions', '--role', 'provider',
    ]);
    const subscriptions = providerSubscriptions(jsonOutput(providerResult, 'onchainos agent my-subscriptions'));
    const buyerByJob = new Map(subscriptions.map((subscription) => [subscription.jobId, subscription.buyerAgentId]));

    for (const { jobId } of active) {
      const buyerAgentId = buyerByJob.get(jobId);
      if (buyerAgentId !== undefined && !this.#sessions.has(jobId)) {
        const session = await this.#run(this.#a2a, [
          'session', 'create',
          '--job-id', jobId,
          '--my-agent-id', this.#agentId,
          '--to-agent-id', buyerAgentId,
          '--json',
        ]);
        // Session creation is idempotent in the reference flow. Treat an
        // explicit already-exists response as success, but fail on anything
        // else so delivery cannot appear healthy while P2P is disconnected.
        const sessionText = `${session.stdout} ${session.stderr}`.toLowerCase();
        if (session.exitCode !== 0 && !sessionText.includes('already')) {
          throw new A2aPublisherError(`okx-a2a session create failed for ${jobId}: ${sessionText}`);
        }
        this.#sessions.add(jobId);
      }

      const delivery = await this.#run(this.#onchainos, [
        'agent', 'deliver', jobId,
        '--deliverable-text', text,
        '--agent-id', this.#agentId,
      ]);
      if (delivery.exitCode !== 0) {
        throw new A2aPublisherError(`signal delivery failed for ${jobId}: ${delivery.stderr || delivery.stdout}`);
      }
      if (delivery.stdout.trim() !== '') assertOk(JSON.parse(delivery.stdout), `onchainos agent deliver ${jobId}`);
    }
  }
}
