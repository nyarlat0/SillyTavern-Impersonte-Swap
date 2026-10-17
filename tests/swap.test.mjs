import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { defaults, appendSystemMessage, appendTextSystemMessage, swapMacros, swapContextDescriptions, swapHistory, PromptTransaction } from '../core.mjs';

test('swap only the two exact macros in one pass', () => {
    assert.equal(swapMacros('{{char}} {{USER}} {{ user }} {{persona}} Alice char {{character}}'),
        '{{user}} {{char}} {{char}} {{persona}} Alice char {{character}}');
    assert.equal(swapMacros(undefined), undefined);
});

test('history swaps roles without changing saved messages, text, names or attachments', () => {
    const source = [
        { is_user: true, name: 'Alice', mes: '{{char}}', extra: { media: ['image'] } },
        { is_user: false, name: 'Bob', mes: '{{user}}' },
        { is_system: true, is_user: false, mes: 'system' },
        { is_user: false, extra: { type: 'narrator' } },
        { is_user: false, extra: { tool_invocations: [{}] } },
    ];
    const before = structuredClone(source);
    const prompt = [...source];
    swapHistory(prompt);
    assert.deepEqual(source, before);
    assert.deepEqual(prompt.map(x => x.is_user), [false, true, false, false, false]);
    assert.equal(prompt[0].mes, '{{char}}');
    assert.equal(prompt[0].name, 'Alice');
    assert.equal(prompt[0].extra, source[0].extra);
});

test('temporary templates serialize as originals and restore without losing user edits', () => {
    const object = { content: '{{char}}', untouched: 'x' };
    const transaction = new PromptTransaction();
    transaction.patch(object, { content: '{{user}}', added: 'temporary' });
    assert.equal(object.content, '{{user}}');
    assert.deepEqual(JSON.parse(JSON.stringify(object)), { content: '{{char}}', untouched: 'x' });
    assert.equal(structuredClone(object).content, '{{user}}');
    object.untouched = 'edited';
    transaction.restore();
    assert.deepEqual(object, { content: '{{char}}', untouched: 'edited' });
    transaction.patch(object, { content: 'temporary' });
    object.content = 'user edit';
    transaction.restore();
    transaction.restore();
    assert.equal(object.content, 'user edit');
});

async function fixture(api = 'openai', document = undefined) {
    const listeners = new Map();
    const eventSource = {
        on(key, fn) { const items = listeners.get(key) ?? []; items.push(fn); listeners.set(key, items); },
        makeFirst(key, fn) { const items = listeners.get(key) ?? []; items.unshift(fn); listeners.set(key, items); },
        makeLast(key, fn) { this.on(key, fn); },
    };
    const event_types = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_AFTER_DATA',
        'CHAT_COMPLETION_PROMPT_READY', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'WORLDINFO_ENTRIES_LOADED', 'GENERATE_BEFORE_COMBINE_PROMPTS'].map(x => [x, x]));
    const power_user = {
        sysprompt: { content: 'You are {{char}}, talk to {{user}}', post_history: '{{char}}' },
        context: { story_string: '{{char}}: {{description}} {{user}}: {{persona}}', chat_start: '{{char}}', example_separator: '###' },
        instruct: { enabled: true, input_sequence: '<user>', output_sequence: '<assistant>', last_input_sequence: '<last-user>' },
    };
    const characters = [{ data: { system_prompt: '{{char}} override', description: '{{char}} description' } }];
    const chat_metadata = { system_prompt: '{{char}} chat override' };
    const extension_settings = {};
    const extension_prompts = {};
    const groups = [];
    const promptManager = { preparePrompt: prompt => ({ ...prompt }) };
    const ready = [];
    const context = vm.createContext({ console, document, window: { addEventListener() {} }, jQuery(callback) { ready.push(callback); } });
    const dependencies = {
        '../../../../script.js': { eventSource, event_types, characters, chat_metadata, extension_prompts, this_chid: 0, main_api: api, name1: 'Alice', name2: 'Bob',
            substituteParams: text => text.replaceAll('{{user}}', 'Alice').replaceAll('{{char}}', 'Bob'), saveSettingsDebounced() {} },
        '../../../extensions.js': { extension_settings },
        '../../../power-user.js': { power_user },
        '../../../group-chats.js': { groups, selected_group: 'group' },
        '../../../instruct-mode.js': {
            formatInstructModePrompt: () => '\n<assistant>',
            formatInstructModeChat: (_name, text) => `<system>\n${text}</system>\n`,
        },
        '../../../openai.js': { promptManager },
        './core.mjs': { defaults, appendSystemMessage, appendTextSystemMessage, swapMacros, swapContextDescriptions, swapHistory, PromptTransaction },
    };
    const module = new vm.SourceTextModule(await readFile(new URL('../index.js', import.meta.url), 'utf8'), { context });
    await module.link(specifier => {
        const values = dependencies[specifier];
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    const emit = async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args); };
    const start = async (type = 'impersonate', dry = false) => {
        await emit('GENERATION_STARTED', type, {}, dry);
        await emit('GENERATION_AFTER_COMMANDS', type, {}, dry);
    };
    return { power_user, characters, chat_metadata, extension_prompts, groups, extension_settings, promptManager, context, emit, start, render: () => ready.forEach(callback => callback()) };
}

