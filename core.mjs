export const defaults = Object.freeze({ enabled: true, history: true, system: true, context: true, contextDescriptions: true,
    character: false, persona: false, scenario: false, lore: false, authorsNote: false,
    endContextEnabled: false, endContextPrompt: '', systemOverwriteEnabled: false, systemOverwritePrompt: '' });

export function joinPromptText(before, after) {
    return before ? `${before}\n\n${after}` : after;
}

export function appendSystemMessage(chat, text) {
    if (!text.trim()) return;
    const last = chat.at(-1);
    if (last?.role !== 'system') {
        chat.push({ role: 'system', content: text });
    } else if (Array.isArray(last.content)) {
        // Preserve multimodal content and metadata; do not stringify image/audio parts.
        last.content = [...last.content, { type: 'text', text: `\n\n${text}` }];
    } else {
        last.content = joinPromptText(last.content ?? '', text);
    }
}

/** Insert before the generation cue, merging a final formatted system injection. */
export function appendTextSystemMessage(items, text, cue, formatSystem, canMergeSystem) {
    if (!text.trim()) return;
    const last = items.at(-1);
    if (!last) {
        items.push({ message: formatSystem(text) + cue, extensionPrompts: [] });
        return;
    }
    const cueIndex = cue ? last.message.lastIndexOf(cue) : last.message.length;
    if (cueIndex < 0) throw new Error('Impersonate Swap: cannot locate the final response cue');
    const body = last.message.slice(0, cueIndex);
    const tail = last.message.slice(cueIndex);
    const marker = '__IMPERSONATE_SWAP_SYSTEM_CONTENT__';
    // ST strips a final newline from the last history item before adding the response cue.
    const formatted = formatSystem(marker).replace(/\n?$/, '');
    const [prefix, suffix] = formatted.split(marker);
    if (canMergeSystem(last, body) && body.startsWith(prefix) && body.endsWith(suffix)) {
        const contentEnd = suffix ? body.length - suffix.length : body.length;
        const content = body.slice(prefix.length, contentEnd);
        last.message = prefix + joinPromptText(content, text) + suffix + tail;
    } else {
        const separator = body && !body.endsWith('\n') ? '\n' : '';
        last.message = body + separator + formatSystem(text).replace(/\n?$/, '') + tail;
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
