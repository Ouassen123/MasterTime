/**
 * Client IPC typé (AD-1) — wrapper fin autour de `window.api` exposé par
 * le preload. Aucun accès DB depuis le renderer ; seuls les canaux IPC
 * whitelistés sont disponibles.
 */
import type { ApiResult, WindowApi } from '../../shared/types';

/** true si l'app tourne sous Electron (preload chargé). */
export function hasApi(): boolean {
  return typeof window !== 'undefined' && window.api != null;
}

/** Accès typé à l'API — lève une erreur claire hors Electron. */
export function api(): WindowApi {
  if (!hasApi()) {
    throw new Error(
      "API non disponible — l'application doit tourner sous Electron.",
    );
  }
  return window.api;
}

/** Message d'erreur lisible depuis un ApiResult en échec ou une exception. */
export function errorMessage(res: ApiResult<unknown> | unknown): string {
  if (typeof res === 'object' && res !== null && 'ok' in res) {
    const r = res as Record<string, unknown>;
    if (r.ok === false && typeof r.error === 'string') return r.error;
  }
  return res instanceof Error ? res.message : String(res);
}