test('Chat Completion changes main prompt and history, excludes other prompt blocks, cleans up', async () => {
    const f = await fixture();
    const original = JSON.stringify(f.power_user);
    await f.start();
    assert.equal(f.promptManager.preparePrompt({ identifier: 'main', content: '{{char}} {{user}}' }).content, '{{user}} {{char}}');
    for (const identifier of ['jailbreak', 'personaDescription', 'worldInfoBefore', 'charDescription', 'custom']) {
        assert.equal(f.promptManager.preparePrompt({ identifier, content: '{{char}}' }).content, '{{char}}');
    }
    assert.equal(f.promptManager.preparePrompt({ identifier: 'impersonate', content: 'old instruction' }).content, '');
    const history = [{ is_user: true }];
    f.context.impersonateSwapInterceptor(history, 4096, () => {}, 'impersonate');
    assert.equal(history[0].is_user, false);
    assert.equal(f.characters[0].data.system_prompt, '{{user}} override');
    assert.equal(f.characters[0].data.description, '{{char}} description');
    assert.equal(f.chat_metadata.system_prompt, '{{user}} chat override');
    assert.equal(JSON.stringify(f.power_user), original);
    await f.emit('CHAT_COMPLETION_PROMPT_READY', {});
    assert.equal(f.chat_metadata.system_prompt, '{{char}} chat override');
    assert.equal(f.characters[0].data.system_prompt, '{{char}} override');
    assert.equal(f.promptManager.preparePrompt({ identifier: 'main', content: '{{char}}' }).content, '{{char}}');
});

test('Text Completion uses assistant continuation marker and restores all settings on stop', async () => {
    const f = await fixture('textgenerationwebui');
    const original = structuredClone(f.power_user);
    await f.start();
    assert.equal(f.power_user.instruct.last_input_sequence, '<assistant>');
    assert.equal(f.power_user.instruct.input_sequence, '<user>');
    assert.equal(f.power_user.context.story_string, '{{user}}: {{persona}} {{char}}: {{description}}');
    assert.equal(f.power_user.sysprompt.post_history, '{{char}}');
    await f.emit('GENERATION_STOPPED');
    assert.deepEqual(f.power_user, original);
    await f.start();
    await f.emit('GENERATE_AFTER_DATA');
    assert.deepEqual(f.power_user, original);
});

test('normal generation, dry runs and disabled extension are unchanged', async () => {
    const f = await fixture('textgenerationwebui');
    const original = structuredClone(f.power_user);
    for (const [type, dry, enabled] of [['normal', false, true], ['impersonate', true, true], ['impersonate', false, false]]) {
        f.extension_settings.impersonate_swap = { enabled };
        await f.start(type, dry);
        assert.deepEqual(f.power_user, original);
        const history = [{ is_user: true }];
        f.context.impersonateSwapInterceptor(history, 4096, () => {}, type);
        assert.equal(history[0].is_user, true);
    }
});

