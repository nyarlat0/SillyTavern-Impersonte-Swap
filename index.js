import { eventSource, event_types, saveSettingsDebounced, characters, this_chid, chat_metadata, main_api } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { promptManager } from '../../../openai.js';
import { defaults, swapMacros, swapHistory, PromptTransaction } from './core.mjs';

const KEY = 'impersonate_swap';
let active = null;
let transaction = null;
const wrappedManagers = new WeakSet();

function settings() {
    return { ...defaults, ...extension_settings[KEY] };
}

function restore() {
    transaction?.restore();
    transaction = null;
    active = null;
}

function wrapPromptManager() {
    if (!promptManager || wrappedManagers.has(promptManager)) return;
    const original = promptManager.preparePrompt;
    promptManager.preparePrompt = function (prompt, ...args) {
        if (active && prompt.identifier === 'main' && active.system) {
            prompt = { ...prompt, content: swapMacros(prompt.content) };
        }
        if (active?.history && prompt.identifier === 'impersonate') {
            prompt = { ...prompt, content: '' };
        }
        return original.call(this, prompt, ...args);
    };
    wrappedManagers.add(promptManager);
}

function start(type, _options, dryRun) {
    restore();
    const config = settings();
    // ST skips history interceptors for token-count dry runs. Never apply half a swap.
    if (type !== 'impersonate' || dryRun || !config.enabled) return;
    active = config;
    transaction = new PromptTransaction();
    try {
        wrapPromptManager();
        if (config.system) {
            transaction.patch(power_user.sysprompt, { content: swapMacros(power_user.sysprompt.content) });
            const data = characters[this_chid]?.data;
            if (data) transaction.patch(data, { system_prompt: swapMacros(data.system_prompt) });
            transaction.patch(chat_metadata, { system_prompt: swapMacros(chat_metadata.system_prompt) });
        }
        if (config.context && main_api !== 'openai') {
            const context = power_user.context;
            transaction.patch(context, Object.fromEntries(
                ['story_string', 'chat_start', 'example_separator'].map(key => [key, swapMacros(context[key])]),
            ));
        }
        if (config.history && main_api !== 'openai' && power_user.instruct.enabled) {
            const instruct = power_user.instruct;
            // ST's impersonate still targets the user's name, but must open an assistant turn.
            // A whitespace fallback prevents ST falling back to the input sequence for empty output.
            transaction.patch(instruct, { last_input_sequence: instruct.last_output_sequence || instruct.output_sequence || ' ' });
        }
    } catch (error) {
        restore();
        console.error('[Impersonate Swap] Failed to prepare prompt', error);
        throw error;
    }
}

globalThis.impersonateSwapInterceptor = (chat, _contextSize, _abort, type) => {
    if (type === 'impersonate' && active?.history) swapHistory(chat);
};

// Restore before every new generation, including aborted slash commands and dry runs.
eventSource.makeFirst(event_types.GENERATION_STARTED, restore);
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, start);
// Text Completion has finished formatting/tokenizing; CC has finished preparing all prompts.
eventSource.makeLast(event_types.GENERATE_AFTER_DATA, restore);
eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, restore);
eventSource.on(event_types.GENERATION_ENDED, restore);
eventSource.on(event_types.GENERATION_STOPPED, restore);
eventSource.on(event_types.CHAT_CHANGED, restore);
window.addEventListener('unhandledrejection', restore);
window.addEventListener('error', restore);

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
            <small>Context template используется только в Text Completion. Макросы в сообщениях, описаниях, World Info и примерах не меняются.</small>
        </div>
    </div>`;
    const labels = {
        enabled: 'Включить Impersonate Swap',
        history: 'Менять user ↔ assistant в истории',
        system: 'Менять {{char}} ↔ {{user}} в System Prompt',
        context: 'Менять {{char}} ↔ {{user}} в Context Template',
    };
    for (const [key, text] of Object.entries(labels)) {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = settings()[key];
        input.addEventListener('change', () => {
            extension_settings[KEY] = { ...settings(), [key]: input.checked };
            saveSettingsDebounced();
        });
        label.append(input, document.createTextNode(text));
        panel.querySelector('.impersonate-swap-options').append(label);
    }
    document.getElementById('extensions_settings').append(panel);
});
