import type {PanelPercentageMode, ProviderInstance, ProviderSnapshot, UsageWindow} from './types.js';
import {resolveQuotaSelection} from './display.js';
import {providerMetadata} from './providerMetadata.js';

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

export function milestoneNotificationText(
    window: UsageWindow,
    consumedPercent: number,
    milestonePercent: number,
    mode: PanelPercentageMode,
): {title: string; body: string} {
    const consumed = Math.max(0, Math.min(1, consumedPercent));
    const displayed = mode === 'remaining' ? 1 - consumed : consumed;
    const qualifier = mode === 'remaining' ? 'remaining' : 'consumed';
    return {
        title: `${window.label} usage`,
        body: `${Math.round(displayed * 100)}% ${qualifier} · crossed the ${milestonePercent}% milestone.`,
    };
}

export function testNotificationWindowLabel(instance: ProviderInstance, snapshot: ProviderSnapshot | null): string {
    if (snapshot) {
        const selected = selectedNotificationWindow(instance, snapshot);
        if (selected) return selected.label;
    }
    const supported = providerMetadata(instance.kind).quotaWindows;
    const preferred = instance.panelWindowPreference;
    const canonical = preferred !== 'automatic' && supported.includes(preferred) ? preferred : supported[0];
    return canonical === 'five-hour' ? 'Five-hour' : canonical === 'weekly' ? 'Weekly' : canonical === 'monthly' ? 'Monthly credits' : 'Usage';
}

export function testNotificationText(windowLabel: string, mode: PanelPercentageMode): {title: string; body: string} {
    return {
        title: `${windowLabel} usage`,
        body: mode === 'remaining'
            ? 'Test alert · 66% remaining · 30% milestone preview.'
            : 'Test alert · 34% consumed · 30% milestone preview.',
    };
}

export function parseTestNotificationRequest(value: string): {providerId: string; nonce: string} | null {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        if (typeof parsed.providerId !== 'string' || !parsed.providerId || parsed.providerId.length > 256) return null;
        if (typeof parsed.nonce !== 'string' || !parsed.nonce || parsed.nonce.length > 256) return null;
        return {providerId: parsed.providerId, nonce: parsed.nonce};
    } catch {
        return null;
    }
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