test('all three checkboxes act independently', async () => {
    for (const selected of ['history', 'system', 'context']) {
        const f = await fixture('textgenerationwebui');
        f.extension_settings.impersonate_swap = { history: false, system: false, context: false, [selected]: true };
        await f.start();
        assert.equal(f.power_user.sysprompt.content.startsWith('You are {{user}}'), selected === 'system');
        assert.equal(f.power_user.context.story_string.startsWith('{{user}}'), selected === 'context');
        assert.equal(f.power_user.instruct.last_input_sequence === '<assistant>', selected === 'history');
        await f.emit('GENERATION_ENDED');
    }
});

function populateSources(f) {
    Object.assign(f.characters[0], {
        avatar: 'alice.png', description: '{{char}} description', personality: '{{user}} personality',
        mes_example: '{{char}}: example', scenario: '{{user}} scenario', first_mes: '{{char}} greeting',
    });
    Object.assign(f.characters[0].data, {
        description: '{{char}} description', personality: '{{user}} personality',
        mes_example: '{{char}}: example', scenario: '{{user}} scenario',
        extensions: { depth_prompt: { prompt: '{{char}} depth' } },
        post_history_instructions: '{{char}} PHI',
    });
    Object.assign(f.chat_metadata, { mes_example: '{{user}} example override', scenario: '{{char}} scenario override' });
    f.power_user.persona_description = '{{user}} persona';
}

test('new scopes default off for existing installations', async () => {
    const f = await fixture();
    populateSources(f);
    await f.start();
    assert.equal(f.characters[0].description, '{{char}} description');
    assert.equal(f.power_user.persona_description, '{{user}} persona');
    assert.equal(f.chat_metadata.scenario, '{{char}} scenario override');
    const sources = { globalLore: [{ content: '{{char}} lore' }] };
    await f.emit('WORLDINFO_ENTRIES_LOADED', sources);
    assert.equal(sources.globalLore[0].content, '{{char}} lore');
    f.extension_prompts['2_floating_prompt'] = { value: '{{user}} note' };
    assert.equal(f.extension_prompts['2_floating_prompt'].value, '{{user}} note');
    await f.emit('GENERATION_ENDED');
});

test('card, persona and scenario are independent on both APIs and restore saved sources', async () => {
    for (const api of ['openai', 'textgenerationwebui']) {
        for (const selected of ['character', 'persona', 'scenario']) {
            const f = await fixture(api);
            populateSources(f);
            f.extension_settings.impersonate_swap = { system: false, context: false, [selected]: true };
            const snapshot = JSON.stringify([f.characters, f.power_user, f.chat_metadata]);
            await f.start();
            assert.equal(f.characters[0].description, selected === 'character' ? '{{user}} description' : '{{char}} description');
            assert.equal(f.characters[0].data.extensions.depth_prompt.prompt, selected === 'character' ? '{{user}} depth' : '{{char}} depth');
            assert.equal(f.chat_metadata.mes_example, selected === 'character' ? '{{char}} example override' : '{{user}} example override');
            assert.equal(f.power_user.persona_description, selected === 'persona' ? '{{char}} persona' : '{{user}} persona');
            assert.equal(f.chat_metadata.scenario, selected === 'scenario' ? '{{user}} scenario override' : '{{char}} scenario override');
            assert.equal(f.characters[0].scenario, selected === 'scenario' ? '{{char}} scenario' : '{{user}} scenario');
            assert.equal(f.characters[0].first_mes, '{{char}} greeting');
            assert.equal(f.characters[0].data.post_history_instructions, '{{char}} PHI');
            assert.equal(JSON.stringify([f.characters, f.power_user, f.chat_metadata]), snapshot);
            await f.emit('GENERATE_AFTER_DATA');
            assert.equal(JSON.stringify([f.characters, f.power_user, f.chat_metadata]), snapshot);
            assert.equal(f.characters[0].description, '{{char}} description');
        }
    }
});

