// Persistent per-browser device identifier used to register/recognize
// devices against the company's subscription device limit.
const DEVICE_ID_KEY = 'device_id';

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return '';

  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
