// Core modules import no Shell or GTK module, and only core/gio.ts and
// core/paths.ts import GLib or Gio, so the rest runs under node tests.
// Callers in the Shell and preferences pass in the real gettext functions;
// strings stay extractable because every call site uses `_()` / `ngettext()`.
export interface Translator {
    _: (text: string) => string;
    ngettext: (singular: string, plural: string, count: number) => string;
}

// Replaces `%s` / `%d` placeholders in order, matching GJS String.prototype.format.
export function formatText(template: string, ...values: Array<string | number>): string {
    let index = 0;
    return template.replace(/%[sd%]/g, token => {
        if (token === '%%')
            return '%';
        return String(values[index++] ?? '');
    });
}