test('lore swaps content for all book sources without changing keys or source records', async () => {
    const f = await fixture();
    f.extension_settings.impersonate_swap = { lore: true };
    await f.start();
    const original = { content: '{{char}} knows {{user}}', key: ['{{char}}'], keysecondary: ['{{user}}'], position: 4 };
    const sources = Object.fromEntries(['globalLore', 'characterLore', 'chatLore', 'personaLore'].map(key => [key, [original]]));
    await f.emit('WORLDINFO_ENTRIES_LOADED', sources);
    for (const entries of Object.values(sources)) {
        assert.equal(entries[0].content, '{{user}} knows {{char}}');
        assert.equal(entries[0].key[0], '{{char}}');
        assert.equal(entries[0].keysecondary[0], '{{user}}');
        assert.equal(entries[0].position, 4);
    }
    assert.equal(original.content, '{{char}} knows {{user}}');
    await f.emit('GENERATION_STOPPED');
    const normal = { globalLore: [original] };
    await f.emit('WORLDINFO_ENTRIES_LOADED', normal);
    assert.equal(normal.globalLore[0], original);
});

test('note swap happens before WI/persona insertion and never swaps the combined note again', async () => {
    const f = await fixture();
    f.extension_settings.impersonate_swap = { authorsNote: true, persona: true };
    f.power_user.persona_description = '{{user}} persona';
    const original = { value: 'previous note' };
    f.extension_prompts['2_floating_prompt'] = original;
    await f.start();
    // setFloatingPrompt combines the textarea and character-specific note.
    f.extension_prompts['2_floating_prompt'] = { value: '{{char}} chat note\n{{user}} character note', depth: 4 };
    assert.equal(f.extension_prompts['2_floating_prompt'].value, '{{user}} chat note\n{{char}} character note');
    // WI and persona are appended later by ST, under their own independent switches.
    f.extension_prompts['2_floating_prompt'] = {
        ...f.extension_prompts['2_floating_prompt'],
        value: f.extension_prompts['2_floating_prompt'].value + '\n{{char}} lore\n' + f.power_user.persona_description,
    };
    assert.equal(f.extension_prompts['2_floating_prompt'].value,
        '{{user}} chat note\n{{char}} character note\n{{char}} lore\n{{char}} persona');
    await f.emit('GENERATION_STOPPED');
    assert.equal(f.extension_prompts['2_floating_prompt'], original);
    assert.equal(f.power_user.persona_description, '{{user}} persona');
    await f.start('normal');
    f.extension_prompts['2_floating_prompt'] = { value: '{{char}} normal note' };
    assert.equal(f.extension_prompts['2_floating_prompt'].value, '{{char}} normal note');
});

test('group card scopes include members but exclude unrelated characters', async () => {
    const f = await fixture();
    populateSources(f);
    f.characters.push({ avatar: 'bob.png', description: '{{char}} Bob' }, { avatar: 'other.png', description: '{{char}} Other' });
    f.groups.push({ id: 'group', members: ['alice.png', 'bob.png'] });
    f.extension_settings.impersonate_swap = { character: true };
    await f.start();
    assert.equal(f.characters[1].description, '{{user}} Bob');
    assert.equal(f.characters[2].description, '{{char}} Other');
    await f.emit('GENERATION_ENDED');
    assert.equal(f.characters[1].description, '{{char}} Bob');
});

test('context descriptions swap in one pass and clear personality including standard guards', () => {
    assert.equal(swapContextDescriptions('{{persona}}|{{description}}|{{personality}}|{{scenario}}'),
        '{{description}}|{{persona}}||{{scenario}}');
    assert.equal(swapContextDescriptions('{{#if persona}}{{{persona}}}{{/if}}{{#if description}}{{description}}{{/if}}{{#if personality}}Personality: {{personality}}{{/if}}'),
        '{{#if description}}{{{description}}}{{/if}}{{#if persona}}{{persona}}{{/if}}{{#if ""}}Personality: {{/if}}');
    assert.equal(swapContextDescriptions('{{ PERSONA }} {{~description~}} {{personality_summary}}'),
        '{{ description }} {{~persona~}} {{personality_summary}}');
    assert.equal(swapContextDescriptions(undefined), undefined);
});

