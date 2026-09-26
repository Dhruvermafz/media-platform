import { backoffMs, streamKeyFor, consumerGroupFor, dlqStreamKeyFor, consumerNameFor, RETRY_BASE_DELAY_MS } from '../src/queue';
import { WorkerKind } from '../src/enums';

describe('backoffMs', () => {
  it('follows the documented exponential sequence: 1s, 2s, 4s...', () => {
    expect(backoffMs(1)).toBe(RETRY_BASE_DELAY_MS * 1);
    expect(backoffMs(2)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(backoffMs(3)).toBe(RETRY_BASE_DELAY_MS * 4);
  });

  it('strictly increases with attempt number', () => {
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2));
  });
});

describe('stream naming', () => {
  it('namespaces streams, groups, and DLQs distinctly per worker kind', () => {
    const image = streamKeyFor(WorkerKind.IMAGE);
    const video = streamKeyFor(WorkerKind.VIDEO);
    expect(image).not.toBe(video);
    expect(image).toContain(WorkerKind.IMAGE);
  });

  it('DLQ stream key is distinct from the main job stream for the same worker', () => {
    expect(streamKeyFor(WorkerKind.VIDEO)).not.toBe(dlqStreamKeyFor(WorkerKind.VIDEO));
  });

  it('consumer group name is stable for a given worker kind', () => {
    expect(consumerGroupFor(WorkerKind.THUMBNAIL)).toBe(consumerGroupFor(WorkerKind.THUMBNAIL));
  });

  it('consumer names differ per replica of the same worker kind', () => {
    const a = consumerNameFor(WorkerKind.IMAGE, 'replica-a');
    const b = consumerNameFor(WorkerKind.IMAGE, 'replica-b');
    expect(a).not.toBe(b);
  });
});
