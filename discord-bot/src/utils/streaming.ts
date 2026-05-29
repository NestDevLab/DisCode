export interface StreamingContentState {
    content: string;
    accumulatedContent?: string;
}

export interface StreamingContentResolution {
    shouldStream: boolean;
    displayContent: string;
}

export function resolveStreamingContent(
    incomingContent: string,
    currentStreaming: StreamingContentState | undefined,
    shouldStreamCandidate: boolean
): StreamingContentResolution {
    if (!shouldStreamCandidate || !currentStreaming) {
        return { shouldStream: false, displayContent: incomingContent };
    }

    const previousAccumulated = currentStreaming.accumulatedContent ?? currentStreaming.content;
    if (!previousAccumulated) {
        return { shouldStream: true, displayContent: incomingContent };
    }

    if (incomingContent.startsWith(previousAccumulated)) {
        const delta = incomingContent.slice(previousAccumulated.length);
        return { shouldStream: true, displayContent: `${currentStreaming.content}${delta}` };
    }

    if (previousAccumulated.startsWith(incomingContent)) {
        return { shouldStream: true, displayContent: currentStreaming.content };
    }

    return { shouldStream: false, displayContent: incomingContent };
}