test('description setting defaults on, is independent of name swap, and restores context', async () => {
    for (const names of [false, true]) {
        for (const descriptions of [undefined, false, true]) {
            const f = await fixture('textgenerationwebui');
            populateSources(f);
            f.power_user.context.story_string = '{{char}} {{persona}} {{description}} {{personality}}';
            f.power_user.context.chat_start = '{{persona}} {{personality}}';
            f.power_user.context.example_separator = '{{description}}';
            f.extension_settings.impersonate_swap = { context: names };
            if (descriptions !== undefined) f.extension_settings.impersonate_swap.contextDescriptions = descriptions;
            const before = structuredClone(f.power_user.context);
            await f.start();
            assert.equal(f.power_user.context.story_string,
                (names ? '{{user}} ' : '{{char}} ') + (descriptions !== false
                    ? '{{description}} {{persona}} ' : '{{persona}} {{description}} {{personality}}'));
            assert.equal(f.power_user.context.chat_start, descriptions !== false ? '{{description}} ' : '{{persona}} {{personality}}');
            assert.equal(f.power_user.context.example_separator, descriptions !== false ? '{{persona}}' : '{{description}}');
            assert.deepEqual(JSON.parse(JSON.stringify(f.power_user.context)), before);
            assert.equal(f.characters[0].description, '{{char}} description');
            assert.equal(f.characters[0].personality, '{{user}} personality');
            assert.equal(f.power_user.persona_description, '{{user}} persona');
            await f.emit('GENERATE_AFTER_DATA');
            assert.deepEqual(f.power_user.context, before);
        }
    }
});

test('context description swap does not affect Chat Completion', async () => {
    const f = await fixture('openai');
    f.power_user.context.story_string = '{{persona}} {{description}} {{personality}}';
    const before = structuredClone(f.power_user.context);
    await f.start();
    assert.deepEqual(f.power_user.context, before);
    await f.emit('CHAT_COMPLETION_PROMPT_READY');
});

test('end system message appends to an existing system turn, preserving metadata and multimodal parts', () => {
    const chat = [{ role: 'user', content: 'Hi' }];
    appendSystemMessage(chat, 'End');
    assert.deepEqual(chat.at(-1), { role: 'system', content: 'End' });
    chat.at(-1).name = 'note';
    appendSystemMessage(chat, 'More');
    assert.equal(chat.length, 2);
    assert.equal(chat.at(-1).content, 'End\n\nMore');
    assert.equal(chat.at(-1).name, 'note');
    const parts = [{ type: 'text', text: 'Note' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }];
    const multimodal = [{ role: 'system', content: parts }];
    appendSystemMessage(multimodal, 'End');
    assert.equal(multimodal.length, 1);
    assert.equal(multimodal[0].content[1], parts[1]);
    assert.equal(multimodal[0].content.at(-1).text, '\n\nEnd');
    assert.equal(parts.length, 2);
    appendSystemMessage([], '  ');
});

test('end prompt in Chat Completion is last, expands macros without swapping and is impersonate-only', async () => {
    for (const finalRole of ['system', 'assistant', 'user']) {
        const f = await fixture();
        f.extension_settings.impersonate_swap = { endContextEnabled: true, endContextPrompt: 'Write for {{user}}, address {{char}}.' };
        await f.start();
        const event = { chat: [{ role: finalRole, content: 'Previous' }] };
        await f.emit('CHAT_COMPLETION_PROMPT_READY', event);
        assert.equal(event.chat.at(-1).role, 'system');
        assert.equal(event.chat.at(-1).content, (finalRole === 'system' ? 'Previous\n\n' : '') + 'Write for Alice, address Bob.');
        assert.equal(event.chat.length, finalRole === 'system' ? 1 : 2);
        await f.start('normal');
        const normal = { chat: [{ role: 'user', content: 'Hi' }] };
        await f.emit('CHAT_COMPLETION_PROMPT_READY', normal);
        assert.equal(normal.chat.length, 1);
    }
});

test('new prompts are ignored when disabled, blank, globally disabled, or dry-run', async () => {
    for (const config of [
        { endContextPrompt: 'End', systemOverwritePrompt: 'Overwrite' },
        { endContextEnabled: true, systemOverwriteEnabled: true, endContextPrompt: '   ', systemOverwritePrompt: '\n' },
        { enabled: false, endContextEnabled: true, systemOverwriteEnabled: true, endContextPrompt: 'End', systemOverwritePrompt: 'Overwrite' },
    ]) {
        const f = await fixture();
        f.extension_settings.impersonate_swap = config;
        await f.start();
        assert.notEqual(f.promptManager.preparePrompt({ identifier: 'main', content: 'Original' }).content, 'Overwrite');
        const event = { chat: [] };
        await f.emit('CHAT_COMPLETION_PROMPT_READY', event);
        assert.equal(event.chat.length, 0);
    }
    const f = await fixture();
    f.extension_settings.impersonate_swap = { endContextEnabled: true, endContextPrompt: 'End' };
    await f.start('impersonate', true);
    const event = { chat: [], dryRun: true };
    await f.emit('CHAT_COMPLETION_PROMPT_READY', event);
    assert.equal(event.chat.length, 0);
});

