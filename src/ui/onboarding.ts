/**
 * First-run onboarding: one screen that explains on-device vs cloud vs the
 * Privacy Shield, shows the live Gemini Nano status, and offers the offline demo.
 */
import type { DeviceStatus } from '../ai/router';
import { describeDevice } from '../ai/device';
import { h } from './dom';

export interface OnboardingProps {
  device: DeviceStatus;
  cloudModel: string;
  maxChars: number;
  onDownload: () => void;
  onTryOffline: () => void;
  onClose: () => void;
}

export function renderOnboarding(p: OnboardingProps): HTMLElement {
  const canDownload = p.device === 'downloadable' || p.device === 'downloading';
  const card = (cls: string, title: string, body: string, extra?: HTMLElement | false) =>
    h('div', { class: `ob-card ${cls}` }, h('div', { class: 'ob-card-title' }, h('span', { class: 'ob-swatch' }), title), h('p', {}, body), extra);

  const dialog = h('div', { class: 'ob', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ob-title' },
    h('h2', { id: 'ob-title' }, 'Your device thinks first.'),
    h('p', { class: 'muted' }, 'Tandem Notes picks where each AI request runs, and always shows you where it ran and why.'),
    h('div', { class: 'ob-grid' },
      card('ob-device', 'On-device · Gemini Nano',
        `Short notes run inside Chrome: fast, free, private, and they work in airplane mode.`,
        h('div', { class: 'ob-status' },
          h('span', { class: 'small' }, `Status: ${describeDevice(p.device)}`),
          canDownload && h('button', { class: 'btn btn-small', onclick: p.onDownload }, 'Get Gemini Nano'))),
      card('ob-cloud', `Cloud · ${p.cloudModel}`,
        `Documents over ${p.maxChars.toLocaleString('en-US')} characters, or browsers without a local model, use Gemini in the cloud through Firebase AI Logic. If one side fails, the other takes over.`),
      card('ob-shield', 'Privacy Shield',
        'Before anything goes to the cloud, names, emails, phone numbers and IDs are swapped for placeholders on this device, then restored in the answer. Device-only notes never leave at all.'),
    ),
    h('div', { class: 'ob-foot' },
      h('button', { class: 'btn', onclick: p.onTryOffline, title: 'Simulates airplane mode: cloud AI and sync pause, Gemini Nano keeps working' }, 'Try the offline demo'),
      h('button', { class: 'btn btn-primary', onclick: p.onClose }, 'Start writing')),
  );
  const backdrop = h('div', { class: 'ob-backdrop' }, dialog);
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') p.onClose(); });
  return backdrop;
}
