import { eventSource, event_types, saveSettingsDebounced, characters, this_chid, chat_metadata, main_api, extension_prompts, substituteParams, name1, name2, getMaxResponseTokens } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { groups, selected_group } from '../../../group-chats.js';
import { formatInstructModeChat, formatInstructModePrompt } from '../../../instruct-mode.js';
import { promptManager, oai_settings } from '../../../openai.js';
import { defaults, validResponseTokens, parseStoppingStrings, overrideResponseTokens, appendSystemMessage, appendTextSystemMessage, swapMacros, swapContextDescriptions, swapHistory, PromptTransaction } from './core.mjs';

const KEY = 'impersonate_swap';
let active = null;
let transaction = null;
let requestTransaction = null;
let requestConfig = null;
const wrappedManagers = new WeakSet();

function settings() {
    return { ...defaults, ...extension_settings[KEY] };
}

function restore() {
    transaction?.restore();
    transaction = null;
    active = null;
}

function restoreRequest() {
    requestTransaction?.restore();
    requestTransaction = null;
    requestConfig = null;
}

function cleanup() {
    restore();
    restoreRequest();
}

function prepareRequestSettings(config) {
    requestTransaction = new PromptTransaction();
    const limit = config.responseTokensEnabled ? validResponseTokens(config.responseTokens) : null;
    requestConfig = { limit, api: main_api };
    if (limit !== null) {
        if (main_api === 'openai') {
            // Keep this override through CHAT_COMPLETION_SETTINGS_READY: prompt-ready is too early.
            requestTransaction.patch(oai_settings, { openai_max_tokens: limit });
        } else {
            // amount_gen is a read-only ES module binding. Reserve extra response space while
            // building the prompt, then override the request aliases without touching the sliders.
            const extra = Math.max(0, limit - getMaxResponseTokens());
            requestTransaction.patch(power_user, { token_padding: Number(power_user.token_padding || 0) + extra });
        }
    }
    if (config.stoppingStringsEnabled) {
        let additions;
        try {
            additions = parseStoppingStrings(config.stoppingStrings);
        } catch (error) {
            console.warn('[Impersonate Swap] Invalid stopping strings; additions skipped', error);
            return;
        }
        if (!additions.length) return;
        let existing = [];
        try {
            const parsed = JSON.parse(power_user.custom_stopping_strings || '[]');
            if (Array.isArray(parsed)) existing = parsed.filter(value => typeof value === 'string' && value.length > 0);
        } catch { /* ST also treats invalid global JSON as an empty list. */ }
        requestTransaction.patch(power_user, {
            custom_stopping_strings: JSON.stringify([...new Set([...existing, ...additions])]),
        });
    }
}

function finishGenerationData(data, dryRun) {
    try {
        if (!dryRun && requestConfig && requestConfig.api !== 'openai') {
            overrideResponseTokens(data, requestConfig.limit);
        }
    } finally {
        restore();
        // CC has only assembled messages here; its actual request parameters are built later.
        if (requestConfig?.api !== 'openai') restoreRequest();
    }
}

function finishChatSettings(data) {
    if (!requestConfig || requestConfig.api !== 'openai' || data.type !== 'impersonate') return;
    try {
        overrideResponseTokens(data, requestConfig.limit);
    } finally {
        restoreRequest();
    }
}

function wrapPromptManager() {
    if (!promptManager || wrappedManagers.has(promptManager)) return;
    const original = promptManager.preparePrompt;
    promptManager.preparePrompt = function (prompt, ...args) {
        if (active?.systemOverwriteEnabled && active.systemOverwritePrompt.trim() && prompt.identifier === 'main') {
            // Dedicated impersonation text is already written from the intended perspective.
            prompt = { ...prompt, role: 'system', content: active.systemOverwritePrompt };
        } else if (active && prompt.identifier === 'main' && active.system) {
            prompt = { ...prompt, content: swapMacros(prompt.content) };
        }
        if (active?.history && prompt.identifier === 'impersonate') {
            prompt = { ...prompt, content: '' };
        }
        return original.call(this, prompt, ...args);
    };
    wrappedManagers.add(promptManager);
}

