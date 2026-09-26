import { EventsService } from './events.service';

function build() {
  const redis: any = { client: { del: jest.fn().mockResolvedValue(1), publish: jest.fn().mockResolvedValue(1) } };
  const svc = new EventsService({ get: () => 'redis://x' } as any, redis);
  return { svc, redis, dispatch: (ch: string, msg: string) => (svc as any).dispatch(ch, msg) };
}
const env = (event: any) => JSON.stringify({ id: 'e1', ts: 't', event });

describe('EventsService', () => {
  it('delivers an event only to the owning user\'s listeners', async () => {
    const { svc, dispatch } = build();
    const mine = jest.fn(); const theirs = jest.fn();
    svc.subscribe('u1', mine); svc.subscribe('u2', theirs);
    await dispatch('events:user:u1', env({ type: 'asset.created', assetId: 'a1' }));
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and cleans up empty sets (no leak per closed tab)', async () => {
    const { svc, dispatch } = build();
    const l = jest.fn();
    const off = svc.subscribe('u1', l);
    expect(svc.connectionCount()).toBe(1);
    off();
    expect(svc.connectionCount()).toBe(0);
    await dispatch('events:user:u1', env({ type: 'asset.created', assetId: 'a1' }));
    expect(l).not.toHaveBeenCalled();
  });

  it('invalidates the cached asset detail when a worker reports progress', async () => {
    const { svc, redis, dispatch } = build();
    svc.subscribe('u1', jest.fn());
    await dispatch('events:user:u1', env({ type: 'job.updated', assetId: 'a9', jobId: 'j', jobType: 'X', status: 'COMPLETED' }));
    expect(redis.client.del).toHaveBeenCalledWith('asset:a9');
  });

  it('ignores malformed payloads and one listener throwing must not affect others', async () => {
    const { svc, dispatch } = build();
    const bad = jest.fn(() => { throw new Error('boom'); }); const good = jest.fn();
    svc.subscribe('u1', bad); svc.subscribe('u1', good);
    await dispatch('events:user:u1', 'not json');
    expect(good).not.toHaveBeenCalled();
    await dispatch('events:user:u1', env({ type: 'library.changed', scope: 'tags' }));
    expect(good).toHaveBeenCalledTimes(1);
  });
});
