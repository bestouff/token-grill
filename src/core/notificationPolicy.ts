import type {ProviderInstance, ProviderSnapshot, UsageWindow} from './types.js';
import {resolveQuotaSelection} from './display.js';

export interface NotificationCheckpoint {
    resetIdentity: string;
    lastNotifiedBucket: number;
    configuredStep: number;
}

export function selectedNotificationWindow(
    instance: ProviderInstance,
    snapshot: ProviderSnapshot,
): UsageWindow | null {
    return resolveQuotaSelection(
        snapshot,
        instance.panelWindowPreference || 'automatic',
    ).selected;
}

export function notificationBucket(percent: number, stepPercent: number): number {
    const step = Math.max(5, Math.min(50, Math.round(stepPercent / 5) * 5));
    const consumed = Math.max(0, Math.min(100, percent * 100));
    return Math.floor((consumed + 1e-6) / step);
}

export function shouldNotifyMilestone(
    previous: NotificationCheckpoint | null,
    resetIdentity: string,
    bucket: number,
    stepPercent: number,
): boolean {
    // Startup, a newly selected quota window, and a changed notification step
    // seed state silently. Alerts represent crossings observed by Token Grill,
    // not historical milestones replayed when an account is first loaded.
    if (!previous || previous.resetIdentity !== resetIdentity || previous.configuredStep !== stepPercent)
        return false;
    return bucket >= 1 && bucket > previous.lastNotifiedBucket;
}
