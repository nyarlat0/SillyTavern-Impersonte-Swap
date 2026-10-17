export const defaults = Object.freeze({ enabled: true, history: true, system: true, context: true, contextDescriptions: true,
    character: false, persona: false, scenario: false, lore: false, authorsNote: false,
    endContextEnabled: false, endContextPrompt: '', systemOverwriteEnabled: false, systemOverwritePrompt: '',
    responseTokensEnabled: false, responseTokens: 256, stoppingStringsEnabled: false, stoppingStrings: '' });

export function validResponseTokens(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function parseStoppingStrings(value) {
    const text = String(value ?? '');
    const values = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/);
    if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) {
        throw new Error('Stopping strings: ожидаются строки или JSON-массив строк.');
    }
    return [...new Set(values.filter(item => item.length > 0))];
}

export function overrideResponseTokens(data, limit) {
    if (!validResponseTokens(limit)) return;
    // All aliases in the outgoing request must agree, including llama.cpp/Ollama.
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_new_tokens', 'max_length', 'n_predict', 'num_predict']) {
        if (Object.hasOwn(data, key)) data[key] = Number(limit);
    }
}

export function joinPromptText(before, after) {
    return before ? `${before}\n\n${after}` : after;
}

function joinSystemContent(before, after) {
    if (!Array.isArray(before) && !Array.isArray(after)) return joinPromptText(before ?? '', after ?? '');
    const parts = value => Array.isArray(value) ? value : (value ? [{ type: 'text', text: value }] : []);
    return [...parts(before), { type: 'text', text: '\n\n' }, ...parts(after)];
}

export function appendSystemMessage(chat, text) {
    if (!text.trim()) return;
    let start = chat.length;
    while (start > 0 && chat[start - 1].role === 'system') start--;
    if (start === chat.length) {
        chat.push({ role: 'system', content: text });
        return;
    }
    const merged = { ...chat[start] };
    for (let i = start + 1; i < chat.length; i++) {
        merged.content = joinSystemContent(merged.content, chat[i].content);
    }
    merged.content = joinSystemContent(merged.content, text);
    chat.splice(start, chat.length - start, merged);
}

/** Collapse the terminal system run into one formatted turn, before the response cue. */
export function appendTextSystemMessage(items, text, cue, formatSystem, canMergeSystem,
    { recognizeFrames = true, trimFinalNewline = true } = {}) {
    if (!text.trim()) return;
    const formatFinal = value => trimFinalNewline ? formatSystem(value).replace(/\n?$/, '') : formatSystem(value);
    const last = items.at(-1);
    if (!last) {
        items.push({ message: formatFinal(text) + cue, extensionPrompts: [] });
        return;
    }
    const cueIndex = cue ? last.message.lastIndexOf(cue) : last.message.length;
    if (cueIndex < 0) throw new Error('Impersonate Swap: cannot locate the final response cue');
    const body = last.message.slice(0, cueIndex);
    const tail = last.message.slice(cueIndex);
    const marker = '__IMPERSONATE_SWAP_SYSTEM_CONTENT__';
    const [prefix, rawSuffix] = formatSystem(marker).split(marker);
    const suffix = rawSuffix.trimEnd();

    function takeSystemEnd(value, item) {
        const trimmed = value.trimEnd();
        const trailing = value.slice(trimmed.length);
        // Explicit, distinct role markers also identify a system turn inside a combined item.
        // If the template shares role markers or has no closing token, require role evidence.
        if (recognizeFrames && prefix && suffix) {
            const start = trimmed.lastIndexOf(prefix);
            const contentStart = start + prefix.length;
            if (start < 0 || !trimmed.endsWith(suffix)) return null;
            const end = trimmed.length - suffix.length;
            // A user/assistant turn after this system turn is a barrier, even with a shared end token.
            if (trimmed.indexOf(suffix, contentStart) !== end) return null;
            return { head: value.slice(0, start), content: value.slice(contentStart, end), ending: suffix + trailing };
        }
        if (canMergeSystem(item, value) && trimmed.startsWith(prefix) && trimmed.endsWith(suffix)) {
            return { head: '', content: trimmed.slice(prefix.length, suffix ? -suffix.length : undefined), ending: suffix + trailing };
        }
        return null;
    }

    const contents = [];
    let index = items.length - 1;
    let remaining = body;
    let ending;
    const consumed = [];
    while (true) {
        const frame = takeSystemEnd(remaining, items[index]);
        if (!frame) break;
        ending ??= frame.ending;
        contents.unshift(frame.content);
        remaining = frame.head;
        if (remaining.trim()) continue;
        // Extension prompts inserted between items must not be crossed or reordered.
        if (index === 0 || items[index].extensionPrompts?.length) break;
        const previous = items[index - 1];
        if (!takeSystemEnd(previous.message, previous)) break;
        consumed.push(index - 1);
        remaining = previous.message;
        index--;
    }
    if (contents.length) {
        for (const consumedIndex of consumed) items[consumedIndex].message = '';
        last.message = remaining + prefix + [...contents, text].join('\n\n') + ending + tail;
    } else {
        const separator = body && !body.endsWith('\n') ? '\n' : '';
        last.message = body + separator + formatFinal(text) + tail;
    }
}