test('system overwrite wins over preset and card on CC without applying name swap', async () => {
    const f = await fixture();
    f.extension_settings.impersonate_swap = { systemOverwriteEnabled: true, systemOverwritePrompt: 'You are {{user}}.' };
    await f.start();
    for (const content of ['Preset prompt', 'Card override']) {
        const result = f.promptManager.preparePrompt({ identifier: 'main', role: 'user', content });
        assert.equal(result.content, 'You are {{user}}.');
        assert.equal(result.role, 'system');
    }
    assert.equal(f.promptManager.preparePrompt({ identifier: 'jailbreak', content: 'PHI' }).content, 'PHI');
    await f.emit('GENERATION_ENDED');
    assert.equal(f.promptManager.preparePrompt({ identifier: 'main', content: 'Preset prompt' }).content, 'Preset prompt');
});

test('text system overwrite enables system prompt and bypasses card preference temporarily', async () => {
    const f = await fixture('textgenerationwebui');
    f.power_user.prefer_character_prompt = true;
    f.power_user.sysprompt.enabled = false;
    const original = structuredClone(f.power_user);
    f.extension_settings.impersonate_swap = { systemOverwriteEnabled: true, systemOverwritePrompt: 'You are {{user}}.' };
    await f.start();
    assert.equal(f.power_user.sysprompt.content, 'You are {{user}}.');
    assert.equal(f.power_user.sysprompt.enabled, true);
    assert.equal(f.power_user.prefer_character_prompt, false);
    assert.deepEqual(JSON.parse(JSON.stringify(f.power_user)), original);
    await f.emit('GENERATE_AFTER_DATA');
    assert.deepEqual(f.power_user, original);
});

test('text end prompt precedes response cue and merges a final system note', async () => {
    const f = await fixture('textgenerationwebui');
    f.extension_settings.impersonate_swap = { endContextEnabled: true, endContextPrompt: 'End for {{user}}' };
    await f.start();
    const note = { finalMesSend: [{ message: '<system>\nAuthor note</system>\n<assistant>', extensionPrompts: [], injected: true }] };
    await f.emit('GENERATE_BEFORE_COMBINE_PROMPTS', note);
    assert.equal(note.finalMesSend[0].message, '<system>\nAuthor note\n\nEnd for Alice</system>\n<assistant>');
    const ordinary = { finalMesSend: [{ message: '<user>\nHi</user>\n<assistant>', extensionPrompts: [], injected: false }] };
    await f.emit('GENERATE_BEFORE_COMBINE_PROMPTS', ordinary);
    assert.equal(ordinary.finalMesSend[0].message, '<user>\nHi</user>\n<system>\nEnd for Alice</system>\n<assistant>');
    await f.emit('GENERATE_AFTER_DATA');
});

test('plain text end prompt preserves the user name cue and empty history', () => {
    const items = [{ message: 'Bob: Hi\nAlice:', extensionPrompts: [] }];
    appendTextSystemMessage(items, 'End', '\nAlice:', text => `${text}\n`, () => false);
    assert.equal(items[0].message, 'Bob: Hi\nEnd\nAlice:');
    const empty = [];
    appendTextSystemMessage(empty, 'End', '\nAlice:', text => `${text}\n`, () => false);
    assert.equal(empty[0].message, 'End\n\nAlice:');
});

test('final Narrator message merges even when it is not an extension injection', async () => {
    const f = await fixture('textgenerationwebui');
    f.extension_settings.impersonate_swap = { endContextEnabled: true, endContextPrompt: 'End' };
    await f.start();
    f.context.impersonateSwapInterceptor([{ mes: 'Narration', is_user: false, extra: { type: 'narrator' } }], 4096, () => {}, 'impersonate');
    const data = { finalMesSend: [{ message: '<system>\nNarration</system>\n<assistant>', extensionPrompts: [], injected: false }] };
    await f.emit('GENERATE_BEFORE_COMBINE_PROMPTS', data);
    assert.equal(data.finalMesSend[0].message, '<system>\nNarration\n\nEnd</system>\n<assistant>');
    await f.emit('GENERATE_AFTER_DATA');
});

