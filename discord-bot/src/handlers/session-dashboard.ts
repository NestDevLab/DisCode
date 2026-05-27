/**
 * Live Session Dashboard
 *
 * Contextual /dashboard view for an already-running session thread.
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { createErrorEmbed } from '../utils/embeds.js';
import { getSessionSyncService } from '../services/session-sync.js';
import { attachSyncedSessionControl } from '../services/synced-session-control.js';
import { projectSettingsStore } from '../services/project-settings.js';
import type { ProjectConfig, RunnerInfo, Session } from '../../../shared/types.js';

type ApprovalMode = 'manual' | 'autoSafe' | 'auto';
type EditMode = 'default' | 'acceptEdits';
type ThinkingLevel = 'default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh';
type SettingSource = 'Live override' | 'Project override' | 'DisCode default' | 'Session option' | 'Runtime fallback' | 'Not forced' | 'Unsupported';
type SessionControlAction =
    | 'set_model'
    | 'set_permission_mode'
    | 'set_approval_mode'
    | 'set_max_thinking_tokens'
    | 'set_thinking_level';
type LiveSessionCommand = 'plan' | 'goal';

function getActiveSessionForThread(threadId: string): Session | null {
    return storage.getSessionsByThreadId(threadId).find(s => s.status === 'active') || null;
}

export function getDashboardSessionFromInteraction(interaction: any): Session | null {
    return getActiveSessionForThread(interaction.channelId);
}

export async function resolveDashboardSessionFromInteraction(
    interaction: any,
    userId: string
): Promise<{ session: Session | null; error?: string }> {
    const directSession = getDashboardSessionFromInteraction(interaction);
    if (directSession) return { session: directSession };

    const sessionSync = getSessionSyncService();
    const syncEntry = sessionSync?.getSessionByThreadId(interaction.channelId);
    if (!syncEntry) return { session: null };

    const attachResult = await attachSyncedSessionControl({
        threadId: interaction.channelId,
        userId,
        expectApprovalReplay: false
    });

    if (!attachResult.ok || !attachResult.sessionId) {
        if (attachResult.reason === 'access_denied') return { session: null, error: 'You do not have access to this synced session.' };
        if (attachResult.reason === 'runner_offline') return { session: null, error: 'Runner is offline. Bring it online, then try again.' };
        if (attachResult.reason === 'runner_unavailable') return { session: null, error: 'Runner connection is unavailable. Please try again in a moment.' };
        return { session: null, error: 'This synced session cannot be attached for live control right now.' };
    }

    return { session: storage.getSession(attachResult.sessionId) };
}

function getSessionOptions(session: Session): Record<string, any> {
    return { ...((session.options || {}) as Record<string, any>) };
}

function getLiveOverrides(options: Record<string, any>): Record<string, boolean> {
    return options._liveOverrides && typeof options._liveOverrides === 'object' ? options._liveOverrides : {};
}

function markLiveOverride(options: Record<string, any>, key: string): void {
    options._liveOverrides = {
        ...getLiveOverrides(options),
        [key]: true
    };
}

function hasOwn(obj: Record<string, any> | undefined, key: string): boolean {
    return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function getCliDefaults(runner: RunnerInfo, session: Session): Record<string, any> {
    if (session.plugin === 'codex-sdk' || session.cliType === 'codex') return runner.config?.codexDefaults || {};
    if (session.plugin === 'gemini-sdk' || session.cliType === 'gemini') return runner.config?.geminiDefaults || {};
    return runner.config?.claudeDefaults || {};
}

function resolveApprovalMode(options: Record<string, any>): ApprovalMode {
    if (options.approvalMode === 'manual' || options.approvalMode === 'autoSafe' || options.approvalMode === 'auto') {
        return options.approvalMode;
    }
    if (options.skipPermissions === true || options.approvalPolicy === 'never') return 'auto';
    if (options.autoApproveSafe === true) return 'autoSafe';
    return 'manual';
}

function resolveEditMode(options: Record<string, any>): EditMode {
    return options.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default';
}

function resolveThinkingLevel(session: Session, options: Record<string, any>): ThinkingLevel {
    if (session.plugin === 'codex-sdk') {
        const effort = options.reasoningEffort;
        if (effort === 'none') return 'off';
        if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort;
    }

    const level = options.thinkingLevel;
    if (level === 'off' || level === 'low' || level === 'medium' || level === 'high') return level;
    return 'default';
}

function thinkingLabel(level: ThinkingLevel): string {
    if (level === 'default') return 'Default';
    if (level === 'xhigh') return 'XHigh';
    return level.toUpperCase();
}

function settingValue(value: string, source: SettingSource): string {
    return `${value} · ${source}`;
}

function sourceForModel(
    value: string | undefined,
    options: Record<string, any>,
    projectConfig: ProjectConfig,
    cliDefaults: Record<string, any>
): SettingSource {
    if (!value) return 'Not forced';
    const live = getLiveOverrides(options);
    if (live.model) return 'Live override';
    if (projectConfig.model === value || projectConfig.claudeDefaults?.model === value || projectConfig.codexDefaults?.model === value || projectConfig.geminiDefaults?.model === value) return 'Project override';
    if (cliDefaults.model === value) return 'DisCode default';
    return 'Session option';
}

function sourceForApproval(
    options: Record<string, any>,
    projectConfig: ProjectConfig,
    runner: RunnerInfo,
    cliDefaults: Record<string, any>
): SettingSource {
    const live = getLiveOverrides(options);
    if (live.approval) return 'Live override';
    if (projectConfig.permissionMode || projectConfig.claudeDefaults?.permissionMode || projectConfig.codexDefaults?.approvalPolicy || projectConfig.geminiDefaults?.approvalMode) return 'Project override';
    if (runner.config?.yoloMode || cliDefaults.permissionMode || cliDefaults.approvalPolicy || cliDefaults.approvalMode) return 'DisCode default';
    return 'Runtime fallback';
}

function sourceForEdit(
    options: Record<string, any>,
    projectConfig: ProjectConfig,
    cliDefaults: Record<string, any>
): SettingSource {
    const live = getLiveOverrides(options);
    if (live.edit) return 'Live override';
    if (projectConfig.editAcceptMode || projectConfig.claudeDefaults?.editAcceptMode) return 'Project override';
    if (cliDefaults.editAcceptMode) return 'DisCode default';
    return 'Runtime fallback';
}

function sourceForThinking(
    session: Session,
    options: Record<string, any>,
    projectConfig: ProjectConfig,
    runner: RunnerInfo,
    cliDefaults: Record<string, any>
): SettingSource {
    if (controlUnsupportedReason(session, 'thinking')) return 'Unsupported';
    const live = getLiveOverrides(options);
    if (live.thinking) return 'Live override';

    const hasCodexEffort = hasOwn(options, 'reasoningEffort');
    const hasClaudeThinking = hasOwn(options, 'thinkingLevel');
    if (options.thinkingLevel === 'default_on' || options.thinkingLevel === 'auto') return 'Not forced';
    if (!hasCodexEffort && !hasClaudeThinking) return 'Not forced';

    if (
        projectConfig.thinkingLevel ||
        projectConfig.claudeDefaults?.thinkingLevel ||
        projectConfig.codexDefaults?.reasoningEffort ||
        projectConfig.geminiDefaults?.thinkingLevel
    ) {
        return 'Project override';
    }

    if (runner.config?.thinkingLevel && runner.config.thinkingLevel !== 'default_on') return 'DisCode default';
    if (cliDefaults.thinkingLevel || cliDefaults.reasoningEffort) return 'DisCode default';
    return 'Session option';
}

function sourceForMaxThinking(
    options: Record<string, any>,
    projectConfig: ProjectConfig,
    cliDefaults: Record<string, any>
): SettingSource {
    if (!hasOwn(options, 'maxThinkingTokens')) return 'Not forced';
    const live = getLiveOverrides(options);
    if (live.maxThinking) return 'Live override';
    if (projectConfig.maxThinkingTokens || projectConfig.claudeDefaults?.maxThinkingTokens) return 'Project override';
    if (cliDefaults.maxThinkingTokens) return 'DisCode default';
    return 'Session option';
}

function thinkingOptionsForSession(session: Session): Array<{ label: string; value: ThinkingLevel; description: string }> {
    const common = [
        { label: 'Default', value: 'default' as const, description: 'Use the agent default.' },
        { label: 'Off', value: 'off' as const, description: 'Disable reasoning/thinking where supported.' },
        { label: 'Low', value: 'low' as const, description: 'Lower reasoning budget.' },
        { label: 'Medium', value: 'medium' as const, description: 'Balanced reasoning budget.' },
        { label: 'High', value: 'high' as const, description: 'Higher reasoning budget.' }
    ];

    if (session.plugin === 'codex-sdk') {
        return [
            ...common,
            { label: 'XHigh', value: 'xhigh' as const, description: 'Maximum Codex reasoning effort.' }
        ];
    }

    if (session.plugin === 'claude-sdk') return common;

    return [
        { label: 'Not supported', value: 'default' as const, description: 'This agent cannot change thinking level live.' }
    ];
}

function approvalLabel(mode: ApprovalMode): string {
    if (mode === 'auto') return 'YOLO';
    if (mode === 'autoSafe') return 'Auto-Safe';
    return 'Manual';
}

function editLabel(mode: EditMode): string {
    return mode === 'acceptEdits' ? 'Accept Edits' : 'Default';
}

function statusLabel(session: Session): string {
    const currentStatus = botState.sessionStatuses.get(session.sessionId);
    if (currentStatus === 'working') return 'Running';
    if (currentStatus === 'waiting') return 'Waiting';
    if (currentStatus === 'offline') return 'Runner Offline';
    if (currentStatus === 'error') return 'Error';
    return session.status === 'active' ? 'Ready' : 'Ended';
}

function isSdkSession(session: Session): boolean {
    return session.plugin ? ['claude-sdk', 'codex-sdk', 'gemini-sdk'].includes(session.plugin) : false;
}

function controlUnsupportedReason(session: Session, control: 'model' | 'approval' | 'edit' | 'thinking' | 'maxThinking'): string | null {
    if (!isSdkSession(session)) return 'This control is only supported by SDK sessions.';
    if (control === 'maxThinking' && session.plugin !== 'claude-sdk') {
        return 'Max thinking tokens can only be changed live for Claude SDK sessions.';
    }
    if ((control === 'approval' || control === 'thinking') && session.plugin === 'gemini-sdk') {
        return `Gemini SDK does not support dynamic ${control === 'approval' ? 'approval-mode' : 'thinking-level'} changes yet.`;
    }
    return null;
}

async function replyOrEdit(interaction: any, payload: any): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
        await interaction.update(payload);
    } else {
        await interaction.reply({ ...payload, flags: payload.flags ?? 64 });
    }
}

export async function showSessionDashboard(
    interaction: any,
    userId: string,
    session: Session
): Promise<void> {
    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await replyOrEdit(interaction, {
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this session.')],
            components: [],
            flags: 64
        });
        return;
    }

    const options = getSessionOptions(session);
    const projectConfig = session.folderPath ? projectSettingsStore.getConfig(session.runnerId, session.folderPath) : {};
    const cliDefaults = getCliDefaults(runner, session);
    const approvalMode = resolveApprovalMode(options);
    const editMode = resolveEditMode(options);
    const thinkingLevel = resolveThinkingLevel(session, options);
    const model = options.model ? String(options.model) : 'Auto';
    const maxThinking = hasOwn(options, 'maxThinkingTokens') ? String(options.maxThinkingTokens) : 'Default';
    const modelSource = sourceForModel(options.model, options, projectConfig, cliDefaults);
    const approvalSource = sourceForApproval(options, projectConfig, runner, cliDefaults);
    const editSource = sourceForEdit(options, projectConfig, cliDefaults);
    const thinkingSource = sourceForThinking(session, options, projectConfig, runner, cliDefaults);
    const maxThinkingSource = sourceForMaxThinking(options, projectConfig, cliDefaults);
    const supportedLive = session.plugin && ['claude-sdk', 'codex-sdk', 'gemini-sdk'].includes(session.plugin);

    const embed = new EmbedBuilder()
        .setTitle(`Session: ${session.sessionId.slice(0, 8)}`)
        .setDescription(`Thread controls for <#${session.threadId}>`)
        .setColor(session.status === 'active' ? 0x4C9AFF : 0x808080)
        .addFields(
            { name: 'Runner', value: runner.name, inline: true },
            { name: 'CLI', value: session.cliType.toUpperCase(), inline: true },
            { name: 'Status', value: statusLabel(session), inline: true },
            { name: 'Model', value: settingValue(`\`${model}\``, modelSource), inline: true },
            { name: 'Approval', value: settingValue(approvalLabel(approvalMode), approvalSource), inline: true },
            { name: 'Edit Mode', value: settingValue(editLabel(editMode), editSource), inline: true },
            { name: session.plugin === 'codex-sdk' ? 'Reasoning Effort' : 'Thinking Level', value: settingValue(thinkingLabel(thinkingLevel), thinkingSource), inline: true },
            { name: 'Max Thinking', value: settingValue(maxThinking, maxThinkingSource), inline: true },
            { name: 'Folder', value: session.folderPath ? `\`${session.folderPath}\`` : 'Default', inline: false }
        )
        .setTimestamp();

    if (!supportedLive) {
        embed.setFooter({ text: 'Some controls are only supported by SDK sessions.' });
    }

    const modelRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`live_session_model:${session.sessionId}`)
                .setLabel('Set Model')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'model'))),
            new ButtonBuilder()
                .setCustomId(`live_session_thinking_tokens:${session.sessionId}`)
                .setLabel('Max Thinking')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'maxThinking'))),
            new ButtonBuilder()
                .setCustomId(`live_session_dashboard:${session.sessionId}`)
                .setLabel('Refresh')
                .setStyle(ButtonStyle.Secondary)
        );

    const approvalRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`live_session_approval:${session.sessionId}:manual`)
                .setLabel('Manual')
                .setStyle(approvalMode === 'manual' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'approval'))),
            new ButtonBuilder()
                .setCustomId(`live_session_approval:${session.sessionId}:autoSafe`)
                .setLabel('Auto-Safe')
                .setStyle(approvalMode === 'autoSafe' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'approval'))),
            new ButtonBuilder()
                .setCustomId(`live_session_approval:${session.sessionId}:auto`)
                .setLabel('YOLO')
                .setStyle(approvalMode === 'auto' ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'approval')))
        );

    const editRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`live_session_edit:${session.sessionId}:default`)
                .setLabel('Edit Default')
                .setStyle(editMode === 'default' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'edit'))),
            new ButtonBuilder()
                .setCustomId(`live_session_edit:${session.sessionId}:acceptEdits`)
                .setLabel('Accept Edits')
                .setStyle(editMode === 'acceptEdits' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(Boolean(controlUnsupportedReason(session, 'edit')))
        );

    const thinkingSelect = new StringSelectMenuBuilder()
        .setCustomId(`live_session_thinking_select:${session.sessionId}`)
        .setPlaceholder(`Thinking level: ${thinkingLabel(thinkingLevel)}`)
        .setDisabled(Boolean(controlUnsupportedReason(session, 'thinking')))
        .addOptions(
            thinkingOptionsForSession(session).map(option => {
                const builder = new StringSelectMenuOptionBuilder()
                    .setLabel(option.label)
                    .setValue(option.value)
                    .setDescription(option.description);

                if (option.value === thinkingLevel) builder.setDefault(true);
                return builder;
            })
        );

    const thinkingRow = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
            thinkingSelect
        );

    const actionRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`live_session_command:${session.sessionId}:plan`)
                .setLabel('Plan')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`live_session_command:${session.sessionId}:goal`)
                .setLabel('Goal')
                .setStyle(ButtonStyle.Secondary)
        );

    await replyOrEdit(interaction, {
        embeds: [embed],
        components: [modelRow, approvalRow, editRow, thinkingRow, actionRow],
        flags: 64
    });
}

async function sendLiveControl(
    session: Session,
    action: SessionControlAction,
    value: string | number
): Promise<boolean> {
    const ws = botState.runnerConnections.get(session.runnerId);
    if (!ws) return false;

    ws.send(JSON.stringify({
        type: 'session_control',
        data: {
            runnerId: session.runnerId,
            sessionId: session.sessionId,
            action,
            value
        }
    }));
    return true;
}

function updateStoredSessionOptions(session: Session, update: (options: Record<string, any>) => void): Session {
    const options = getSessionOptions(session);
    update(options);
    storage.updateSession(session.sessionId, { options } as any);
    return { ...session, options } as Session;
}

async function resolveActionSession(interaction: any, userId: string, sessionId: string): Promise<Session | null> {
    const session = storage.getSession(sessionId);
    const runner = session ? storage.getRunner(session.runnerId) : null;

    if (!session || session.status !== 'active') {
        await replyOrEdit(interaction, {
            embeds: [createErrorEmbed('Session Not Found', 'This session is no longer active.')],
            components: [],
            flags: 64
        });
        return null;
    }

    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await replyOrEdit(interaction, {
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this session.')],
            components: [],
            flags: 64
        });
        return null;
    }

    return session;
}

export async function handleLiveSessionDashboardButton(
    interaction: any,
    userId: string,
    customId: string
): Promise<void> {
    const [, sessionId] = customId.split(':');
    const session = await resolveActionSession(interaction, userId, sessionId);
    if (!session) return;

    await showSessionDashboard(interaction, userId, session);
}

export async function handleLiveSessionControlButton(
    interaction: any,
    userId: string,
    customId: string
): Promise<void> {
    const [prefix, sessionId, customValue] = customId.split(':');
    const value = prefix === 'live_session_thinking_select' ? interaction.values?.[0] : customValue;
    const session = await resolveActionSession(interaction, userId, sessionId);
    if (!session) return;

    let updatedSession = session;
    if (prefix === 'live_session_approval') {
        const unsupported = controlUnsupportedReason(session, 'approval');
        if (unsupported) {
            await replyOrEdit(interaction, { embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        const mode = value as ApprovalMode;
        updatedSession = updateStoredSessionOptions(session, options => {
            markLiveOverride(options, 'approval');
            options.approvalMode = mode;
            options.skipPermissions = mode === 'auto';
            options.autoApproveSafe = mode === 'autoSafe';
        });
        await sendLiveControl(updatedSession, 'set_approval_mode', mode);
    } else if (prefix === 'live_session_edit') {
        const unsupported = controlUnsupportedReason(session, 'edit');
        if (unsupported) {
            await replyOrEdit(interaction, { embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        const mode = value as EditMode;
        updatedSession = updateStoredSessionOptions(session, options => {
            markLiveOverride(options, 'edit');
            options.permissionMode = mode;
        });
        await sendLiveControl(updatedSession, 'set_permission_mode', mode);
    } else if (prefix === 'live_session_thinking' || prefix === 'live_session_thinking_select') {
        const unsupported = controlUnsupportedReason(session, 'thinking');
        if (unsupported) {
            await replyOrEdit(interaction, { embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        const level = value as ThinkingLevel;
        updatedSession = updateStoredSessionOptions(session, options => {
            markLiveOverride(options, 'thinking');
            if (session.plugin === 'codex-sdk') {
                delete options.thinkingLevel;
                if (level === 'default') {
                    delete options.reasoningEffort;
                } else {
                    options.reasoningEffort = level === 'off' ? 'none' : level;
                }
            } else if (level === 'default') {
                delete options.thinkingLevel;
            } else {
                options.thinkingLevel = level;
            }
        });
        await sendLiveControl(updatedSession, 'set_thinking_level', level);
    }

    await showSessionDashboard(interaction, userId, updatedSession);
}

export async function handleLiveSessionModalButton(
    interaction: any,
    userId: string,
    customId: string
): Promise<void> {
    const [prefix, sessionId] = customId.split(':');
    const session = await resolveActionSession(interaction, userId, sessionId);
    if (!session) return;

    const options = getSessionOptions(session);
    const modal = new ModalBuilder();
    const input = new TextInputBuilder()
        .setStyle(TextInputStyle.Short)
        .setRequired(prefix === 'live_session_model');

    if (prefix === 'live_session_model') {
        const unsupported = controlUnsupportedReason(session, 'model');
        if (unsupported) {
            await replyOrEdit(interaction, { embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        modal.setCustomId(`live_session_model_modal:${session.sessionId}`)
            .setTitle('Set Session Model');
        input.setCustomId('model')
            .setLabel('Model')
            .setPlaceholder('claude-sonnet-4-5, gpt-5-codex, ...')
            .setValue(options.model ? String(options.model).slice(0, 100) : '');
    } else {
        const unsupported = controlUnsupportedReason(session, 'maxThinking');
        if (unsupported) {
            await replyOrEdit(interaction, { embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        modal.setCustomId(`live_session_thinking_tokens_modal:${session.sessionId}`)
            .setTitle('Set Max Thinking Tokens');
        input.setCustomId('maxThinkingTokens')
            .setLabel('Max Thinking Tokens')
            .setPlaceholder('Example: 4096')
            .setValue(options.maxThinkingTokens ? String(options.maxThinkingTokens).slice(0, 100) : '');
    }

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
}

export async function handleLiveSessionCommandButton(
    interaction: any,
    userId: string,
    customId: string
): Promise<void> {
    const [, sessionId, command] = customId.split(':') as [string, string, LiveSessionCommand];
    const session = await resolveActionSession(interaction, userId, sessionId);
    if (!session) return;

    const runner = storage.getRunner(session.runnerId);
    const ws = runner ? botState.runnerConnections.get(runner.runnerId) : null;
    if (!runner || !ws) {
        await replyOrEdit(interaction, {
            embeds: [createErrorEmbed('Runner Offline', 'The runner is not connected.')],
            flags: 64
        });
        return;
    }

    const controllablePlugins = ['claude-sdk', 'codex-sdk', 'gemini-sdk', 'tmux', 'print', 'stream'];
    if (session.plugin && !controllablePlugins.includes(session.plugin)) {
        await replyOrEdit(interaction, {
            embeds: [createErrorEmbed('Unsupported Session', `Plugin \`${session.plugin}\` cannot receive dashboard commands.`)],
            flags: 64
        });
        return;
    }

    const content = command === 'goal' ? '/goal' : '/plan';
    ws.send(JSON.stringify({
        type: 'user_message',
        data: {
            sessionId: session.sessionId,
            userId,
            username: interaction.user.username,
            content,
            timestamp: new Date().toISOString()
        }
    }));

    await replyOrEdit(interaction, {
        content: `Sent \`${content}\` to session \`${session.sessionId.slice(0, 8)}\`.`,
        flags: 64
    });
}

export async function handleLiveSessionModalSubmit(
    interaction: any,
    userId: string,
    customId: string
): Promise<void> {
    const [prefix, sessionId] = customId.split(':');
    const session = await resolveActionSession(interaction, userId, sessionId);
    if (!session) return;

    let updatedSession = session;
    if (prefix === 'live_session_model_modal') {
        const unsupported = controlUnsupportedReason(session, 'model');
        if (unsupported) {
            await interaction.reply({ embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        const model = interaction.fields.getTextInputValue('model').trim();
        if (!model) {
            await interaction.reply({ content: 'Model cannot be empty.', flags: 64 });
            return;
        }
        updatedSession = updateStoredSessionOptions(session, options => {
            markLiveOverride(options, 'model');
            options.model = model;
        });
        await sendLiveControl(updatedSession, 'set_model', model);
    } else if (prefix === 'live_session_thinking_tokens_modal') {
        const unsupported = controlUnsupportedReason(session, 'maxThinking');
        if (unsupported) {
            await interaction.reply({ embeds: [createErrorEmbed('Unsupported Control', unsupported)], flags: 64 });
            return;
        }
        const raw = interaction.fields.getTextInputValue('maxThinkingTokens').trim();
        const maxTokens = parseInt(raw, 10);
        if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
            await interaction.reply({ content: 'Max thinking tokens must be a positive integer.', flags: 64 });
            return;
        }
        updatedSession = updateStoredSessionOptions(session, options => {
            markLiveOverride(options, 'maxThinking');
            options.maxThinkingTokens = maxTokens;
        });
        await sendLiveControl(updatedSession, 'set_max_thinking_tokens', maxTokens);
    }

    await showSessionDashboard(interaction, userId, updatedSession);
}