// One pass: replacements must not replace each other. Names and other macros are untouched.
export function swapMacros(text) {
    return typeof text === 'string'
        ? text.replace(/{{\s*(char|user)\s*}}/gi, (_, role) => role.toLowerCase() === 'char' ? '{{user}}' : '{{char}}')
        : text;
}

// Change template references, never the descriptions themselves or their nested macros.
export function swapContextDescriptions(text) {
    if (typeof text !== 'string') return text;
    const swapped = { persona: 'description', description: 'persona' };
    return text
        // Keep standard Handlebars guards aligned with the substituted value. In particular,
        // an empty personality must also hide a surrounding "Personality:" label.
        .replace(/({{~?\s*#(?:if|unless|with)\s+)(persona|description|personality)(\s*~?}})/gi,
            (_, prefix, field, suffix) => prefix + (swapped[field.toLowerCase()] ?? '""') + suffix)
        .replace(/({{{?~?\s*)(persona|description|personality)(\s*~?}}}?)/gi,
            (_, prefix, field, suffix) => field.toLowerCase() === 'personality' ? '' : prefix + swapped[field.toLowerCase()] + suffix);
}

export function swapHistory(chat) {
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (message.is_system || message.extra?.type === 'narrator' || message.extra?.tool_invocations?.length) continue;
        // Replace the entry, never mutate the persisted chat or its nested attachments.
        chat[i] = { ...message, is_user: !message.is_user };
    }
}

/** Temporary prompt settings, serialized as their originals if ST saves during generation. */
export class PromptTransaction {
    #undo = [];

    patch(object, changes) {
        if (!object) return;
        const entries = Object.entries(changes).filter(([key, value]) => value !== object[key]);
        if (!entries.length) return;
        const originals = entries.map(([key, value]) => [key, Object.getOwnPropertyDescriptor(object, key), value]);
        const jsonDescriptor = Object.getOwnPropertyDescriptor(object, 'toJSON');
        const previousToJSON = object.toJSON;
        const serialize = function () {
            const result = typeof previousToJSON === 'function' ? { ...previousToJSON.call(this) } : { ...this };
            for (const [key, descriptor, value] of originals) {
                if (this[key] !== value) continue;
                if (descriptor) result[key] = descriptor.value;
                else delete result[key];
            }
            return result;
        };
        Object.defineProperty(object, 'toJSON', { configurable: true, value: serialize });
        for (const [key, value] of entries) object[key] = value;
        this.#undo.push(() => {
            for (const [key, descriptor, value] of originals) {
                if (object[key] !== value) continue; // Keep edits made during generation.
                if (descriptor) Object.defineProperty(object, key, descriptor);
                else delete object[key];
            }
            if (object.toJSON === serialize) {
                if (jsonDescriptor) Object.defineProperty(object, 'toJSON', jsonDescriptor);
                else delete object.toJSON;
            }
        });
    }

    // Author's Note is composed from the textarea and per-character note by ST.
    // Transform its first assignment only, before WI/persona append their own content.
    transformNextAssignment(object, key, transform) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        let current = object[key];
        let pending = true;
        const get = () => current;
        Object.defineProperty(object, key, {
            configurable: true, enumerable: true, get,
            set(value) {
                current = pending ? transform(value) : value;
                pending = false;
            },
        });
        this.#undo.push(() => {
            if (Object.getOwnPropertyDescriptor(object, key)?.get !== get) return;
            if (descriptor) Object.defineProperty(object, key, descriptor);
            else delete object[key];
        });
    }

    restore() {
        for (const undo of this.#undo.reverse()) undo();
        this.#undo = [];
    }
}
