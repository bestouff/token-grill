import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Shell interactions use the GNOME 50 cursor enum', async () => {
  const source = await read('src/shell/interaction.ts');
  assert.match(source, /Clutter\.CursorType\.POINTER/);
  assert.match(source, /actor\.set_cursor_type\(Clutter\.CursorType\.POINTER\)/);
  assert.match(source, /global\.stage\.set_cursor_type\(Clutter\.CursorType\.DEFAULT\)/);
  assert.doesNotMatch(source, /global\.display\.set_cursor/);
  assert.doesNotMatch(source, /Meta\.Cursor|POINTING_HAND/);
});

test('provider marks use fixed geometry and borderless circular dots', async () => {
  const [source, css] = await Promise.all([
    read('src/shell/accountChip.ts'),
    read('resources/stylesheet.css'),
  ]);
  assert.match(source, /new Clutter\.FixedLayout\(\)/);
  assert.match(source, /mark\.set_size\(size, size\)/);
  assert.match(source, /y_align: Clutter\.ActorAlign\.CENTER/);
  assert.match(source, /const dotSize = size >= 20 \? 6 : 5/);
  assert.match(css, /\.tokengrill-account-dot \{ border-radius: 3px; border: 0; \}/);
});

test('dashboard spacing, tab states, and popup corner clipping are explicit', async () => {
  const [indicator, css] = await Promise.all([
    read('src/shell/indicator.ts'),
    read('resources/stylesheet.css'),
  ]);
  assert.match(css, /\.tokengrill-provider-pane \{ spacing: 8px; \}/);
  assert.match(css, /\.tokengrill-tab-selected:hover/);
  assert.match(css, /-arrow-border-radius: 18px/);
  assert.match(indicator, /set_clip_to_allocation\(true\)/);
});

test('account tabs have no visible scrollbar and use circular markers', async () => {
  const [source, css] = await Promise.all([
    read('src/shell/indicator.ts'),
    read('resources/stylesheet.css'),
  ]);
  assert.match(source, /hscrollbar_policy: St\.PolicyType\.NEVER/);
  assert.match(css, /\.tokengrill-tab-scroll StScrollBar/);
  assert.match(css, /\.tokengrill-tab-marker \{[^}]*border-radius: 3px/s);
});

test('spinners rotate around their own centre and UI uses centralized packaged marks', async () => {
  const [indicator, dashboard, prefs, chip, metadata] = await Promise.all([
    read('src/shell/indicator.ts'),
    read('src/shell/providerCard.ts'),
    read('src/prefs.ts'),
    read('src/shell/accountChip.ts'),
    read('src/core/providerMetadata.ts'),
  ]);
  assert.match(indicator, /set_pivot_point\(0\.5, 0\.5\)/);
  assert.match(dashboard, /set_pivot_point\(0\.5, 0\.5\)/);
  assert.match(prefs, /providerIconFile/);
  assert.match(chip, /providerIconFile/);
  assert.match(metadata, /openai-mono-light\.svg/);
  assert.match(metadata, /claude-mono-light\.svg/);
  assert.match(metadata, /kiro-mono-light\.svg/);
  assert.doesNotMatch(prefs, /codex-symbolic|claude-symbolic/);
});

test('Kiro dashboard is monthly-only and shows precise credits', async () => {
  const dashboard = await read('src/shell/providerCard.ts');
  assert.match(dashboard, /_makeWindowCard\('Monthly', 'monthly'\)/);
  assert.match(dashboard, /metadata\.quotaWindows\.includes/);
  assert.match(dashboard, /of \$\{formatQuotaNumber\(window\.limit\)\} \$\{window\.unit\} used/);
  assert.match(dashboard, /pooled or unlimited/);
});

test('Kiro discovery checks the user-wide data store once and disables history', async () => {
  const prefs = await read('src/prefs.ts');
  assert.match(prefs, /const kiro = newProvider\('kiro', kiroHome\)/);
  assert.equal((prefs.match(/found\.push\(kiro\)/g) || []).length, 1);
  assert.match(prefs, /providerMetadata\(value\.kind\)\.localHistorySupported && this\._history\.active/);
});

test('provider HTTP requests are bounded and cannot follow redirects', async () => {
  const source = await read('src/providers/base.ts');
  assert.match(source, /Soup\.MessageFlags\.NO_REDIRECT/);
  assert.match(source, /MAX_RESPONSE_BYTES = 1024 \* 1024/);
  assert.match(source, /uri\.get_scheme\(\) !== 'https'/);
  assert.match(source, /FIXED_PROVIDER_HOSTS\.has\(host\)/);
  assert.doesNotMatch(source, /Provider request failed.*body/);
});

