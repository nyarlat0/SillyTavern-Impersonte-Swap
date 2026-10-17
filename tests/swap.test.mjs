import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { defaults, swapMacros, swapHistory, PromptTransaction } from '../core.mjs';

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

async function fixture(api = 'openai') {
    const listeners = new Map();
    const eventSource = {
        on(key, fn) { const items = listeners.get(key) ?? []; items.push(fn); listeners.set(key, items); },
        makeFirst(key, fn) { const items = listeners.get(key) ?? []; items.unshift(fn); listeners.set(key, items); },
        makeLast(key, fn) { this.on(key, fn); },
    };
    const event_types = Object.fromEntries(['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_AFTER_DATA',
        'CHAT_COMPLETION_PROMPT_READY', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'WORLDINFO_ENTRIES_LOADED'].map(x => [x, x]));
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
    const context = vm.createContext({ console, window: { addEventListener() {} }, jQuery() {} });
    const dependencies = {
        '../../../../script.js': { eventSource, event_types, characters, chat_metadata, extension_prompts, this_chid: 0, main_api: api, saveSettingsDebounced() {} },
        '../../../extensions.js': { extension_settings },
        '../../../power-user.js': { power_user },
        '../../../group-chats.js': { groups, selected_group: 'group' },
        '../../../openai.js': { promptManager },
        './core.mjs': { defaults, swapMacros, swapHistory, PromptTransaction },
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
    return { power_user, characters, chat_metadata, extension_prompts, groups, extension_settings, promptManager, context, emit, start };
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
    assert.equal(f.power_user.context.story_string, '{{user}}: {{description}} {{char}}: {{persona}}');
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