function swapFields(object, fields) {
    if (object) transaction.patch(object, Object.fromEntries(fields.map(key => [key, swapMacros(object[key])])));
}

function swapAdditionalSources(config) {
    const group = groups.find(item => item.id === selected_group);
    const cards = group ? characters.filter(card => group.members.includes(card.avatar)) : [characters[this_chid]];
    for (const card of cards.filter(Boolean)) {
        if (config.character) {
            swapFields(card, ['description', 'personality', 'mes_example']);
            swapFields(card.data, ['description', 'personality', 'mes_example']);
            swapFields(card.data?.extensions?.depth_prompt, ['prompt']);
        }
        if (config.scenario) {
            swapFields(card, ['scenario']);
            swapFields(card.data, ['scenario']);
        }
    }
    if (config.character) swapFields(chat_metadata, ['mes_example']);
    if (config.scenario) swapFields(chat_metadata, ['scenario']);
    if (config.persona) swapFields(power_user, ['persona_description']);
    if (config.authorsNote) {
        transaction.transformNextAssignment(extension_prompts, '2_floating_prompt', prompt => ({
            ...prompt, value: swapMacros(prompt.value),
        }));
    }
}

function swapLoreSources(sources) {
    if (!active?.lore) return;
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const entries = sources[key];
        if (!Array.isArray(entries)) continue;
        // These arrays are request-local. Replace entries instead of touching cached books.
        for (let i = 0; i < entries.length; i++) {
            entries[i] = { ...entries[i], content: swapMacros(entries[i].content) };
        }
    }
}

function start(type, _options, dryRun) {
    cleanup();
    const config = settings();
    // ST skips history interceptors for token-count dry runs. Never apply half a swap.
    if (type !== 'impersonate' || dryRun || !config.enabled) return;
    active = config;
    transaction = new PromptTransaction();
    try {
        prepareRequestSettings(config);
        wrapPromptManager();
        swapAdditionalSources(config);
        active.endContextText = config.endContextEnabled ? substituteParams(config.endContextPrompt).trim() : '';
        if (config.systemOverwriteEnabled && config.systemOverwritePrompt.trim() && main_api !== 'openai') {
            transaction.patch(power_user, { prefer_character_prompt: false });
            transaction.patch(power_user.sysprompt, { enabled: true, content: config.systemOverwritePrompt });
        } else if (config.system) {
            transaction.patch(power_user.sysprompt, { content: swapMacros(power_user.sysprompt.content) });
            const data = characters[this_chid]?.data;
            if (data) transaction.patch(data, { system_prompt: swapMacros(data.system_prompt) });
            transaction.patch(chat_metadata, { system_prompt: swapMacros(chat_metadata.system_prompt) });
        }
        if ((config.context || config.contextDescriptions) && main_api !== 'openai') {
            const context = power_user.context;
            transaction.patch(context, Object.fromEntries(
                ['story_string', 'chat_start', 'example_separator'].map(key => {
                    let template = context[key];
                    if (config.context) template = swapMacros(template);
                    if (config.contextDescriptions) template = swapContextDescriptions(template);
                    return [key, template];
                }),
            ));
        }
        if (config.history && main_api !== 'openai' && power_user.instruct.enabled) {
            const instruct = power_user.instruct;
            // ST's impersonate still targets the user's name, but must open an assistant turn.
            // A whitespace fallback prevents ST falling back to the input sequence for empty output.
            transaction.patch(instruct, { last_input_sequence: instruct.last_output_sequence || instruct.output_sequence || ' ' });
        }
    } catch (error) {
        cleanup();
        console.error('[Impersonate Swap] Failed to prepare prompt', error);
        throw error;
    }
}

function finishChatPrompt(event) {
    try {
        if (active?.endContextText && !event.dryRun) appendSystemMessage(event.chat, active.endContextText);
    } finally {
        restore();
    }
}

