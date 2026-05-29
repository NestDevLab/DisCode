import { describe, expect, it } from 'vitest';
import { resolveStreamingContent } from '../../../src/utils/streaming';

describe('resolveStreamingContent', () => {
    it('appends only the delta when runner output is accumulated', () => {
        const resolved = resolveStreamingContent('hello world', {
            content: 'hello',
            accumulatedContent: 'hello'
        }, true);

        expect(resolved).toEqual({
            shouldStream: true,
            displayContent: 'hello world'
        });
    });

    it('starts a new message for unrelated stdout within the streaming window', () => {
        const resolved = resolveStreamingContent('agent response', {
            content: 'File saved for analysis: image.png',
            accumulatedContent: 'File saved for analysis: image.png'
        }, true);

        expect(resolved).toEqual({
            shouldStream: false,
            displayContent: 'agent response'
        });
    });

    it('keeps current content for stale accumulated updates', () => {
        const resolved = resolveStreamingContent('hello', {
            content: 'hello world',
            accumulatedContent: 'hello world'
        }, true);

        expect(resolved).toEqual({
            shouldStream: true,
            displayContent: 'hello world'
        });
    });
});
