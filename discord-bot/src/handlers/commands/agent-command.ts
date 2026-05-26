/**
 * Agent Command Handler
 *
 * Sends raw command text to an active CLI session.
 */

import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createErrorEmbed } from '../../utils/embeds.js';
import type { Session } from '../../../../shared/types.js';

function formatCommandForEmbed(command: string): string {
    const sanitized = command.replace(/```/g, "'''");
    const truncated = sanitized.length > 900 ? sanitized.slice(0, 897) + '...' : sanitized;
    return '```text\n' + truncated + '\n```';
}

function isRawCommandCapable(session: Session): boolean {
    return session.plugin === 'tmux';
}

function unsupportedCommandDescription(session: Session, command: string): string {
    const plugin = session.plugin || session.cliType;
    if (command.startsWith('/')) {
        return `This session uses \`${plugin}\`, so \`${command}\` would be sent as a normal prompt, not interpreted as a CLI slash command. Raw slash commands are only supported for tmux/TUI sessions.`;
    }

    return `This session uses \`${plugin}\`. Raw command input is only supported for tmux/TUI sessions.`;
}

function resolveActiveSession(interaction: ChatInputCommandInteraction): Session | undefined {
    const sessionIdOption = interaction.options.getString('session');
    if (sessionIdOption) {
        const session = storage.getSession(sessionIdOption);
        return session?.status === 'active' ? session : undefined;
    }

    const allSessions = Object.values(storage.data.sessions);
    return allSessions.find(s => s.threadId === interaction.channelId && s.status === 'active');
}

export async function handleAgentCommand(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const command = interaction.options.getString('command', true).trim();
    const sessionIdOption = interaction.options.getString('session');

    if (!command) {
        await interaction.reply({
            embeds: [createErrorEmbed('Command Required', 'Provide command text to send to the agent.')],
            flags: 64
        });
        return;
    }

    const session = resolveActiveSession(interaction);
    if (!session) {
        await interaction.reply({
            embeds: [createErrorEmbed(
                'Session Not Found',
                sessionIdOption
                    ? `No active session found with ID: ${sessionIdOption}`
                    : 'No active session found in this thread. Use `/agent-command session:<id>` to specify one.'
            )],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', 'You do not have access to this session.')],
            flags: 64
        });
        return;
    }

    if (!isRawCommandCapable(session)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Raw Command Unsupported', unsupportedCommandDescription(session, command))],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(session.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'The runner is not connected.')],
            flags: 64
        });
        return;
    }

    ws.send(JSON.stringify({
        type: 'user_message',
        data: {
            sessionId: session.sessionId,
            userId,
            username: interaction.user.username,
            content: command,
            timestamp: new Date().toISOString()
        }
    }));

    const embed = new EmbedBuilder()
        .setColor(0x4C9AFF)
        .setTitle('Agent Command Sent')
        .setDescription('Raw command text was sent to the active CLI session.')
        .addFields(
            { name: 'Session', value: session.sessionId.slice(0, 8), inline: true },
            { name: 'Runner', value: runner.name, inline: true },
            { name: 'Command', value: formatCommandForEmbed(command), inline: false }
        )
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}
