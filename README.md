# Impersonate Swap for SillyTavern

[Русский](README.ru.md)

Make **Impersonate** generate the next reply from your side of the conversation by swapping the user and assistant roles in the prompt sent to the model.

The model sees your previous messages as its own replies and the character's messages as incoming user turns. You can also swap `{{char}}` and `{{user}}` in selected prompt sources, with a separate switch for each source.

Your saved chat is not rewritten. The generated reply appears in the input box, ready to review and send.

## Installation

1. Copy the URL of this GitHub repository from your browser's address bar.
2. In SillyTavern, open **Extensions → Install extension**.
3. Paste the repository URL and install it.
4. Reload SillyTavern and find **Impersonate Swap** in the Extensions settings.

No Extras server, API key of its own, build step, or additional packages are required. The extension uses your existing generation connection.

For a manual installation, clone this repository into `public/scripts/extensions/third-party/impersonate-swap` inside your SillyTavern installation, then reload the page.

## Quick start

1. Open a conversation with a character and select your persona.
2. Leave **Impersonate Swap** enabled in Extensions settings.
3. Choose where to swap the name macros using the settings below.
4. Use SillyTavern's **Impersonate** action.
5. Review the generated text in the input box and send it when ready.

Normal character replies keep their usual behavior. Disable the extension's main checkbox to return to standard Impersonate.

## How it works

For Chat Completion, the history sent to the model changes like this:

| Original message | Role during Impersonate |
| --- | --- |
| Your message — `user` | `assistant` |
| Character reply — `assistant` | `user` |
| Your next reply | Generated as the next assistant response |

Message order, author names, and message text stay the same. System messages, Narrator messages, and tool-invocation records are excluded from the role swap.

Macro swapping happens before SillyTavern resolves the names. For example, a selected prompt containing:

```text
You are {{char}}. Continue the conversation with {{user}}.
```

is processed as:

```text
You are {{user}}. Continue the conversation with {{char}}.
```

The name-swap switches exchange only these two macros. Literal names such as `Alice` are not replaced. A separate Context Template option, enabled by default, exchanges `{{persona}}` and `{{description}}` and removes `{{personality}}` from the template. The saved character and persona fields stay unchanged.

## Settings

The labels in the extension settings are currently in Russian. The table includes their identifying terms.

| Setting | Default | What it changes |
| --- | --- | --- |
| Enable / «Включить Impersonate Swap» | On | Enables the extension for Impersonate only. |
| History / «в истории» | On | Swaps user/assistant roles in the outgoing history. |
| System Prompt | On | Swaps macros in the Text Completion System Prompt or Chat Completion Main Prompt, including character/chat system-prompt overrides. |
| Context Template | On | Swaps macros in Story String, Chat Start, and Example Separator. Text Completion only. |
| Context descriptions / «Менять {{persona}} ↔ {{description}}…» | On | Exchanges persona/character description references and clears personality in Context Template. Independent of the name swap; Text Completion only. |
| Character card / «в карточке» | Off | Swaps macros in description, personality, example dialogue, and character depth prompt. Includes the chat's example-dialogue override and cards used in group chats. |
| Persona / «в описании персоны» | Off | Swaps macros in the active persona description, including when it is inserted at depth or into Author's Note. |
| Scenario / «в сценарии» | Off | Swaps macros in the character scenario and the chat's scenario override. Separate from the card switch. |
| Lore / World Info | Off | Swaps macros in entry content from global, character, chat, and persona lorebooks. Entry keywords and activation settings are not rewritten. |
| Author's Note | Off | Swaps macros in the chat note and enabled character-specific note. Lore and persona additions follow their own switches. |

The description option sits immediately below the Context Template name-swap option. It applies to Story String, Chat Start, and Example Separator. Standard `{{#if …}}`, `{{#unless …}}`, and `{{#with …}}` guards for these fields follow the replacement, so a personality section guarded by `{{#if personality}}` is hidden. It does not rewrite macros inside the inserted descriptions or change Chat Completion prompts. Existing installations also get this option enabled unless explicitly disabled.

The five optional source switches default to **Off**, including when upgrading an existing installation. Settings apply on the next generation.

The card switch does not change greetings, alternate greetings, creator notes, or Post-History Instructions. System prompts have their own switch. Other custom Prompt Manager blocks and extensions' prompts are outside these switches.

