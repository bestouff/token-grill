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
  assert.match(metadata, /openai-blossom-light\.svg/);
  assert.match(metadata, /claude-mark-light\.svg/);
  assert.match(metadata, /kiro-icon\.png/);
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
  assert.match(source, /GLib\.chmod\(path, 0o600\)/);
});

test('notification state is initialized only after the extension is enabled', async () => {
  const source = await read('src/shell/notifications.ts');
  assert.match(source, /export class NotificationStore/);
  assert.match(source, /constructor\(\) \{[\s\S]*readJsonSync\(this\.stateFile/);
  assert.doesNotMatch(source, /^const .*readJsonSync/m);
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
