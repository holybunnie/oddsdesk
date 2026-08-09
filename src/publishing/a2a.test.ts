import { describe, expect, it } from 'vitest';
import { A2aPublisherError, A2aSignalPublisher, type CommandResult } from './a2a.js';

function runnerFor(outputs: readonly CommandResult[]) {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  let index = 0;
  return {
    calls,
    runner: async (binary: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push({ binary, args });
      const output = outputs[index];
      index += 1;
      if (output === undefined) throw new Error('test runner ran out of outputs');
      return output;
    },
  };
}

const ok = (data: unknown): CommandResult => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });

describe('A2aSignalPublisher', () => {
  it('creates the P2P session and delivers to every active job', async () => {
    const fake = runnerFor([
      ok([{ jobId: 'job-1' }, { jobId: 'job-2' }]),
      ok({ list: [{ jobId: 'job-1', buyerAgentId: 'buyer-1' }, { jobId: 'job-2', buyerAgentId: 'buyer-2' }] }),
      ok({ sessionId: 's1' }),
      ok({ delivered: true }),
      ok({ sessionId: 's2' }),
      ok({ delivered: true }),
    ]);
    const publisher = new A2aSignalPublisher({ agentId: 'asp-9', runner: fake.runner });

    await publisher.publish('[Perpetual Signal] TEST-USDT-SWAP | LONG 1x');

    expect(fake.calls.map((call) => [call.binary, ...call.args])).toEqual([
      ['onchainos', 'agent', 'subscribe-active', '--agent-id', 'asp-9'],
      ['onchainos', 'agent', 'my-subscriptions', '--role', 'provider'],
      ['okx-a2a', 'session', 'create', '--job-id', 'job-1', '--my-agent-id', 'asp-9', '--to-agent-id', 'buyer-1', '--json'],
      ['onchainos', 'agent', 'deliver', 'job-1', '--deliverable-text', '[Perpetual Signal] TEST-USDT-SWAP | LONG 1x', '--agent-id', 'asp-9'],
      ['okx-a2a', 'session', 'create', '--job-id', 'job-2', '--my-agent-id', 'asp-9', '--to-agent-id', 'buyer-2', '--json'],
      ['onchainos', 'agent', 'deliver', 'job-2', '--deliverable-text', '[Perpetual Signal] TEST-USDT-SWAP | LONG 1x', '--agent-id', 'asp-9'],
    ]);
  });

  it('does not claim success when nobody would receive the signal', async () => {
    const fake = runnerFor([ok([]), ok({ list: [] })]);
    const publisher = new A2aSignalPublisher({ agentId: 'asp-9', runner: fake.runner });
    await expect(publisher.publish('signal')).rejects.toThrow(A2aPublisherError);
  });

  it('does not create the same session twice in one process', async () => {
    const fake = runnerFor([
      ok([{ jobId: 'job-1' }]), ok({ list: [{ jobId: 'job-1', buyerAgentId: 'buyer-1' }] }), ok({ sessionId: 's1' }), ok({ delivered: true }),
      ok([{ jobId: 'job-1' }]), ok({ list: [{ jobId: 'job-1', buyerAgentId: 'buyer-1' }] }), ok({ delivered: true }),
    ]);
    const publisher = new A2aSignalPublisher({ agentId: 'asp-9', runner: fake.runner });
    await publisher.publish('one');
    await publisher.publish('two');
    expect(fake.calls.filter((call) => call.binary === 'okx-a2a')).toHaveLength(1);
  });

  it('does not fail a stand-down status when there are no subscribers', async () => {
    const fake = runnerFor([ok([])]);
    const publisher = new A2aSignalPublisher({ agentId: 'asp-9', runner: fake.runner });
    await publisher.publishStatus('[Perpetual Status] regime unfavourable');
    expect(fake.calls).toHaveLength(1);
  });
});
