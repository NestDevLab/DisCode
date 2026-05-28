/**
 * User Message Handler
 *
 * Handles user_message WebSocket messages.
 */

import type { PluginManager, PluginSession } from '../plugins/index.js';
import type { SessionMetadata } from '../types.js';
import type { WebSocketManager } from '../websocket.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Image MIME types that can be sent to vision-capable CLIs
const IMAGE_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp'
];

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_TMP_ROOT = process.env.DISCODE_ATTACHMENT_TMP_DIR || path.join(os.tmpdir(), 'discode-attachments');
const configuredMaxAttachmentBytes = Number.parseInt(process.env.DISCODE_MAX_ATTACHMENT_BYTES || '', 10);
const MAX_ATTACHMENT_BYTES = Number.isFinite(configuredMaxAttachmentBytes) && configuredMaxAttachmentBytes > 0
    ? configuredMaxAttachmentBytes
    : DEFAULT_MAX_ATTACHMENT_BYTES;

// Attachment type from Discord bot
interface Attachment {
    name: string;
    url: string;
    contentType?: string;
    size: number;
}

interface SavedAttachment {
    name: string;
    filePath: string;
    contentType?: string;
    size: number;
}

export interface MessageHandlerDeps {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    cliSessions: Map<string, PluginSession>;
    sessionMetadata: Map<string, SessionMetadata>;
}

async function waitForSession(
    cliSessions: Map<string, PluginSession>,
    sessionId: string,
    timeoutMs = 10000,
    intervalMs = 250
): Promise<PluginSession | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const session = cliSessions.get(sessionId);
        if (session) return session;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return cliSessions.get(sessionId) || null;
}

/**
 * Check if an attachment is an image
 */
function isImageAttachment(att: Attachment): boolean {
    return IMAGE_MIME_TYPES.includes(att.contentType || '');
}

/**
 * Download an attachment and convert to base64
 */
async function downloadAsBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
}

function safeAttachmentName(name: string, index: number): string {
    const base = path.basename(name || `attachment-${index + 1}`);
    const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
    return cleaned || `attachment-${index + 1}`;
}

async function createAttachmentTempDir(sessionId: string): Promise<string> {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'session';
    await fs.promises.mkdir(ATTACHMENT_TMP_ROOT, { recursive: true });
    return fs.promises.mkdtemp(path.join(ATTACHMENT_TMP_ROOT, `${safeSessionId}-`));
}

