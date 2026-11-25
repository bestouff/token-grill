import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatText} from '../core/i18n.js';
import {displayPath} from '../core/paths.js';
import {providerMetadata} from '../core/providerMetadata.js';
import type {AccountDraft, Candidate, ProviderInstance, ProviderKind} from '../core/types.js';
import {providerIcon} from './widgets.js';

type Addable = Candidate & {kind: ProviderKind};

interface CandidateRow {
    candidate: Addable;
    check: Gtk.CheckButton;
}

function isAddable(candidate: Candidate): candidate is Addable {
    return candidate.status === 'ready' && candidate.kind !== null;
}

function where(candidate: Addable): string {
    if (candidate.app === 'opencode')
        return _('via OpenCode');
    // Translators: a service name, then where the sign-in was found.
    return formatText(_('%s - %s'), providerMetadata(candidate.kind).label, displayPath(candidate.accountHome));
}

// Found sign-ins as check rows: new ones ticked, the same plan as an existing
// account unticked with a warning, and the rest greyed out with the reason.
export class CandidateList {
    readonly group: Adw.PreferencesGroup;
    private readonly _rows: CandidateRow[] = [];
    private readonly _configured: ProviderInstance[];
    private readonly _extensionPath: string;

    constructor(candidates: Candidate[], configured: ProviderInstance[], extensionPath: string, description: string) {
        this._configured = configured;
        this._extensionPath = extensionPath;
        this.group = new Adw.PreferencesGroup({description});
        for (const candidate of candidates)
            this.group.add(isAddable(candidate) ? this._checkRow(candidate) : this._inactiveRow(candidate));
    }

    get addable(): number {
        return this._rows.length;
    }

    connectChanged(callback: (anySelected: boolean) => void): void {
        const notify = () => callback(this._rows.some(row => row.check.active));
        for (const row of this._rows)
            row.check.connect('toggled', notify);
        notify();
    }

    selected(): AccountDraft[] {
        return this._rows.filter(row => row.check.active).map(({candidate}) => ({
            kind: candidate.kind,
            app: candidate.app,
            accountHome: candidate.accountHome,
            displayName: candidate.label,
        }));
    }

    private _checkRow(candidate: Addable): Adw.ActionRow {
        const duplicate = candidate.duplicateOf ? this._configured.find(item => item.id === candidate.duplicateOf) ?? null : null;
        const check = new Gtk.CheckButton({active: !duplicate, valign: Gtk.Align.CENTER});
        const row = new Adw.ActionRow({title: candidate.label, subtitle: where(candidate), activatable_widget: check});
        // add_prefix() places each widget first, so the check box ends up before the icon.
        row.add_prefix(providerIcon(this._extensionPath, candidate.kind));
        row.add_prefix(check);
        if (duplicate) {
            const name = formatText(_('%s - %s'), providerMetadata(duplicate.kind).label, duplicate.displayName);
            row.subtitle = formatText(_('Looks like %s, which you already added'), name);
            row.add_suffix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']}));
            const choice = new Gtk.Button({label: _('Add Anyway'), valign: Gtk.Align.CENTER});
            choice.connect('clicked', () => {
                check.active = !check.active;
            });
            check.connect('toggled', () => {
                choice.label = check.active ? _('Skip') : _('Add Anyway');
            });
            row.add_suffix(choice);
        }
        this._rows.push({candidate, check});
        return row;
    }

    private _inactiveRow(candidate: Candidate): Adw.ActionRow {
        let subtitle = _('API key - nothing to track');
        if (candidate.status === 'already-added')
            subtitle = _('Already added');
        else if (candidate.status === 'uses-other-app')
            // Translators: %s is a service name, such as Kiro.
            subtitle = formatText(_("Uses the %s app's own sign-in; add it from there"), candidate.label);
        const row = new Adw.ActionRow({title: candidate.label, subtitle, sensitive: false});
        if (candidate.kind)
            row.add_prefix(providerIcon(this._extensionPath, candidate.kind));
        return row;
    }
}
