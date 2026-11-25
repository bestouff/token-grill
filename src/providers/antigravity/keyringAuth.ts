import type Gio from 'gi://Gio';

import {CollectorError, type ErrorText} from '../../core/errors.js';
import {lookupSecret} from '../keyring.js';
import {AGY_KEYRING_ATTRIBUTES, AGY_KEYRING_SCHEMA, parseAgyKeyringPayload, type AgyKeyringToken} from './keyringPayload.js';

const KEYRING_UNAVAILABLE: ErrorText = ({_}) => _('The system keyring is locked or not available, so the agy sign-in cannot be read.');

export async function lookupAgyKeyringToken(cancellable: Gio.Cancellable): Promise<AgyKeyringToken | null> {
    const raw = await lookupSecret(AGY_KEYRING_SCHEMA, AGY_KEYRING_ATTRIBUTES, cancellable, KEYRING_UNAVAILABLE);
    if (!raw)
        return null;
    const token = parseAgyKeyringPayload(raw);
    if (!token)
        throw new CollectorError('auth-invalid', ({_}) => _('The agy sign-in in the system keyring could not be read.'));
    return token;
}