async function downloadAttachmentToFile(att: Attachment, targetDir: string, index: number): Promise<SavedAttachment> {
    if (att.size && att.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment is ${att.size} bytes, max is ${MAX_ATTACHMENT_BYTES}`);
    }

    const filePath = path.join(targetDir, safeAttachmentName(att.name, index));
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Failed to fetch ${att.url}: ${res.statusText}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`downloaded attachment is ${buffer.length} bytes, max is ${MAX_ATTACHMENT_BYTES}`);
    }

    await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });
    return {
        name: att.name,
        filePath,
        contentType: att.contentType,
        size: buffer.length
    };
}

function appendAttachmentPaths(content: string, savedAttachments: SavedAttachment[]): string {
    if (savedAttachments.length === 0) return content;

    const intro = content.trim() || 'Please analyze the attached file(s).';
    const fileList = savedAttachments
        .map((att, index) => {
            const details = [att.contentType, `${att.size} bytes`].filter(Boolean).join(', ');
            return `${index + 1}. ${att.name}: ${att.filePath}${details ? ` (${details})` : ''}`;
        })
        .join('\n');

    return `${intro}\n\nAttached file(s) were downloaded on the runner. Use these local paths when analyzing them:\n${fileList}`;
}

export async function handleUserMessage(
    data: {
        sessionId: string;
        userId: string;
        username: string;
        content: string;
        attachments?: Attachment[];
        timestamp: string;
    },
    deps: MessageHandlerDeps
): Promise<void> {
    const { wsManager, pluginManager, cliSessions, sessionMetadata } = deps;

    console.log(`[UserMessage] Received from ${data.username} for session ${data.sessionId}`);

    // Get CLI session
    let session = cliSessions.get(data.sessionId);

    // Auto-recovery: If session not found but exists in tmux, restore it
    if (!session && pluginManager) {
        const tmuxPlugin = pluginManager.getPlugin('tmux');
        if (tmuxPlugin && tmuxPlugin.listSessions && tmuxPlugin.watchSession) {
            try {
                const existingSessions = await tmuxPlugin.listSessions();
                if (existingSessions.includes(data.sessionId)) {
                    session = await tmuxPlugin.watchSession(data.sessionId);

                    // Register it
                    cliSessions.set(data.sessionId, session);
                    sessionMetadata.set(data.sessionId, {
                        sessionId: data.sessionId,
                        cliType: 'claude', // Default
                        runnerId: wsManager.runnerId,
                        folderPath: 'recovered'
                    });
                }
            } catch (e) {
                console.error(`[Auto-Recovery] Failed to recover session ${data.sessionId}:`, e);
            }
        }
    }

    if (!session) {
        console.log(`[UserMessage] Session ${data.sessionId} not found yet, waiting for startup...`);
        session = await waitForSession(cliSessions, data.sessionId);
    }

    if (!session) {
        console.error(`Session ${data.sessionId} not found in CLI sessions`);
        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `❌ Error: Session '${data.sessionId}' not found. It may have been closed or the runner was restarted without recovery. Try /watch again.`,
                timestamp: new Date().toISOString(),
                outputType: 'error'
            }
        });
        return;
    }

    // Separate image and non-image attachments
    const imageAttachments: Attachment[] = [];
    const fileAttachments: Attachment[] = [];

    if (data.attachments && data.attachments.length > 0) {
        for (const att of data.attachments) {
            if (isImageAttachment(att)) {
                imageAttachments.push(att);
            } else {
                fileAttachments.push(att);
            }
        }
    }

    const savedAttachments: SavedAttachment[] = [];
    if (data.attachments && data.attachments.length > 0) {
        let tempDir: string | null = null;
        for (const [index, att] of data.attachments.entries()) {
            try {
                if (!tempDir) tempDir = await createAttachmentTempDir(data.sessionId);
                const saved = await downloadAttachmentToFile(att, tempDir, index);
                savedAttachments.push(saved);
                console.log(`[UserMessage] Downloaded attachment ${att.name} to ${saved.filePath}`);

                wsManager.send({
                    type: 'output',
                    data: {
                        runnerId: wsManager.runnerId,
                        sessionId: data.sessionId,
                        content: `📁 File saved for analysis: ${saved.name}`,
                        timestamp: new Date().toISOString(),
                        outputType: 'stdout'
                    }
                });
            } catch (err) {
                console.error(`Failed to save attachment ${att.name}:`, err);
                wsManager.send({
                    type: 'output',
                    data: {
                        runnerId: wsManager.runnerId,
                        sessionId: data.sessionId,
                        content: `❌ Error downloading file '${att.name}': ${err}`,
                        timestamp: new Date().toISOString(),
                        outputType: 'error'
                    }
                });
            }
        }
    }

    const promptContent = appendAttachmentPaths(data.content, savedAttachments);
    const savedImageAttachments = savedAttachments.filter(att => IMAGE_MIME_TYPES.includes(att.contentType || ''));

    const sendMessage = async () => {
        try {
            if (savedImageAttachments.length > 0 && session!.sendMessageWithLocalImages) {
                const localImages = savedImageAttachments.map(att => ({
                    path: att.filePath,
                    mediaType: att.contentType || 'image/png'
                }));
                console.log(`[UserMessage] Sending ${localImages.length} local image(s) with text to CLI`);
                await session!.sendMessageWithLocalImages!(promptContent, localImages);
                console.log(`[UserMessage] Message with ${localImages.length} local image(s) sent successfully to session ${data.sessionId}`);
            } else if (imageAttachments.length > 0 && session!.sendMessageWithImages) {
                console.log(`[UserMessage] Sending ${imageAttachments.length} image(s) with text to CLI`);

                const images: Array<{ data: string; mediaType: string }> = [];
                for (const att of imageAttachments) {
                    try {
                        const base64Data = await downloadAsBase64(att.url);
                        images.push({
                            data: base64Data,
                            mediaType: att.contentType || 'image/png'
                        });
                        console.log(`[UserMessage] Downloaded image ${att.name} (${base64Data.length} bytes base64)`);
                    } catch (err) {
                        console.error(`Failed to download image ${att.name}:`, err);
                        wsManager.send({
                            type: 'output',
                            data: {
                                runnerId: wsManager.runnerId,
                                sessionId: data.sessionId,
                                content: `⚠️ Could not load image '${att.name}': ${err}`,
                                timestamp: new Date().toISOString(),
                                outputType: 'stderr'
                            }
                        });
                    }
                }

                if (images.length > 0) {
                    await session!.sendMessageWithImages!(promptContent, images);
                    console.log(`[UserMessage] Message with ${images.length} image(s) sent successfully to session ${data.sessionId}`);
                } else {
                    // All images failed to download, send text only
                    await session!.sendMessage(promptContent);
                }
            } else {
                // No images or session doesn't support images
                if (imageAttachments.length > 0) {
                    console.log(`[UserMessage] Session does not support images, sending text only (${imageAttachments.length} images ignored)`);
                }
                console.log(`[UserMessage] Sending to CLI: ${promptContent.slice(0, 50)}...`);
                await session!.sendMessage(promptContent);
                console.log(`[UserMessage] Message sent successfully to session ${data.sessionId}`);
            }
        } catch (error) {
            console.error(`[UserMessage] Error sending message to CLI:`, error);
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: `❌ Error: ${error}`,
                    timestamp: new Date().toISOString(),
                    outputType: 'stderr'
                }
            });
        }
    };

    console.log(`[UserMessage] Session ${data.sessionId} isReady=${session.isReady}, status=${session.status || 'unknown'}`);

    if (session.isReady) {
        await sendMessage();
    } else {
        console.log(`[UserMessage] Session ${data.sessionId} not ready, waiting for 'ready' event...`);

        // Set a timeout - if session doesn't become ready in 30s, send anyway with warning
        const readyTimeout = setTimeout(() => {
            console.warn(`[UserMessage] Session ${data.sessionId} ready timeout, attempting to send anyway...`);
            wsManager.send({
                type: 'output',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId,
                    content: `⚠️ Session was not ready after 30s, attempting to send message anyway...`,
                    timestamp: new Date().toISOString(),
                    outputType: 'stderr'
                }
            });
            sendMessage();
        }, 30000);

        session.once('ready', () => {
            clearTimeout(readyTimeout);
            console.log(`[UserMessage] Session ${data.sessionId} is now ready, sending message...`);
            sendMessage();
        });
    }
}