function finishTextPrompt(data) {
    if (!active?.endContextText || main_api === 'openai') return;
    const instruct = power_user.instruct.enabled;
    const cue = instruct
        ? formatInstructModePrompt(name1, true, '', name1, name2, false, false)
        : `\n${name1}:`;
    const formatSystem = text => instruct
        ? formatInstructModeChat('', text, false, true, '', name1, name2, false)
        : `${text}\n`;
    const marker = '__IMPERSONATE_SWAP_SYSTEM_CONTENT__';
    const systemPrefix = formatSystem(marker).split(marker)[0];
    const recognizeFrames = instruct && [true, false].every(isUser =>
        formatInstructModeChat('', marker, isUser, false, '', name1, name2, false).split(marker)[0] !== systemPrefix);
    appendTextSystemMessage(data.finalMesSend, active.endContextText, cue, formatSystem, (last, body) =>
        last.injected === true || active.narratorMessages?.some(text => formatSystem(text).trimEnd() === body.trimEnd()),
    { recognizeFrames, trimFinalNewline: !instruct || power_user.instruct.wrap });
}

globalThis.impersonateSwapInterceptor = (chat, _contextSize, _abort, type) => {
    if (type !== 'impersonate' || !active) return;
    active.narratorMessages = chat.filter(message => message.extra?.type === 'narrator').map(message => message.mes);
    if (active.history) swapHistory(chat);
};

// Restore before every new generation, including aborted slash commands and dry runs.
eventSource.makeFirst(event_types.GENERATION_STARTED, cleanup);
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, start);
eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, swapLoreSources);
// Text Completion has finished formatting/tokenizing; CC has finished preparing all prompts.
eventSource.makeLast(event_types.GENERATE_AFTER_DATA, finishGenerationData);
eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, finishChatSettings);
eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, finishChatPrompt);
eventSource.makeLast(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, finishTextPrompt);
eventSource.on(event_types.GENERATION_ENDED, cleanup);
eventSource.on(event_types.GENERATION_STOPPED, cleanup);
eventSource.on(event_types.CHAT_CHANGED, cleanup);
window.addEventListener('unhandledrejection', cleanup);
window.addEventListener('error', cleanup);

