import { describe, expect, it } from 'vitest';
import { mayRestorePending, requireSaveResult } from '@/lib/workspace-sync';

describe('workspace save safety', () => {
  it('restores pending work only for the same signed-in account', () => {
    expect(mayRestorePending({ userId: 'gabriel', base: {} }, 'gabriel')).toBe(true);
    expect(mayRestorePending({ userId: 'gabriel', base: {} }, 'otro')).toBe(false);
    expect(mayRestorePending(null, 'gabriel')).toBe(false);
  });
  it('rejects permission errors rather than retrying them as version conflicts', () => {
    expect(() => requireSaveResult({ message: 'permission denied' }, null)).toThrow('permission denied');
    expect(requireSaveResult(null, null)).toBeNull();
    expect(requireSaveResult(null, 14)).toBe(14);
  });
});