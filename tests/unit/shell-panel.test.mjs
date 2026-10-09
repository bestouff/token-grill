import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenGrillIndicator, schemeAppearance, iconFor} from '../../build/tests/shell-ui.mjs';

const providers = ['codex', 'claude'].map((kind, index) => ({id: `account-${index}`, kind, displayName: kind,
  enabled: true, showInPanel: true, accent: 'green', panelWindowPreference: 'automatic'}));
const snapshots = new Map(providers.map(provider => [provider.id, {windows: [{canonicalWindow: 'five-hour', percent: 0.25}]}]));

function render(style, showAllAccounts, accounts = providers, readings = snapshots) {
  const children = [];
  const indicator = {providers: accounts, snapshots: readings, extension: {path: '/extension'},
    options: {activeProviderId: accounts[0].id, mode: 'remaining', style, showAllAccounts},
    panelBox: {get_children: () => children, add_child: child => children.push(child)}};
  globalThis.logError = error => { throw error; };
  TokenGrillIndicator.prototype._renderPanelSafely.call(indicator);
  return children;
}

for (const showAllAccounts of [false, true]) for (const style of ['text', 'ring', 'bar']) {
  test(`${showAllAccounts ? 'all accounts' : 'single account'} panel follows the ${style} setting`, () => {
    const displays = render(style, showAllAccounts);
    assert.equal(displays.length, showAllAccounts ? 2 : 1);
    for (const display of displays) {
      assert.ok(display.style_class.includes(`tokengrill-panel-${style}`));
      const reading = display.get_children()[1];
      if (style === 'ring') { assert.equal(reading.mockType, 'DrawingArea'); assert.equal(reading.width, 22); }
      else if (style === 'bar') { assert.equal(reading.mockType, 'BoxLayout'); assert.equal(reading.get_children()[0].width, 40); }
      else { assert.equal(reading.mockType, 'Label'); assert.equal(reading.text, '75% left'); }
    }
  });
}

test('prepaid balances remain amounts even when a quota meter is selected', () => {
  const provider = {...providers[0], kind: 'deepseek'};
  const displays = render('ring', false, [provider], new Map([[provider.id, {windows: [], balances: [{currency: 'USD', available: 5.25}]}]]));
  assert.equal(displays[0].get_children()[1].mockType, 'Label');
  assert.equal(displays[0].get_children()[1].text, `USD ${(5.25).toLocaleString()}`);
});

test('default, dark, and light Shell themes always request theme-colored symbolic logos', () => {
  for (const [variant, expected] of [[undefined, 'light'], ['dark', 'light'], ['', 'light'], ['light', 'dark']]) {
    globalThis.__shellStyleVariant = variant;
    assert.equal(schemeAppearance(), expected);
    assert.ok(iconFor(providers[0], '/extension').gicon.endsWith('openai-symbolic.svg'));
  }
  delete globalThis.__shellStyleVariant;
});