jQuery(() => {
    const panel = document.createElement('div');
    panel.id = 'impersonate_swap_settings';
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Impersonate Swap</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <p>Обмен ролями только при Impersonate. Результат остаётся в поле ввода.</p>
            <div class="impersonate-swap-options"></div>
            <small>Context template используется только в Text Completion. Замена макросов в карточке, персоне, сценарии, лоре и Author’s Note выключена по умолчанию. Тексты сообщений и буквальные имена не меняются.</small>
        </div>
    </div>`;
    const labels = {
        enabled: 'Включить Impersonate Swap',
        history: 'Менять user ↔ assistant в истории',
        system: 'Менять {{char}} ↔ {{user}} в System Prompt',
        context: 'Менять {{char}} ↔ {{user}} в Context Template',
        contextDescriptions: 'Менять {{persona}} ↔ {{description}} и обнулять {{personality}} в Context Template',
        character: 'Менять {{char}} ↔ {{user}} в карточке (описание, личность, примеры, depth prompt)',
        persona: 'Менять {{char}} ↔ {{user}} в описании персоны',
        scenario: 'Менять {{char}} ↔ {{user}} в сценарии',
        lore: 'Менять {{char}} ↔ {{user}} в лоре / World Info',
        authorsNote: 'Менять {{char}} ↔ {{user}} в Author’s Note',
    };
    const refreshPromptEditors = [];
    for (const [key, text] of Object.entries(labels)) {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = settings()[key];
        input.addEventListener('change', () => {
            extension_settings[KEY] = { ...settings(), [key]: input.checked };
            saveSettingsDebounced();
            refreshPromptEditors.forEach(refresh => refresh());
        });
        label.append(input, document.createTextNode(text));
        panel.querySelector('.impersonate-swap-options').append(label);
    }
    for (const [enabledKey, textKey, title, hint] of [
        ['systemOverwriteEnabled', 'systemOverwritePrompt', 'System Prompt Overwrite', 'Заменяет основной системный промпт только при Impersonate.'],
        ['endContextEnabled', 'endContextPrompt', 'End-Context System Prompt', 'Добавляется последним системным ходом; дописывается к существующему конечному system-ходу.'],
    ]) {
        const section = document.createElement('div');
        section.className = 'impersonate-swap-prompt m-t-1';
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = settings()[enabledKey];
        label.append(toggle, document.createTextNode(title));
        const textarea = document.createElement('textarea');
        textarea.className = 'text_pole';
        textarea.rows = 5;
        textarea.value = settings()[textKey];
        textarea.setAttribute('aria-label', title);
        textarea.placeholder = 'Текст для Impersonate; макросы раскрываются без автоматического свапа имён.';
        const description = document.createElement('small');
        description.textContent = hint + ' Пустое поле ничего не меняет.';
        const refresh = () => {
            const enabled = settings().enabled && toggle.checked;
            textarea.disabled = !enabled;
            textarea.style.opacity = enabled ? '1' : '0.45';
            description.style.opacity = enabled ? '1' : '0.45';
        };
        refreshPromptEditors.push(refresh);
        toggle.addEventListener('change', () => {
            extension_settings[KEY] = { ...settings(), [enabledKey]: toggle.checked };
            saveSettingsDebounced();
            refresh();
        });
        textarea.addEventListener('input', () => {
            extension_settings[KEY] = { ...settings(), [textKey]: textarea.value };
            saveSettingsDebounced();
        });
        section.append(label, textarea, description);
        panel.querySelector('.inline-drawer-content').append(section);
        refresh();
    }
    for (const [enabledKey, valueKey, title, numeric, hint] of [
        ['responseTokensEnabled', 'responseTokens', 'Response (tokens)', true, 'Максимум выходных токенов для Impersonate; целое число больше нуля.'],
        ['stoppingStringsEnabled', 'stoppingStrings', 'Additional stopping strings', false, 'По одной строке или JSON-массив строк. Добавляются к существующим; ограничения API сохраняются.'],
    ]) {
        const section = document.createElement('div');
        section.className = 'impersonate-swap-request-setting m-t-1';
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = settings()[enabledKey];
        label.append(toggle, document.createTextNode(title));
        const input = document.createElement(numeric ? 'input' : 'textarea');
        input.className = 'text_pole';
        if (numeric) {
            input.type = 'number';
            input.min = '1';
            input.step = '1';
        } else {
            input.rows = 4;
            input.placeholder = 'STOP\n<|end|>';
        }
        input.value = settings()[valueKey];
        input.setAttribute('aria-label', title);
        const description = document.createElement('small');
        const refresh = () => {
            const enabled = settings().enabled && toggle.checked;
            input.disabled = !enabled;
            input.style.opacity = description.style.opacity = enabled ? '1' : '0.45';
            let error = '';
            if (numeric && !validResponseTokens(input.value)) error = 'Введите целое число больше нуля; неверное значение не применяется.';
            if (!numeric) {
                try { parseStoppingStrings(input.value); }
                catch { error = 'Некорректный JSON: нужен массив строк. Дополнительные стоп-строки не будут применены.'; }
            }
            description.textContent = error || hint;
            input.setCustomValidity?.(error);
        };
        refreshPromptEditors.push(refresh);
        toggle.addEventListener('change', () => {
            extension_settings[KEY] = { ...settings(), [enabledKey]: toggle.checked };
            saveSettingsDebounced();
            refresh();
        });
        input.addEventListener('input', () => {
            extension_settings[KEY] = { ...settings(), [valueKey]: input.value };
            saveSettingsDebounced();
            refresh();
        });
        section.append(label, input, description);
        panel.querySelector('.inline-drawer-content').append(section);
        refresh();
    }
    document.getElementById('extensions_settings').append(panel);
});
