export const defaults = Object.freeze({ enabled: true, history: true, system: true, context: true });

// One pass: replacements must not replace each other. Names and other macros are untouched.
export function swapMacros(text) {
    return typeof text === 'string'
        ? text.replace(/{{\s*(char|user)\s*}}/gi, (_, role) => role.toLowerCase() === 'char' ? '{{user}}' : '{{char}}')
        : text;
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

    restore() {
        for (const undo of this.#undo.reverse()) undo();
        this.#undo = [];
    }
}
