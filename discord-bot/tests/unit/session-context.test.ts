import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { storage } from '../../src/storage';
import { getReusableSessionThreadIdFromContext, hasActiveSessionInThread } from '../../src/handlers/session-context';

vi.mock('../../src/services/category-manager', () => ({
  getCategoryManager: () => ({
    getProjectByChannelId: (channelId: string) => (
      channelId === 'project-channel'
        ? { runnerId: 'runner-1', projectPath: '/workspace/project', project: { channelId, projectPath: '/workspace/project' } }
        : null
    )
  })
}));

vi.mock('../../src/services/session-sync', () => ({
  getSessionSyncService: () => ({
    getSessionByThreadId: () => null
  })
}));

describe('session context thread reuse', () => {
  beforeEach(() => {
    vi.spyOn(storage, 'getSessionsByThreadId').mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function interactionForProjectThread(threadId = 'thread-1') {
    const parent = { id: 'project-channel' };
    const thread = {
      id: threadId,
      parentId: parent.id,
      parent,
      isThread: () => true
    };
    return {
      channel: thread,
      channelId: thread.id,
      client: {
        channels: {
          fetch: vi.fn(async (id: string) => id === parent.id ? parent : thread)
        }
      }
    };
  }

  it('treats a thread with only ended sessions as reusable', async () => {
    vi.mocked(storage.getSessionsByThreadId).mockReturnValue([
      { sessionId: 'old-session', threadId: 'thread-1', status: 'ended', createdAt: new Date().toISOString() } as any
    ]);

    expect(hasActiveSessionInThread('thread-1')).toBe(false);
    await expect(getReusableSessionThreadIdFromContext(interactionForProjectThread())).resolves.toBe('thread-1');
  });

  it('does not reuse a thread with an active session', async () => {
    vi.mocked(storage.getSessionsByThreadId).mockReturnValue([
      { sessionId: 'active-session', threadId: 'thread-1', status: 'active', createdAt: new Date().toISOString() } as any
    ]);

    expect(hasActiveSessionInThread('thread-1')).toBe(true);
    await expect(getReusableSessionThreadIdFromContext(interactionForProjectThread())).resolves.toBeUndefined();
  });
});