## Custom impersonation prompts

Both fields have their own enable checkbox. They start empty and **Off**. Turning a field off dims and disables its editor without deleting the saved text; disabling Impersonate Swap also dims both editors. Changes apply to the next generation. An empty or whitespace-only field has no effect, even when enabled.

### System Prompt Overwrite

Replaces the main system instruction for Impersonate, taking priority over the preset and character/chat system-prompt overrides. In Chat Completion it replaces Main Prompt and uses the `system` role. In Text Completion it temporarily enables the System Prompt and bypasses the character-prompt preference; the Context Template must include `{{system}}` to render it.

This does not replace the entire context: descriptions, history, Author's Note, Post-History Instructions, and other prompt blocks remain separate.

Example:

```text
Write the next reply as {{user}}. Use their established voice and knowledge.
Respond to {{char}} without writing dialogue or actions for them.
```

### End-Context System Prompt

Adds a final system instruction after the assembled context. If the last Chat Completion message is already `system`, the text is appended to that message after a blank line; otherwise a new `system` message is added. This includes a final system Author's Note.

For Text Completion, it is inserted before the final response cue using the Instruct template's system format, and appended to a final system injection when its formatting matches. A plain-text template has no API roles, so it uses SillyTavern's plain narrator format.

Example:

```text
Write only {{user}}'s next message. Do not include a speaker label or explain your answer.
```

These fields are written specifically for impersonation. Standard SillyTavern macros are expanded, but the automatic `{{char}}` / `{{user}}` swap is **not** applied to their text. The two fields work independently and affect only Impersonate.

The end-context prompt is inserted after SillyTavern selects history to fit its token budget. Leave space in the context budget for this text, especially for long instructions; the extension does not retrim history after appending it.

## Compatibility and limitations

- **Chat Completion:** swaps API roles and suppresses SillyTavern's standard Impersonate instruction when history swapping is enabled.
- **Text Completion with Instruct:** swaps history formatting and opens an assistant response using the user's name where the template includes names.
- **Text Completion without Instruct:** the prompt contains named dialogue rather than API roles. The final cue remains the user's name; the effect also depends on your system/context templates.
- **Prompt previews:** SillyTavern skips generation interceptors during dry-run token estimates. Swapping is also skipped there, so inspect the actual generated request to verify the result.
- **Other extensions:** extensions that rewrite the same templates, history, or Author's Note may affect the result. Source swapping uses temporary prompt settings, so overlapping prompt-building operations are not guaranteed to be isolated.
- **Model behavior:** a model can still follow conflicting instructions or literal names in your prompts. Swapping macros does not rewrite the meaning of descriptive prose.

The implementation uses SillyTavern's generation events, generation interceptor, World Info entries event, and Prompt Manager. Compatibility is tied to those interfaces; no minimum supported release has been established. Automated checks cover the integration with stubs, not live model requests across providers.

## Troubleshooting

**The model still writes as the character.** Check that history swapping is enabled. Inspect the actual outgoing prompt for conflicting literal names, character descriptions, or Post-History Instructions. Enable the optional source switches where appropriate.

**Nothing changes in the prompt preview.** Dry-run previews are unchanged. Compare the request from an actual Impersonate generation.

**A name in a lorebook did not change.** Only `{{char}}` and `{{user}}` in entry content are swapped. Literal names and activation keywords are preserved. The entry must still activate normally.

**The settings panel is missing.** Reload the page, check that the extension is enabled in SillyTavern, and inspect the browser console for loading errors.

When reporting a problem through this repository's Issues tab, include your SillyTavern version, API type, Instruct mode if applicable, enabled switches, and a minimal anonymized prompt example.

## Updating and uninstalling

Use SillyTavern's extension manager to check for updates, update, or uninstall the extension. Reload the page afterward. For a manual Git installation, run `git pull` in the extension directory to update.

## Development

Run from the extension directory with Node.js:

```sh
node --experimental-vm-modules tests/swap.test.mjs
node --check index.js
node --check core.mjs
```

Tests cover role and macro swapping, independent source switches, group cards, lore sources, Author's Note composition, restoration, and serialization of original settings during prompt construction. The VM modules flag may produce an experimental-feature warning.

## License

This project is released under [The Unlicense](LICENSE).