test('persisted state uses private permissions and bounded regular files', async () => {
  const source = await read('src/storage/atomicJson.ts');
  assert.match(source, /Gio\.FileType\.REGULAR/);
  assert.match(source, /info\.get_size\(\) > 4 \* 1024 \* 1024/);
  assert.match(source, /Gio\.FileCreateFlags\.PRIVATE/);
  assert.match(source, /set_attribute_uint32\('unix::mode', 0o600\)/);
  assert.match(source, /set_attributes_async/);
  assert.doesNotMatch(source, /GLib\.chmod|replace_contents\(/);
});

test('notification state is initialized only after the extension is enabled', async () => {
  const source = await read('src/shell/notifications.ts');
  assert.match(source, /export class NotificationStore/);
  assert.match(source, /async initialize\(cancellable:[\s\S]*await readJson\(this\.stateFile/);
  assert.doesNotMatch(source, /readJsonSync|constructor\(\)[\s\S]*readJson/);
});

test('notifications use provider-branded sources with explicit lifecycle cleanup', async () => {
  const [notification, runtime] = await Promise.all([
    read('src/shell/notifications.ts'),
    read('src/extension.ts'),
  ]);
  assert.doesNotMatch(notification, /Main\.notify\(/);
  assert.match(notification, /new MessageTray\.Source/);
  assert.match(notification, /new MessageTray\.Notification/);
  assert.match(notification, /Gio\.EmblemedIcon\.new\(baseIcon, emblem\)/);
  assert.match(notification, /providerIconFile\(instance\.kind, appearance\)/);
  assert.doesNotMatch(notification, /new MessageTray\.Notification\(\{[^}]*gicon/s);
  assert.match(notification, /notifyTest\(instance:[\s\S]*testNotificationText/);
  assert.match(notification, /title: `\$\{instance\.displayName\} — Token Grill`/);
  assert.match(notification, /private readonly sources = new Map\(\)/);
  assert.match(notification, /destroySignalId = source\.connect\('destroy'/);
  assert.match(notification, /record\.source\.disconnect\(record\.destroySignalId\)/);
  assert.match(notification, /record\.source\.destroy\(MessageTray\.NotificationDestroyedReason\.SOURCE_CLOSED\)/);
  assert.match(notification, /this\.destroySource\(providerId\)/);
  assert.match(runtime, /new NotificationStore\(extension\.path\)/);
  assert.match(runtime, /settings\.get_string\('panel-percentage-mode'\) === 'used'/);
  assert.match(runtime, /notifications\?\.destroy\(\)/);
});

test('provider preferences use direct editing, confirmed deletion, and normalized reorder controls', async () => {
  const source = await read('src/prefs.ts');
  assert.match(source, /icon_name: 'emblem-system-symbolic'/);
  assert.match(source, /width_request: 42, height_request: 42/);
  assert.match(source, /const editLabel = `\$\{_\('Edit'\)\} \$\{provider\.displayName\}`/);
  assert.doesNotMatch(source, /Gtk\.MenuButton|view-more-symbolic|_overflow\(/);
  assert.match(source, /label: _\('Delete provider'\)/);
  assert.match(source, /heading: _\('Delete provider\?'\)/);
  assert.match(source, /_dialog\.choose_finish\(result\) !== 'delete'/);
  assert.match(source, /class ProviderReorderDialog/);
  assert.match(source, /new Gtk\.DragSource/);
  assert.match(source, /Gtk\.DropTarget\.new/);
  assert.match(source, /go-up-symbolic/);
  assert.match(source, /go-down-symbolic/);
  assert.match(source, /reorderProviders/);
});

test('history cards identify local data, units, and scan states', async () => {
  const [dashboard, metrics] = await Promise.all([read('src/shell/providerCard.ts'), read('src/core/historyMetrics.ts')]);
  assert.match(dashboard, /API est\. · 30 days/);
  assert.match(dashboard, /tokengrill-metric-unit/);
  for (const state of ['History off', 'Not supported', 'Waiting…', 'Updating…', 'Scan failed', 'No price data'])
    assert.match(metrics, new RegExp(state));
  assert.match(metrics, /unit: 'TOKENS'/);
  assert.match(metrics, /unit: 'USD'/);
});

test('notification preferences write scoped test requests handled without milestone writes', async () => {
  const [prefs, runtime, notifications, schema] = await Promise.all([
    read('src/prefs.ts'), read('src/extension.ts'), read('src/shell/notifications.ts'), read('schemas/org.gnome.shell.extensions.tokengrill.gschema.xml'),
  ]);
  assert.match(prefs, /title: _\('Send test notification'\)/);
  assert.match(prefs, /notification-test-request/);
  assert.match(prefs, /provider\.enabled \? provider\.displayName/);
  assert.match(runtime, /parseTestNotificationRequest/);
  assert.match(runtime, /notifications\.notifyTest/);
  const notifyTest = notifications.slice(notifications.indexOf('notifyTest('), notifications.indexOf('removeProvider('));
  assert.doesNotMatch(notifyTest, /this\.state|persist\(/);
  assert.match(schema, /name="notification-test-request"/);
});

test('runtime storage and pricing initialization precede Shell UI and scheduling', async () => {
  const source = await read('src/extension.ts');
  const initialize = source.indexOf('await Promise.all([');
  const indicator = source.indexOf('this.indicator = new TokenGrillIndicator');
  const scheduler = source.indexOf('scheduler.start()');
  assert.ok(initialize >= 0 && initialize < indicator && indicator < scheduler);
  assert.match(source, /if \(!this\.isActive\(cancellable\)\) return;/);
  assert.match(source, /cancellable\?\.cancel\(\)/);
  assert.match(source, /if \(this\.runtime !== runtime \|\| isCancellation\(error\)\) return/);
});

test('collectors are runtime-owned and release cached authentication', async () => {
  const [registry, runtime, kiro] = await Promise.all([
    read('src/providers/registry.ts'),
    read('src/extension.ts'),
    read('src/providers/kiro/usageApi.ts'),
  ]);
  assert.doesNotMatch(registry, /^const collectors/m);
  assert.match(registry, /constructor\(\) \{[\s\S]*new CodexCollector\(\)/);
  assert.match(registry, /destroy\(\): void[\s\S]*this\.collectors = null/);
  assert.match(runtime, /collectors: CollectorRegistry \| null = new CollectorRegistry\(\)/);
  assert.match(runtime, /this\.collectors\?\.destroy\(\);[\s\S]*this\.collectors = null/);
  assert.match(kiro, /destroy\(\): void \{ this\.cachedAuth\.clear\(\); \}/);
});

test('review-reported UI signals are disconnected and owned actors are released', async () => {
  const [dashboard, indicator] = await Promise.all([
    read('src/shell/providerCard.ts'),
    read('src/shell/indicator.ts'),
  ]);
  for (const id of ['selectSignalId', 'repaintSignalId', 'clickSignalId']) {
    assert.match(dashboard, new RegExp(`${id}.*connect`, 's'));
    assert.match(dashboard, new RegExp(`disconnect\\([^)]*${id}`));
  }
  assert.match(indicator, /_emptySettingsSignalId = settings\.connect/);
  assert.match(indicator, /_emptySettingsButton\.disconnect\(this\._emptySettingsSignalId\)/);
  assert.match(indicator, /this\._item\?\.destroy\(\);[\s\S]*this\._item = null/);
  assert.match(indicator, /this\.cards\?\.destroy\(\);[\s\S]*this\.cards = null/);
});

test('runtime releases all lifecycle-owned references during stop', async () => {
  const source = await read('src/extension.ts');
  for (const name of ['scheduler', 'session', 'collectors', 'aggregates', 'checkpoints', 'notifications', 'settings', 'cancellable'])
    assert.match(source, new RegExp(`this\\.${name} = null`));
  assert.match(source, /this\.settingsId = 0/);
  assert.match(source, /this\.session\?\.abort\(\)/);
  assert.match(source, /Promise\.allSettled\(pendingFlushes\)/);
});

test('store writes are serialized and cancellation bypasses provider failures', async () => {
  const [aggregate, checkpoint, notification, base, runtime] = await Promise.all([
    read('src/storage/aggregateStore.ts'),
    read('src/storage/checkpointStore.ts'),
    read('src/shell/notifications.ts'),
    read('src/providers/base.ts'),
    read('src/extension.ts'),
  ]);
  for (const source of [aggregate, checkpoint, notification])
    assert.match(source, /this\.writeChain = this\.writeChain\.then\(\(\) => writeJsonAtomic/);
  assert.match(base, /if \(isCancellation\(error\)\) throw error/);
  assert.match(runtime, /if \(cancellable\.is_cancelled\(\) \|\| isCancellation\(error\)\) break/);
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
  assert.match(checker, /summary\?\.finding_count/);
});

test('new provider defaults are generated and validation errors stay field-specific', async () => {
  const source = await read('src/prefs.ts');
  assert.match(source, /initialMetadata\.label/);
  assert.match(source, /displayPath\(defaultHome\(initialKind\)\)/);
  assert.match(source, /this\._name\.subtitle = result\.errors\.displayName/);
  assert.match(source, /this\._home\.subtitle = result\.errors\.accountHome/);
  assert.match(source, /this\._auth\.subtitle = result\.errors\.authFileOverride/);
  assert.match(source, /this\._sessions\.subtitle = result\.errors\.sessionsDirectoryOverride/);
  assert.match(source, /this\._nameEdited/);
  assert.match(source, /this\._homeEdited/);
  assert.match(source, /this\._accentEdited/);
});

test('nested shell inherits user settings and rejects conflicting Token Grill installs', async () => {
  const source = await read('tools/nested-shell.sh');
  assert.doesNotMatch(source, /GSETTINGS_BACKEND/);
  assert.match(source, /metadata\.name === "Token Grill"/);
  assert.match(source, /Conflicting Token Grill installation/);
  assert.match(source, /State: ACTIVE/);
  assert.doesNotMatch(source, /gnome-extensions enable.*\|\| true/);
});
