import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function loadHandler(tempRoot: string) {
    vi.resetModules();
    process.env.DISCODE_ATTACHMENT_TMP_DIR = tempRoot;
    return import('../../../src/handlers/message');
}

describe('handleUserMessage attachments', () => {
    let tempRoot: string;

    beforeEach(async () => {
        tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'discode-attachments-test-'));
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        delete process.env.DISCODE_ATTACHMENT_TMP_DIR;
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    });

    it('downloads Discord file attachments on the runner and includes local paths in the prompt', async () => {
        const { handleUserMessage } = await loadHandler(tempRoot);
        const fileBytes = new TextEncoder().encode('file contents');
        const sendMessage = vi.fn(async () => undefined);
        const wsSend = vi.fn();

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            statusText: 'OK',
            arrayBuffer: async () => fileBytes.buffer
        })));

        await handleUserMessage({
            sessionId: 'session/one',
            userId: 'user-1',
            username: 'Joseph',
            content: 'Please inspect this file.',
            attachments: [{
                name: '../report final.pdf',
                url: 'https://cdn.discordapp.example/report.pdf',
                contentType: 'application/pdf',
                size: fileBytes.byteLength
            }],
            timestamp: new Date().toISOString()
        }, {
            wsManager: { runnerId: 'runner-1', send: wsSend } as any,
            pluginManager: null,
            cliSessions: new Map([[ 'session/one', {
                sessionId: 'session/one',
                status: 'ready',
                isReady: true,
                sendMessage,
                once: vi.fn()
            } as any ]]),
            sessionMetadata: new Map()
        });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const prompt = sendMessage.mock.calls[0][0] as string;
        expect(prompt).toContain('Please inspect this file.');
        expect(prompt).toContain('Attached file(s) were downloaded on the runner');
        expect(prompt).toContain('report_final.pdf');
        expect(prompt).toContain(tempRoot);

        const savedPathMatch = prompt.match(/: (\/[^\n]+report_final\.pdf)/);
        expect(savedPathMatch).not.toBeNull();
        expect(await fs.promises.readFile(savedPathMatch![1], 'utf8')).toBe('file contents');
        expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'output' }));
    });
});
