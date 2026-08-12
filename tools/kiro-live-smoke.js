import Gda from 'gi://Gda?version=5.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gda.init();
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
const database = GLib.getenv('KIRO_DB') || GLib.build_filenamev([GLib.get_user_data_dir(), 'kiro-cli', 'data.sqlite3']);
const file = Gio.File.new_for_path(database);
const before = file.query_info('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
const connection = Gda.Connection.open_from_string('SQLite', `DB_DIR=${GLib.path_get_dirname(database)};DB_NAME=${GLib.path_get_basename(database)}`, null, Gda.ConnectionOptions.READ_ONLY);
connection.execute_select_command('PRAGMA query_only = ON');

function value(table, key) {
    try {
        const model = connection.execute_select_command(`SELECT value FROM ${table} WHERE key = '${key}' LIMIT 1`);
        return model?.get_n_rows() ? String(model.get_value_at(0, 0)) : null;
    } catch { return null; }
}

function parse(raw, label) {
    try { return JSON.parse(raw); } catch { throw new Error(`Kiro ${label} record is invalid`); }
}

const token = parse(value('auth_kv', 'kirocli:odic:token'), 'token');
const registration = parse(value('auth_kv', 'kirocli:odic:device-registration'), 'device registration');
const profileRaw = value('state', 'api.codewhisperer.profile');
const profile = profileRaw ? parse(profileRaw, 'profile') : {};
connection.close();

const session = new Soup.Session({timeout: 30});
async function post(url, headers, body) {
    const message = Soup.Message.new('POST', url);
    for (const [name, headerValue] of Object.entries(headers)) message.get_request_headers().append(name, headerValue);
    message.set_request_body_from_bytes(headers['Content-Type'], new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.status_code < 200 || message.status_code >= 300) throw new Error(`Kiro service returned HTTP ${message.status_code}`);
    return JSON.parse(new TextDecoder().decode(bytes.toArray()));
}

let accessToken = token.access_token;
const expiry = typeof token.expires_at === 'number' ? (token.expires_at < 10000000000 ? token.expires_at * 1000 : token.expires_at) : Date.parse(token.expires_at);
if (!accessToken || !token.region) throw new Error('Kiro login is incomplete; run kiro-cli login');
if (!Number.isFinite(expiry) || expiry <= Date.now() + 60000) {
    if (!token.refresh_token || !registration.client_id || !registration.client_secret) throw new Error('Kiro login has expired; run kiro-cli login');
    const refreshed = await post(`https://oidc.${token.region}.amazonaws.com/token`, {'Content-Type': 'application/json'}, {
        clientId: registration.client_id, clientSecret: registration.client_secret, grantType: 'refresh_token', refreshToken: token.refresh_token,
    });
    if (!refreshed.accessToken) throw new Error('Kiro login refresh failed; run kiro-cli login');
    accessToken = refreshed.accessToken;
}

const profileArn = profile.arn || profile.profileArn || profile.profile_arn || null;
const query = profileArn ? `profileArn=${encodeURIComponent(profileArn)}&origin=CLI` : 'origin=CLI';
const profileRegion = profileArn?.split(':')[3];
const serviceRegion = profileRegion || (['us-east-1', 'eu-central-1', 'us-gov-east-1', 'us-gov-west-1'].includes(token.region) ? token.region : 'us-east-1');
const endpoint = serviceRegion === 'us-east-1' ? 'https://codewhisperer.us-east-1.amazonaws.com' : `https://q.${serviceRegion}.amazonaws.com`;
const headers = {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': 'AmazonCodeWhispererService.GetUsageLimits'};
const first = await post(`${endpoint}/?${query}`, headers, {});
const second = await post(`${endpoint}/?${query}`, headers, {});

function safeUsage(response) {
    const credit = response.usageBreakdownList?.find(item => item.resourceType === 'CREDIT');
    if (!credit) throw new Error('Kiro credit usage is unavailable');
    const used = credit.currentUsageWithPrecision ?? credit.currentUsage;
    const limit = credit.usageLimitWithPrecision ?? credit.usageLimit;
    const reset = credit.nextDateReset ?? response.nextDateReset;
    return {plan: response.subscriptionInfo?.subscriptionTitle || response.subscriptionInfo?.type || null, used, limit, percentage: limit > 0 ? used / limit : null, resetDate: reset ? new Date(reset * 1000).toISOString() : null};
}

const result = safeUsage(first);
const verification = safeUsage(second);
if (result.used !== verification.used || result.limit !== verification.limit) throw new Error('Kiro usage changed during the read-only smoke check');
const after = file.query_info('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
if (before.get_size() !== after.get_size() || before.get_modification_date_time().to_unix() !== after.get_modification_date_time().to_unix()) throw new Error('Kiro data store changed during the read-only smoke check');
print(JSON.stringify(result));