test('end prompt works with the installed ST Instruct formatter, including wrapping and name cues', async t => {
    let source;
    try {
        source = await readFile(new URL('../../../../instruct-mode.js', import.meta.url), 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        t.skip('Optional check requires installation inside SillyTavern');
        return;
    }
    function extract(name) {
        const start = source.indexOf(`export function ${name}(`);
        assert.ok(start >= 0);
        return source.slice(start, source.indexOf('\n/**', start)).replace('export function', 'function');
    }
    for (const wrap of [false, true]) {
        for (const names of [0, 1]) {
            for (const suffix of ['\n', '</turn>']) {
                const settings = {
                    wrap, names_behavior: names, input_sequence: '<user>', output_sequence: '<assistant>',
                    last_input_sequence: '<assistant>', system_sequence: '<system>', system_suffix: suffix,
                    input_suffix: suffix, output_suffix: suffix, macro: false,
                };
                const context = vm.createContext({
                    structuredClone, power_user: { instruct: settings }, selected_group: null,
                    names_behavior_types: { ALWAYS: 1, FORCE: 2 }, force_output_sequence: { FIRST: 1, LAST: 2 },
                });
                vm.runInContext(extract('formatInstructModeChat') + '\n' + extract('formatInstructModePrompt'), context);
                const format = text => context.formatInstructModeChat('', text, false, true, '', 'Alice', 'Bob', false);
                const cue = context.formatInstructModePrompt('Alice', true, '', 'Alice', 'Bob', false, false);
                const body = format('Note').replace(/\n?$/, '');
                const items = [{ message: body + cue, extensionPrompts: [], injected: true }];
                appendTextSystemMessage(items, 'End', cue, format, () => true);
                assert.equal(items[0].message, format('Note\n\nEnd').replace(/\n?$/, '') + cue);
            }
        }
    }
});

test('prompt editors retain saved text and dim/disable with their own switch or master switch', async () => {
    class Element {
        children = [];
        style = {};
        listeners = {};
        queries = {};
        append(...nodes) { this.children.push(...nodes); }
        setAttribute() {}
        addEventListener(event, callback) { this.listeners[event] = callback; }
        querySelector(selector) { return this.queries[selector] ??= new Element(); }
    }
    const root = new Element();
    const document = { createElement: () => new Element(), createTextNode: text => ({ textContent: text }), getElementById: () => root };
    const f = await fixture('openai', document);
    f.extension_settings.impersonate_swap = { systemOverwritePrompt: 'Saved overwrite', endContextPrompt: 'Saved end' };
    f.render();
    const panel = root.children[0];
    const sections = panel.querySelector('.inline-drawer-content').children;
    assert.equal(sections.length, 2);
    for (const section of sections) {
        const [label, textarea] = section.children;
        const toggle = label.children[0];
        assert.equal(textarea.disabled, true);
        assert.equal(textarea.style.opacity, '0.45');
        assert.ok(textarea.value.startsWith('Saved'));
        toggle.checked = true;
        toggle.listeners.change();
        assert.equal(textarea.disabled, false);
        assert.equal(textarea.style.opacity, '1');
        textarea.value = 'Edited';
        textarea.listeners.input();
        toggle.checked = false;
        toggle.listeners.change();
        assert.equal(textarea.value, 'Edited');
        assert.equal(textarea.disabled, true);
        toggle.checked = true;
        toggle.listeners.change();
    }
    const master = panel.querySelector('.impersonate-swap-options').children[0].children[0];
    master.checked = false;
    master.listeners.change();
    assert.ok(sections.every(section => section.children[1].disabled));
    master.checked = true;
    master.listeners.change();
    assert.ok(sections.every(section => !section.children[1].disabled));
    assert.equal(f.extension_settings.impersonate_swap.systemOverwritePrompt, 'Edited');
    assert.equal(f.extension_settings.impersonate_swap.endContextPrompt, 'Edited');
});
