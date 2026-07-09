// SPDX-License-Identifier: GPL-2.0-or-later
/* transport.js
 *
 * The bits of playback control the panel indicator and the card both need.
 * They render the same five buttons against the same player, so the step math
 * and the icon naming live here rather than in two places.
 *
 * Note that button *sensitivity* is deliberately not shared: the card's buttons
 * carry `message-media-control`, which the shell theme styles for the
 * `:insensitive` state, while the panel's `mc-panel-control` has no such rule
 * and has to dim itself.
 */

/** MPRIS speaks microseconds throughout. */
export const US_PER_SECOND = 1000000;

/**
 * How far a skip button moves, signed.
 *
 * @param {object} settings the extension's Gio.Settings
 * @param {number} direction -1 to rewind, 1 to skip ahead
 * @returns {number} offset in microseconds
 */
export function seekOffset(settings, direction) {
    return direction * settings.get_int('seek-step-seconds') * US_PER_SECOND;
}

/**
 * @param {object} player an MprisPlayer
 * @returns {string} the icon the play/pause button should currently wear
 */
export function playPauseIconName(player) {
    return player.isPlaying
        ? 'media-playback-pause-symbolic'
        : 'media-playback-start-symbolic';
}
