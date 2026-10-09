// Run after npm test: gjs -m tools/provider-fixture-test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {AdditionalProviderCollector} from '../build/tests/additional-collector.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const home = `/tmp/opencode/token-grill-providers-${GLib.uuid_string_random()}`;
GLib.mkdir_with_parents(home, 0o700);
const files = [];
function write(name, contents) {
    const path = GLib.build_filenamev([home, name]);
    GLib.file_set_contents(path, contents);
    files.push(path);
    return path;
}
const authFile = write('auth.json', JSON.stringify({deepseek: {type: 'api', key: 'fixture-deepseek'}, opencode: {type: 'api', key: 'fixture-zen'}}));
const collector = new AdditionalProviderCollector();
const instance = kind => ({id: `fixture-${kind}`, kind, accountHome: home, authFileOverride: authFile, liveUsageEnabled: true, localHistoryEnabled: false});
const context = getJson => ({cancellable: new Gio.Cancellable(), session: null, getJson});

try {
    const [, manifestBytes] = GLib.file_get_contents('resources/provider-assets.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    for (const asset of Object.values(manifest.assets)) {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(`resources/${asset.file}`);
        assert(pixbuf.get_width() > 0 && pixbuf.get_height() > 0, `SVG could not be rendered: ${asset.file}`);
    }
    const deepseek = await collector.collect(instance('deepseek'), context(async (_session, url, headers) => {
        assert(url === 'https://api.deepseek.com/user/balance', 'DeepSeek endpoint mismatch');
        assert(headers.Authorization === 'Bearer fixture-deepseek', 'Wrong service credential');
        return {is_available: true, balance_infos: [{currency: 'USD', total_balance: '12.25'}]};
    }), null);
    assert(deepseek.state === 'ready' && deepseek.balances[0].available === 12.25 && deepseek.windows.length === 0, 'DeepSeek balance collection failed');

    const zen = await collector.collect(instance('opencode'), context(async (_session, url, headers) => {
        assert(url === 'https://opencode.ai/zen/go/v1/usage', 'OpenCode endpoint mismatch');
        assert(headers.Authorization === 'Bearer fixture-zen', 'Wrong OpenCode credential');
        return {usage: {rolling: {percent: 50}}};
    }), null);
    assert(zen.state === 'ready' && zen.windows[0].percent === 0.5, 'OpenCode collection failed');

    GLib.mkdir_with_parents(`${home}/credentials`, 0o700);
    const kimiFile = write('credentials/kimi-code-env-fixture.json', JSON.stringify({access_token: 'fixture-kimi', expires_at: Date.now() / 1000 + 3600}));
    write('config.toml', '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nkey = "oauth/kimi-code-env-fixture"\n');
    const kimiInstance = {...instance('kimi'), authFileOverride: null};
    const kimi = await collector.collect(kimiInstance, context(async (_session, url, headers) => {
        assert(url === 'https://api.kimi.ai/coding/v1/usages', 'Kimi region was ignored');
        assert(headers.Authorization === 'Bearer fixture-kimi', 'Kimi credential reference was ignored');
        return {usages: {limit_5h: {used_ratio: 0.25}}};
    }), null);
    assert(kimi.state === 'ready' && kimi.windows[0].percent === 0.25, `Kimi collection failed: ${kimi.error}`);

    const stale = await collector.collect(instance('deepseek'), context(async () => { throw new Error('Fixture offline'); }), deepseek);
    assert(stale.state === 'stale' && stale.balances[0].available === 12.25, 'Failed refresh discarded the cached balance');

    GLib.file_set_contents(kimiFile, JSON.stringify({access_token: 'expired-fixture', expires_at: 1}));
    const expired = await collector.collect(kimiInstance, context(async () => { throw new Error('Must not request with an expired token'); }), kimi);
    assert(expired.errorInfo.code === 'auth-expired' && expired.windows[0].percent === 0.25, 'Expired credentials were not handled');

    GLib.file_set_contents(authFile, '{invalid json');
    const malformed = await collector.collect(instance('deepseek'), context(async () => { throw new Error('Must not request with invalid credentials'); }), null);
    assert(malformed.errorInfo.code === 'auth-invalid', 'Malformed credentials were not rejected');

    const cancellation = new Gio.Cancellable();
    cancellation.cancel();
    let cancelled = false;
    try { await collector.collect(instance('deepseek'), {cancellable: cancellation}, null); }
    catch { cancelled = true; }
    assert(cancelled, 'Cancellation became a provider failure');
    print('Provider fixture checks passed: SVG rendering, credentials, regional endpoints, balances, quotas, stale cache, expiry, malformed files, cancellation.');
} finally {
    for (const file of files) GLib.unlink(file);
    GLib.rmdir(`${home}/credentials`);
    GLib.rmdir(home);
}
