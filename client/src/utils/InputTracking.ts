import type { ChildLogger } from '../core/Logger.js';

export function setupInputTracking(logger: ChildLogger): { isTabHidden: () => boolean; isJetActive: () => boolean } {
  let isTabHidden = false;
  let isJetActive = false;

  // Track jet button for continuous particles
  document.addEventListener('mousedown', (e): void => { if (e.button === 2) {isJetActive = true;} });
  document.addEventListener('mouseup', (e): void => { if (e.button === 2) {isJetActive = false;} });

  // Detect tab visibility changes to keep sending position when alt-tabbed
  document.addEventListener('visibilitychange', (): void => {
    isTabHidden = document.hidden;
    logger.debug(`Tab visibility changed: ${isTabHidden ? 'hidden' : 'visible'}`);
  });

  return {
    isTabHidden: (): boolean => isTabHidden,
    isJetActive: (): boolean => isJetActive,
  };
}
