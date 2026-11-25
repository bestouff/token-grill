import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

// Account colours are the user's data, including custom ones, so dots are drawn rather than styled.
test('provider marks use fixed geometry and drawn accent dots', async () => {
    const source = await read('src/shell/accountChip.ts');
    assert.match(source, /new Clutter\.FixedLayout\(\)/);
    assert.match(source, /y_align: Clutter\.ActorAlign\.CENTER/);
    assert.match(source, /const MARK_DOT_SIZE = 6/);
    assert.match(source, /accentRgb\(instance\.accent\)/);
    assert.match(source, /new St\.DrawingArea\(/);
    assert.match(source, /cr\.\$dispose\(\)/);
    assert.doesNotMatch(source, /set_style\(|style: `/);
});

test('the popup is built from native shell menu items and theme styles', async () => {
    const [indicator, detail] = await Promise.all([
        read('src/shell/indicator.ts'),
        read('src/shell/providerCard.ts'),
    ]);
    assert.match(indicator, /new PopupMenu\.PopupSwitchMenuItem\(_\('Automatic Updates'\)/);
    assert.match(indicator, /if \(Main\.sessionMode\.allowSettings\)\s*menu\.addAction\(_\('Preferences...'\)/);
    assert.match(indicator, /new PopupMenu\.PopupSeparatorMenuItem\(\)/);
    assert.match(indicator, /ngettext\('Refreshing %d Account...', 'Refreshing %d Accounts...', busy\)/);
    assert.match(indicator, /this\._addRow\(groups\.map/);
    assert.doesNotMatch(indicator, /add_style_class_name\('default'\)/, 'only one level may use a strong selected style');
    assert.doesNotMatch(indicator, /tokengrill-boxpointer|set_clip_to_allocation|Safely|try \{/);
    assert.match(detail, /new BarLevel\.BarLevel\(\{\s*style_class: 'slider tokengrill-meter'/);
    assert.match(detail, /PopupMenu\.Ornament\.CHECK : PopupMenu\.Ornament\.NONE/);
    assert.match(detail, /new PopupMenu\.PopupSubMenuMenuItem\(_\('Reset Credits'\)/);
    assert.match(detail, /class ProviderDetail extends PopupMenu\.PopupMenuSection/);
    for (const source of [indicator, detail])
        assert.doesNotMatch(source, /vertical: true/);
});

const FIXED_COLOUR_SELECTORS = /tokengrill-accent-|tokengrill-(flat-)?toggle|tokengrill-panel-meter|tokengrill-meter|tokengrill-warning|tokengrill-critical/;

const RGB_COLOUR_SELECTORS = /tokengrill-(flat-)?toggle|tokengrill-meter\.tokengrill-(warning|critical)/;

test('the stylesheet keeps fixed colours to accent dots, toggle tints, meters and danger colours', async () => {
    const css = await read('resources/stylesheet.css');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of rules.match(/[^{}]+\{[^}]*\}/g)) {
        const [selector] = rule.split('{');
        if (/#[0-9a-f]{3,8}\b/i.test(rule))
            assert.match(selector, FIXED_COLOUR_SELECTORS, `hex colour outside accent, toggle, meter and danger rules: ${selector.trim()}`);
        if (/\brgba?\(/i.test(rule))
            assert.match(selector, RGB_COLOUR_SELECTORS, `rgb colour outside toggle and meter danger rules: ${selector.trim()}`);
    }
    assert.doesNotMatch(rules, /\bhsla?\(|font-family/);
    assert.doesNotMatch(css, /Hallmark|\.ts\b/);
    assert.match(rules, /-st-accent-color/);
});

test('the chooser mirrors AdwToggleGroup with radio semantics, pseudo-class states and a focus ring', async () => {
    const [toggle, indicator, css] = await Promise.all([
        read('src/shell/toggleGroup.ts'),
        read('src/shell/indicator.ts'),
        read('resources/stylesheet.css'),
    ]);
    assert.match(toggle, /accessible_role: Atk\.Role\.RADIO_BUTTON/);
    assert.match(toggle, /checked: item\.checked/);
    assert.doesNotMatch(toggle, /key-press-event|set_style|notify::hover/);
    assert.match(indicator, /St\.Settings\.get\(\)\.high_contrast/);
    assert.match(indicator, /tokengrill-light/);
    for (const state of ['hover', 'active', 'checked', 'focus'])
        assert.match(css, new RegExp(`\\.tokengrill-toggle:${state}`));
    assert.match(css, /\.tokengrill-flat-toggle:focus \{ border-color: st-transparentize\(-st-accent-color, 0\.5\); \}/);
});

test('the account chooser groups providers and wraps their accounts', async () => {
    const source = await read('src/shell/indicator.ts');
    assert.match(source, /accountGroups\(accounts, current\?\.id \?\? '', state\.snapshots\)/);
    assert.match(source, /const SHORT_NAME_LENGTH = 9/);
    assert.match(source, /<= SHORT_NAME_LENGTH\) \? 3 : 2/);
    assert.match(source, /start \+= perRow/);
    assert.match(source, /segment\.id === focusedId/);
    assert.match(source, /this\._lastByKind/);
    assert.doesNotMatch(source, /St\.ScrollView|FlowLayout|_choiceId/);
});

test('refresh progress uses the native shell spinner and UI uses centralized packaged marks', async () => {
    const [dashboard, widgets, chip, metadata] = await Promise.all([
        read('src/shell/providerCard.ts'),
        read('src/prefs/widgets.ts'),
        read('src/shell/accountChip.ts'),
        read('src/core/providerMetadata.ts'),
    ]);
    assert.match(dashboard, /new Animation\.Spinner\(16, \{animate: true, hideOnStop: true\}\)/);
    assert.doesNotMatch(dashboard, /rotation-angle-z/);
    assert.match(widgets, /Gio\.FileIcon\.new\(file\)/);
    assert.match(widgets, /providerIconFile\(kind\)/);
    for (const kind of ['codex', 'claude', 'kiro', 'antigravity', 'copilot', 'opencode-go', 'deepseek', 'kimi', 'cursor'])
        assert.match(metadata, new RegExp(`iconFile: '${kind}-symbolic\\.svg'`));
    assert.match(chip, /Gio\.icon_new_for_string\(`\$\{extensionPath\}\/icons\/providers\/\$\{providerIconFile\(kind\)\}`\)/);
});

test('Kiro details are monthly-only and show precise credits', async () => {
    const [dashboard, model, names] = await Promise.all([read('src/shell/providerCard.ts'), read('src/core/popupModel.ts'), read('src/core/display.ts')]);
    assert.match(names, /return _\('Monthly'\)/);
    // Before the first reading, rows come from the limits the service is known to have.
    assert.match(dashboard, /providerMetadata\(instance\.kind\)\.quotaWindows\.map/);
    assert.match(model, /_\('%s of %s credits'\), used, formatQuotaNumber\(window\.limit\)/);
    assert.match(model, /pooled or unlimited/);
});

test('local history is offered only for the service app of an account', async () => {
    const account = await read('src/prefs/accountPage.ts');
    assert.match(account, /if \(metadata\.localHistorySupported && provider\.app === metadata\.apps\[0\]\) \{/);
});

test('provider HTTP requests are bounded and cannot follow redirects', async () => {
    const source = await read('src/providers/base.ts');
    assert.match(source, /Soup\.MessageFlags\.NO_REDIRECT/);
    assert.match(source, /MAX_RESPONSE_BYTES = 1024 \* 1024/);
    assert.match(source, /uri\.get_scheme\(\) !== 'https'/);
    assert.match(source, /ALLOWED_HOSTS\.has\(host\)/);
    assert.match(source, /\.\.\.KIRO_SERVICE_HOSTS/);
    assert.doesNotMatch(source, /'User-Agent'/);
    assert.match(source, /const status = message\.status_code;/, 'GJS throws for status codes missing from Soup.Status, such as 429');
    assert.doesNotMatch(source, /get_status\(\)\s*;/);
    assert.match(source, /export const USER_AGENT = 'TokenGrill \(\+https:\/\/github\.com\/sh02sahil\/token-grill; [^']*Antigravity[^']*\)'/);
});

test('persisted state uses private permissions and bounded regular files', async () => {
    const source = await read('src/storage/atomicJson.ts');
    assert.match(source, /Gio\.FileType\.REGULAR/);
    assert.match(source, /MAX_STATE_BYTES = 4 \* 1024 \* 1024/);
    assert.match(source, /info\.get_size\(\) > MAX_STATE_BYTES/);
    assert.match(source, /Gio\.FileCreateFlags\.PRIVATE/);
    assert.match(source, /set_attribute_uint32\('unix::mode', 0o600\)/);
    assert.match(source, /set_attributes_async/);
    assert.doesNotMatch(source, /GLib\.chmod|replace_contents\(/);
});

// The service decides when an alert is due, so the Shell keeps no milestone state.
test('notifications keep no alert state of their own', async () => {
    const [source, policy] = await Promise.all([read('src/shell/notifications.ts'), read('src/core/notificationPolicy.ts')]);
    assert.match(source, /export class Notifier/);
    assert.doesNotMatch(source, /storage\/|SerialWriter|readJson|checkMilestone|lowBalance|flush\(/);
    assert.doesNotMatch(policy, /checkMilestone|shouldNotify|nextCheckpoint|migrateNotificationState|parseTestNotificationRequest/);
});

test('notifications use per-account sources with symbolic icons and lifecycle cleanup', async () => {
    const [notification, runtime] = await Promise.all([
        read('src/shell/notifications.ts'),
        read('src/runtime.ts'),
    ]);
    assert.doesNotMatch(notification, /Main\.notify\(/);
    assert.match(notification, /new MessageTray\.Source\(\{title, icon\}\)/);
    assert.match(notification, /existing\.title = title;/);
    assert.match(notification, /new MessageTray\.Notification/);
    assert.match(notification, /providerGicon\(this\._extensionPath, instance\.kind\)/);
    assert.doesNotMatch(notification, /EmblemedIcon|BytesIcon|<svg|accentColor|catch\(\(\) => \{\}\)/);
    assert.match(notification, /this\._sourceFor\(instance, text\.source\)/);
    assert.doesNotMatch(notification, / - Token Grill/);
    assert.match(notification, /private readonly _sources = new Map<string, MessageTray\.Source>\(\)/);
    assert.match(notification, /source\.connect\('destroy', \(\) => this\._sources\.delete\(instance\.id\)\)/);
    assert.match(notification, /source\.destroy\(MessageTray\.NotificationDestroyedReason\.SOURCE_CLOSED\)/);
    assert.match(runtime, /new Notifier\(extension\.path\)/);
    assert.match(runtime, /alertText\(TRANSLATOR, alert, instance,/);
    assert.match(runtime, /get_string\('panel-percentage-mode'\) === 'used'/);
    assert.match(runtime, /this\._notifier!\.destroy\(\)/);
});

test('provider preferences use direct editing, confirmed deletion, and normalized reorder controls', async () => {
    const [page, editor, reorder, general] = await Promise.all([
        read('src/prefs/accountsPage.ts'),
        read('src/prefs/accountPage.ts'),
        read('src/prefs/reorderDialog.ts'),
        read('src/prefs/generalPage.ts'),
    ]);
    // Each account row opens its page; the row itself is the keyboard target.
    assert.match(page, /activatable: true/);
    assert.match(page, /row\.connect\('activated', \(\) => this\._edit\(provider\)\)/);
    assert.match(page, /icon_name: 'go-next-symbolic'/);
    assert.match(page, /setAccessibleLabel\(enabled, enabledLabel\)/);
    assert.doesNotMatch(page, /Gtk\.MenuButton|view-more-symbolic|_overflow\(/);
    assert.match(page, /label: _\('Add Account...'\)/);
    assert.match(page, /new AddAccountDialog\(/);
    assert.match(page, /client => client\.reorderAccounts\(ordered\.map\(provider => provider\.id\)\)/);
    // The account page applies each change at once, so there is nothing to discard.
    assert.match(editor, /new Adw\.ButtonRow\(\{title: _\('Remove Account'\)/);
    assert.match(editor, /remove\.add_css_class\('destructive-action'\)/);
    assert.match(editor, /heading: _\('Remove Account\?'\)/);
    assert.match(editor, /if \(response !== 'remove'\)/);
    assert.match(page, /this\._context\.window\.push_subpage\(new AccountPage\(this\._context, provider\)\)/);
    assert.match(general, /new Adw\.ToggleGroup/);
    assert.match(reorder, /new Gtk\.DragSource/);
    assert.match(reorder, /Gtk\.DropTarget\.new/);
    assert.match(reorder, /go-up-symbolic/);
    assert.match(reorder, /go-down-symbolic/);
    for (const source of [page, editor, reorder, general])
        assert.doesNotMatch(source, /\.get_children\(\)|set_cursor_from_name|\?\.\(/);
});

test('local history shows real figures or its scan state, and nothing when unsupported', async () => {
    const [model, metrics] = await Promise.all([read('src/core/popupModel.ts'), read('src/core/historyMetrics.ts')]);
    assert.match(model, /at API prices/);
    assert.match(model, /case 'unsupported':\s*case 'off':\s*return null;/);
    assert.match(metrics, /export type HistoryState = 'unsupported' \| 'off' \| 'waiting' \| 'updating' \| 'failed' \| 'ready'/);
    assert.doesNotMatch(metrics, /TOKENS|USD|Waiting.../);
});

test('the test notification is asked of the service', async () => {
    const prefs = await read('src/prefs/notificationsPage.ts');
    assert.match(prefs, /title: _\('Send Test Notification'\)/);
    assert.match(prefs, /client => client\.sendTestAlert\(provider\.id\)/);
    assert.match(prefs, /provider\.enabled \? provider\.displayName/);
});

async function sourceFiles(directory) {
    const entries = await readdir(new URL(`../../${directory}`, import.meta.url), {withFileTypes: true, recursive: true});
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
        .map(entry => `${entry.parentPath ?? entry.path}/${entry.name}`.replace(/^.*?\/src\//, 'src/'));
}

// Preferences ask the service: they read no sign-in, keyring, database or state file themselves.
test('Preferences import nothing of the collectors, stores, keyring or databases', async () => {
    const files = ['src/prefs.ts', ...await sourceFiles('src/prefs')];
    assert.ok(files.length > 10);
    for (const file of files) {
        const source = await read(file);
        assert.doesNotMatch(source, /from '[./]*\/(providers|storage)\//, file);
        assert.doesNotMatch(source, /gi:\/\/(Secret|Gda)/, file);
        assert.doesNotMatch(source, /provider-instances-json|PROVIDERS_KEY|readProviders|writeProviders|migrateProviderSettings/, file);
        assert.doesNotMatch(source, /refresh-interval-seconds|notifications-enabled|notification-step-percent|diagnostics-journal/, file);
        assert.doesNotMatch(source, /logError\(/, file);
    }
    for (const gone of ['discovery', 'sources', 'credentialStatus', 'providerValidation', 'keyStore'])
        await assert.rejects(read(`src/prefs/${gone}.ts`), {code: 'ENOENT'}, gone);
});

test('no source writes the old test notification request', async () => {
    for (const file of await sourceFiles('src'))
        assert.doesNotMatch(await read(file), /notification-test-request/, file);
});

// One client per window: Goodbye tells the service that Preferences closed.
test('each Preferences window has its own service client, released on close', async () => {
    const [entry, context] = await Promise.all([read('src/prefs.ts'), read('src/prefs/context.ts')]);
    assert.match(entry, /new ServiceClient\('prefs', handlers, logger\)/);
    const close = entry.slice(entry.indexOf("window.connect('close-request'"));
    assert.match(close, /^window\.connect\('close-request', \(\) => \{\s*context\.client\.destroy\(\);\s*context\.destroy\(\);/);
    assert.match(entry, /context\.client\.connect\(\)/);
    // The banner stands in for the pages until the service answers.
    assert.match(entry, /new ServicePage\(\(\) => context\.client\.retry\(\)\)/);
    assert.match(entry, /status === 'connected'/);
    assert.match(context, /if \(this\.client\.status !== 'connected' \|\| cancellable\.is_cancelled\(\)\)\s*return;/);
    assert.match(context, /if \(this\._stopped\(cancellable\)\)\s*return;/);
    assert.match(context, /this\.cancellable\.cancel\(\);/);
});

test('Preferences read and write the moved settings through the service', async () => {
    const [general, notifications, widgets, accounts] = await Promise.all([
        read('src/prefs/generalPage.ts'), read('src/prefs/notificationsPage.ts'), read('src/prefs/widgets.ts'), read('src/prefs/accountsPage.ts'),
    ]);
    assert.match(general, /bindServiceNumber\(context, 'refreshIntervalSeconds', interval\)/);
    assert.match(notifications, /bindServiceNumber\(context, 'alertStepPercent', step\)/);
    assert.match(notifications, /bindServiceSwitch\(context, 'alertsEnabled', enabled\)/);
    assert.match(widgets, /client => client\.setSettings\(patch\)/);
    // The look stays in GSettings.
    for (const key of ['panel-display-style', 'panel-percentage-mode', 'panel-position', 'popup-account-picker'])
        assert.match(general, new RegExp(`key: '${key}'`));
    assert.match(accounts, /credentialLabel\(TRANSLATOR, state\)/);
    assert.match(accounts, /client => client\.credentialState\(provider\.id\)/);
});

test('a key that the keyring did not save shows the 0.4.1 alert', async () => {
    const [add, account, widgets] = await Promise.all([
        read('src/prefs/addAccountDialog.ts'), read('src/prefs/accountPage.ts'), read('src/prefs/widgets.ts'),
    ]);
    // One call: the service stores the key before it adds the account, so nothing is left half done.
    assert.match(add, /client => client\.addAccounts\(\[\{\.\.\.KEY_DRAFT, apiKey: key\}\]\)/);
    assert.doesNotMatch(add, /saveApiKey|removeAccount/);
    assert.match(account, /client => client\.saveApiKey\(this\._provider\.id, key\)/);
    assert.match(widgets, /heading: _\('Could Not Save the Key'\), body: _\('The system keyring did not save the key\.'\)/);
    assert.match(account, /client\.removeAccount\(this\._provider\.id, this\._provider\.app === 'keyring'\)/);
});

// The collectors, stores and scheduler live in the service; the Shell only shows what it sends.
test('the runtime drives the popup from the service client', async () => {
    const [entry, source] = await Promise.all([read('src/extension.ts'), read('src/runtime.ts')]);
    assert.doesNotMatch(source, /from '\.\/(providers|storage)\//);
    assert.doesNotMatch(source, /gi:\/\/Soup|Scheduler|createCollectors|SerialWriter/);
    assert.match(source, /new ServiceClient\('shell', \{/);
    assert.match(source, /this\._client!\.connect\(\)/);
    assert.match(source, /if \(status === 'connected'\)[\s\S]*this\._migrate\(\)/);
    assert.match(source, /migrateOnce\(this\._settings!, this\._client!\)/);
    assert.match(source, /Main\.panel\.addToStatusArea\(this\._extension\.uuid, this\._indicator, 1, side\)/);
    assert.match(entry, /this\._runtime = new Runtime\(this\);\s*this\._runtime\.start\(\);/);
    assert.match(entry, /this\._runtime\?\.stop\(\);\s*this\._runtime = null;/);
    assert.doesNotMatch(source + entry, /sessionMode\.connect|setLocked|pause-when-session-locked/);
    assert.doesNotMatch(source, /notification-test-request|refresh-interval-seconds|notifications-enabled/);
});

test('popup actions go to the service and their replies are dropped after disable', async () => {
    const source = await read('src/runtime.ts');
    assert.match(source, /client => client\.refreshAll\(\)/);
    assert.match(source, /client => client\.refresh\(providerId\)/);
    assert.match(source, /client => client\.toggleLimit\(providerId, key\)/);
    assert.match(source, /client => client\.setAutomatic\(providerId, on\)/);
    assert.match(source, /client => client\.setPaused\(paused\)/);
    assert.match(source, /client\.signInCommand\(providerId\)/);
    assert.match(source, /openSignIn\(argv, env\)/);
    const request = source.slice(source.indexOf('private _request('));
    // A switch the user moved while the service is away goes back to what it last sent.
    assert.match(request, /if \(client\.status !== 'connected'\) \{\s*this\._render\(\);\s*return;\s*\}/);
    assert.match(request, /if \(cancellable\.is_cancelled\(\)\)\s*return;/);
});

// Without the service the popup shows how to install, update or restart it instead of the accounts.
test('the popup shows the service card while the service is not connected', async () => {
    const [runtime, indicator, card] = await Promise.all([
        read('src/runtime.ts'), read('src/shell/indicator.ts'), read('src/shell/serviceCard.ts'),
    ]);
    assert.doesNotMatch(runtime, /withCodeErrorText/);
    assert.match(runtime, /service: this\._client!\.status,/);
    assert.match(runtime, /checkService\(\): void \{\s*this\._client!\.retry\(\);/);
    assert.match(indicator, /new ServiceCard\(\(\) => controller\.checkService\(\)\)/);
    assert.match(indicator, /serviceCard\.update\(state\.service\)/);
    assert.match(indicator, /serviceCard\.failure === 'not-responding'/);
    assert.match(indicator, /detail\.setDimmed\(/);
    assert.match(card, /class ServiceCard extends StaticMenuItem/);
    assert.match(card, /GTypeName: 'TokenGrillServiceCard'/);
    assert.match(card, /this\._box\.destroy_all_children\(\)/);
    assert.match(card, /can_focus: true/);
});

// 0.4.1 put the account home in argv through env; the service now returns it as a dictionary.
test('sign-in passes the account home through env without a shell', async () => {
    const source = await read('src/shell/signIn.ts');
    assert.match(source, /export function openSignIn\(argv: string\[\], env: Record<string, string>\)/);
    assert.match(source, /\['env', \.\.\.assignments, \.\.\.argv\]/);
    assert.match(source, /GLib\.shell_quote\(arg\)/);
    assert.match(source, /Gio\.AppInfoCreateFlags\.NEEDS_TERMINAL/);
});

test('UI signals are disconnected and owned actors are released', async () => {
    const [dashboard, indicator] = await Promise.all([
        read('src/shell/providerCard.ts'),
        read('src/shell/indicator.ts'),
    ]);
    // Child actors are destroyed with their parent, so only long-lived emitters are disconnected.
    assert.match(dashboard, /this\._refreshButton\.connectObject\('clicked', \(\) => onRefresh\(\), this\._refreshButton\)/);
    assert.match(indicator, /this\._box\.destroy_all_children\(\)/);
    assert.match(indicator, new RegExp([
        String.raw`this\._themeContext!\.disconnect\(this\._themeChangedId!\);\s*this\._themeChangedId = null;`,
        String.raw`this\._themeContext = null;\s*this\._controller = null;\s*this\._entries\.clear\(\);`,
        String.raw`this\._ui = null;\s*super\.destroy\(\)`,
    ].join(String.raw`\s*`)));
    assert.doesNotMatch(indicator, /resetShellCursor/);
    assert.match(indicator, /\.disconnect\(this\._openStateId!\);\s*this\._openStateId = null;/);
});

test('runtime releases all lifecycle-owned references during stop', async () => {
    const source = await read('src/runtime.ts');
    const stop = source.slice(source.indexOf('    stop(): void {'), source.indexOf('\n    }\n', source.indexOf('    stop(): void {')));
    for (const name of ['client', 'notifier', 'settings', 'cancellable', 'indicator', 'settingsChangedId'])
        assert.match(stop, new RegExp(`this\\._${name} = null`));
    assert.match(stop, /this\._cancellable!\.cancel\(\);/);
    // Goodbye tells the service that this Shell client left; the Shell bus connection never closes.
    assert.match(stop, /this\._client!\.destroy\(\);\s*this\._client = null;/);
    assert.match(stop, /this\._settings!\.disconnect\(this\._settingsChangedId!?\)/);
});

test('store writes are serialized and cancellation bypasses provider failures', async () => {
    const [atomic, aggregate, checkpoint, base] = await Promise.all([
        read('src/storage/atomicJson.ts'),
        read('src/storage/aggregateStore.ts'),
        read('src/storage/checkpointStore.ts'),
        read('src/providers/base.ts'),
    ]);
    assert.match(atomic, /this\._pending = this\._pending\.then\(write, write\)/);
    assert.match(atomic, /this\._dirty = true;\s*throw error;/);
    for (const source of [aggregate, checkpoint])
        assert.match(source, /new SerialWriter\(/);
    assert.match(base, /if \(!\(error instanceof CollectorError\)\)\s*throw error/);
    assert.doesNotMatch(aggregate + checkpoint, /\.catch\(\(\) => \{\}\)/);
});

test('review artifacts exclude compiled schemas and use the pinned Shexli runner', async () => {
    const [build, install, release, checker] = await Promise.all([
        read('tools/build.mjs'),
        read('tools/install.mjs'),
        read('tools/release-check.mjs'),
        read('tools/shexli-check.mjs'),
    ]);
    assert.doesNotMatch(build, /glib-compile-schemas/);
    assert.match(install, /glib-compile-schemas/);
    assert.match(release, /gschemas\.compiled/);
    assert.match(checker, /shexli==0\.2\.1/);
    assert.match(checker, /tree-sitter==0\.25\.2/);
    assert.match(checker, /report\.summary\.finding_count/);
});

test('account paths apply only when valid, and each error stays on its own field', async () => {
    const [source, add] = await Promise.all([read('src/prefs/accountPage.ts'), read('src/prefs/addAccountDialog.ts')]);
    assert.match(source, /client => client\.validateAccount\(draft\)/);
    assert.match(source, /markField\(row, errors\[field\]\);\s*if \(errors\[field\]\)\s*return;/);
    assert.match(source, /markField\(row, errors\.displayName\)/);
    assert.match(add, /markField\(row, errors\.accountHome\)/);
});

test('nested shell inherits user settings and rejects conflicting Token Grill installs', async () => {
    const source = await read('tools/nested-shell.sh');
    assert.doesNotMatch(source, /GSETTINGS_BACKEND/);
    assert.match(source, /metadata\.uuid !== uuid/);
    assert.match(source, /Conflicting Token Grill installation/);
    assert.match(source, /wait_for_state ACTIVE/);
    assert.match(source, /^unset GDK_BACKEND$/m);
    assert.doesNotMatch(source, /gnome-extensions enable.*\|\| true/);
});

test('the diagnostics report comes from the service, is saved privately, and closing the dialog is not an error', async () => {
    const [page, widgets] = await Promise.all([read('src/prefs/dataPage.ts'), read('src/prefs/widgets.ts')]);
    assert.match(page, /client => client\.diagnosticsReport\(\)/);
    assert.match(page, /Gio\.FileCreateFlags\.PRIVATE/);
    assert.match(page, /if \(isDismissal\(error\)\)/);
    assert.match(widgets, /Gtk\.DialogError\.DISMISSED/);
});

// A plain lookup unlocks a locked match, which would show a password prompt during a background refresh.
test('keyring reads search without unlocking, and locked items count as unavailable', async () => {
    const source = await read('src/providers/keyring.ts');
    assert.match(source, /service\.search\(schema, attributes, Secret\.SearchFlags\.LOAD_SECRETS, lookup\)/);
    const code = source.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /SearchFlags\.UNLOCK|password_lookup\(|\.unlock\(/);
    assert.match(source, /items\.find\(item => !item\.get_locked\(\)\)/);
});

// EGO review of 0.3.2: Secret is always present, so it is a static import with its version (I-7).
test('Secret is imported at the top of the file, never on demand', async () => {
    const keyring = await read('src/providers/keyring.ts');
    assert.match(keyring, /^import Secret from 'gi:\/\/Secret\?version=1';$/m);
    assert.doesNotMatch(keyring, /import\('gi:\/\/Secret/);
});

test('rings stop at three', async () => {
    const topBar = await read('src/shell/topBar.ts');
    assert.match(topBar, /style === 'ring' && account\.limits\.length <= MAX_RINGS/);
});

test('a low balance is announced, not only shown as an icon', async () => {
    const source = await read('src/shell/topBar.ts');
    assert.match(source, /_\('balance low'\)/);
    assert.match(source, /function accountDescription\([\s\S]*?\n\}/);
    const body = source.match(/function accountDescription\([\s\S]*?\n\}/)[0];
    assert.match(body, /account\.low/);
});

test('a replaced popup mark is destroyed, not left for the garbage collector', async () => {
    const source = await read('src/shell/providerCard.ts');
    assert.match(source, /this\._markBin\.get_child\(\)\?\.destroy\(\);\s*this\._markBin\.set_child\(actor\);/);
});

// The keyring may show an unlock prompt, which can take longer than any fixed limit.
test('calls that store a key wait for the keyring without a time limit', async () => {
    const source = await read('src/client.ts');
    assert.match(source, /const NO_TIMEOUT = GLib\.MAXINT32;/);
    assert.match(source, /this\._invoke\('SaveApiKey', [^;]*, NO_TIMEOUT\)/);
    assert.match(source, /accounts\.some\(account => account\.apiKey !== undefined\)/);
    assert.match(source, /this\._json\('AddAccounts', accounts, pasted \? NO_TIMEOUT : CALL_TIMEOUT_MS\)/);
    assert.match(source, /proxy\.call\(method, parameters, Gio\.DBusCallFlags\.NONE, timeout, this\._cancellable\)/);
});

// Preferences opened before the Shell imported the 0.4 accounts must not show an empty list for good.
test('Preferences import the 0.4 accounts when the service connects', async () => {
    const entry = await read('src/prefs.ts');
    const connected = entry.slice(entry.indexOf('if (connected) {'));
    assert.match(connected, /^if \(connected\) \{[^}]*context\.request\(client => migrateOnce\(settings, client\)\);/);
});

test('adding waits for the service with its button off and shows a refusal', async () => {
    const [add, discover, widgets, accounts] = await Promise.all([
        read('src/prefs/addAccountDialog.ts'), read('src/prefs/discoverDialog.ts'), read('src/prefs/widgets.ts'), read('src/prefs/accountsPage.ts'),
    ]);
    assert.match(add, /busy\.sensitive = false;\s*this\._context\.request\(client => client\.addAccounts\(drafts\)/);
    assert.match(add, /this\._add\(list\.selected\(\), add\)/);
    assert.match(discover, /done\.sensitive = false;\s*context\.request\(client => client\.addAccounts\(list\.selected\(\)\)/);
    for (const source of [add, discover]) {
        assert.match(source, /presentAddError\(this, errors\)/);
        assert.doesNotMatch(source, /logger\.warn/);
    }
    assert.match(widgets, /ngettext\('Could Not Add the Account', 'Could Not Add the Accounts', count\)/);
    // A fixed path changes the rows, so the credential status is checked again.
    const shown = accounts.slice(accounts.indexOf('function shownKey'), accounts.indexOf('export class AccountsPage'));
    for (const field of ['id', 'kind', 'app', 'displayName', 'enabled', 'topBar', 'accountHome', 'authFileOverride', 'sessionsDirectoryOverride'])
        assert.match(shown, new RegExp(`provider\\.${field}\\b`), field);
});
