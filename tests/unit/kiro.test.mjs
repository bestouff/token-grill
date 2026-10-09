import test from 'node:test';
import assert from 'node:assert/strict';
import {kiroOidcEndpoint, kiroServiceEndpoint, kiroUsageUrl} from '../../build/tests/kiro-endpoints.mjs';
import {providerIconFile, providerMetadata} from '../../build/tests/provider-metadata.mjs';
import {isKiroTokenFresh, parseKiroAuthRecords} from '../../build/tests/kiro-auth-records.mjs';

test('Kiro metadata defines monthly-only live quota defaults', () => {
  const metadata = providerMetadata('kiro');
  assert.equal(metadata.label, 'Kiro');
  assert.equal(metadata.defaultAccent, 'purple');
  assert.equal(metadata.defaultAccountHome, '$XDG_DATA_HOME/kiro-cli');
  assert.equal(metadata.defaultQuotaWindow, 'monthly');
  assert.deepEqual(metadata.quotaWindows, ['monthly']);
  assert.equal(metadata.localHistorySupported, false);
  assert.equal(providerIconFile('kiro'), 'kiro-mono-light.svg');
  assert.equal(providerIconFile('kiro', 'dark'), 'kiro-mono-dark.svg');
});

test('Kiro request URLs cover commercial and GovCloud partitions', () => {
  assert.equal(kiroOidcEndpoint('us-east-1'), 'https://oidc.us-east-1.amazonaws.com/token');
  assert.equal(kiroServiceEndpoint('eu-central-1'), 'https://q.eu-central-1.amazonaws.com');
  assert.equal(kiroServiceEndpoint('us-gov-west-1'), 'https://q.us-gov-west-1.amazonaws.com');
  assert.equal(kiroServiceEndpoint('us-iso-east-1'), 'https://q.us-iso-east-1.c2s.ic.gov');
});

test('Kiro usage URL includes optional profile ARN and CLI origin', () => {
  assert.equal(kiroUsageUrl({region: 'us-east-1', profileArn: null}), 'https://codewhisperer.us-east-1.amazonaws.com/?origin=CLI');
  assert.equal(kiroUsageUrl({region: 'us-east-1', profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/a b'}), 'https://codewhisperer.us-east-1.amazonaws.com/?profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A1%3Aprofile%2Fa%20b&origin=CLI');
});

test('Kiro credential records parse expiry, refresh material, and profile ARN', () => {
  const auth = parseKiroAuthRecords(
    JSON.stringify({access_token: 'access-value', refresh_token: 'refresh-value', expires_at: 1800000000, region: 'us-east-1'}),
    JSON.stringify({client_id: 'client-value', client_secret: 'secret-value', client_secret_expires_at: 1900000000}),
    JSON.stringify({arn: 'arn:aws:codewhisperer:us-east-1:1:profile/test'}), '/tmp/data.sqlite3');
  assert.equal(auth.expiresAt, 1800000000000);
  assert.equal(auth.clientSecretExpiresAt, 1900000000000);
  assert.equal(auth.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/test');
  assert.equal(auth.region, 'us-east-1');
  assert.equal(auth.serviceRegion, 'us-east-1');
  assert.equal(isKiroTokenFresh(auth, 1700000000000), true);
  assert.equal(isKiroTokenFresh({...auth, expiresAt: 1700000059999}, 1700000000000), false);
});

test('Kiro separates the OIDC login region from the profile service region', () => {
  const auth = parseKiroAuthRecords(
    JSON.stringify({access_token: 'access', expires_at: 1800000000, region: 'ap-south-1'}), null,
    JSON.stringify({arn: 'arn:aws:codewhisperer:us-east-1:1:profile/test'}), '/tmp/data.sqlite3');
  assert.equal(auth.region, 'ap-south-1');
  assert.equal(auth.serviceRegion, 'us-east-1');
});

test('Kiro credential errors never include stored secret values', () => {
  const secret = 'do-not-leak-this-secret';
  assert.throws(() => parseKiroAuthRecords('{malformed', JSON.stringify({client_secret: secret}), null, '/tmp/data.sqlite3'), error => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /token record is invalid/);
    return true;
  });
  assert.throws(() => parseKiroAuthRecords(null, null, null, '/tmp/data.sqlite3'), /kiro-cli login/i);
});
