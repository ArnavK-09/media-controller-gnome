// SPDX-License-Identifier: GPL-2.0-or-later
/* mediaCard.js
 *
 * The iOS-style "now playing" card shown when the panel indicator is clicked.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const POSITION_POLL_SECONDS = 1;
const US_PER_SECOND = 1000000;

/* A wrapping title has no natural bound: the card is as tall as the text needs.
 * Podcast episodes and DJ sets routinely carry titles of a few hundred
 * characters, which would push the controls off the bottom of the screen. This
 * caps the title at roughly three lines at the default card width; the wrap
 * still does the real work, this only stops the pathological case. */
const MAX_TITLE_CHARS = 120;

/** @param {string} text @param {number} maxLength */
function truncate(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.substring(0, maxLength - 1).trimEnd()}…`;
}

/** @param {number} micros */
function formatTime(micros) {
    const total = Math.max(0, Math.floor(micros / US_PER_SECOND));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** St parses this as CSS, so a path with a quote in it must not break out. */
function cssUrl(path) {
    return `url("${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/* Secondary text; opacity keeps it legible in both light and dark themes,
 * which a hardcoded color would not. */
const DIM_OPACITY = 160;

/* `message-media-control` is the shell's own media button style, so hover,
 * active and insensitive states follow the current theme. */
function iconButton(iconName, styleClass) {
    return new St.Button({
        style_class: `message-media-control ${styleClass}`,
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
}

export const MediaCard = GObject.registerClass({
    Signals: {
        /* Raised the player's window; the menu should close. */
        'activated': {},
        /* The gear button was pressed. */
        'open-preferences': {},
    },
}, class MediaCard extends St.BoxLayout {
    _init(artCache, settings) {
        super._init({
            style_class: 'mc-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._artCache = artCache;
        this._settings = settings;
        this._player = null;
        this._playerSignals = [];
        this._timeoutId = 0;
        this._seekRefreshId = 0;
        this._dragging = false;
        this._dragPlayer = null;
        this._dragLength = 0;
        this._active = false;
        this._destroyed = false;
        this._currentArtUrl = null;
        this._artGeneration = 0;
        this._length = 0;
        this._position = 0;

        this._buildHeader();
        this._buildSeekBar();
        this._buildControls();

        this._settingsSignals = [
            this._settings.connect('changed::card-show-art', () => this.sync()),
            this._settings.connect('changed::card-show-seek-bar', () => this.sync()),
            this._settings.connect('changed::card-show-seek-buttons', () => this.sync()),
            this._settings.connect('changed::card-width', () => this._applyWidth()),
        ];
        this._applyWidth();

        this.connect('destroy', () => this._onDestroy());
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'mc-card-header',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        this._artBin = new St.Bin({
            style_class: 'mc-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artFallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 40,
            opacity: DIM_OPACITY,
        });
        this._artBin.set_child(this._artFallback);
        header.add_child(this._artBin);

        const textBox = new St.BoxLayout({
            style_class: 'mc-card-text',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._titleLabel = new St.Label({style_class: 'mc-card-title', text: _('Nothing playing')});
        this._subtitleLabel = new St.Label({
            style_class: 'mc-card-subtitle',
            text: '',
            opacity: DIM_OPACITY,
        });
        /* The card has a fixed width, so a long title wraps onto further lines
         * rather than being cut off. Breaking mid-word is the fallback for a
         * single word too long to fit on a line of its own. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);
        textBox.add_child(this._subtitleLabel);
        header.add_child(textBox);

        const actions = new St.BoxLayout({
            style_class: 'mc-card-actions',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._appButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appIcon = new St.Icon({icon_size: 16, style_class: 'mc-app-icon'});
        this._appButton.set_child(this._appIcon);
        this._appButton.connect('clicked', () => {
            this._player?.raise();
            this.emit('activated');
        });
        actions.add_child(this._appButton);

        this._prefsButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        this._prefsButton.connect('clicked', () => this.emit('open-preferences'));
        actions.add_child(this._prefsButton);

        header.add_child(actions);
        this.add_child(header);
    }

    _buildSeekBar() {
        this._seekBox = new St.BoxLayout({
            style_class: 'mc-seek-box',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._slider = new Slider(0);
        this._slider.add_style_class_name('mc-seek');
        this._slider.x_expand = true;

        /* The track can advance while the thumb is held, and sync() would move
         * `_length` out from under the drag. Pin the player and the duration the
         * user is actually scrubbing against. */
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            this._dragPlayer = this._player;
            this._dragLength = this._length;
            return Clutter.EVENT_PROPAGATE;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            const player = this._dragPlayer;
            const length = this._dragLength;
            this._dragPlayer = null;

            if (player && player === this._player && length > 0)
                player.setPosition(Math.round(this._slider.value * length));
            return Clutter.EVENT_PROPAGATE;
        });
        /* Keep the timestamps under the thumb while the user scrubs. */
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._dragLength > 0) {
                this._updateTimeLabels(this._slider.value * this._dragLength,
                    this._dragLength);
            }
        });

        const times = new St.BoxLayout({
            style_class: 'mc-time-box',
            orientation: Clutter.Orientation.HORIZONTAL,
        });
        this._positionLabel = new St.Label({
            style_class: 'mc-time',
            text: '0:00',
            opacity: DIM_OPACITY,
        });
        this._remainingLabel = new St.Label({
            style_class: 'mc-time',
            text: '-0:00',
            opacity: DIM_OPACITY,
        });
        this._remainingLabel.x_align = Clutter.ActorAlign.END;
        this._remainingLabel.x_expand = true;
        times.add_child(this._positionLabel);
        times.add_child(this._remainingLabel);

        this._seekBox.add_child(this._slider);
        this._seekBox.add_child(times);
        this.add_child(this._seekBox);
    }

    _buildControls() {
        const controls = new St.BoxLayout({
            style_class: 'mc-card-controls',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = iconButton('media-skip-backward-symbolic', 'mc-control-button');
        this._backButton = iconButton('media-seek-backward-symbolic', 'mc-control-button mc-seek-button');
        this._playButton = iconButton('media-playback-start-symbolic', 'mc-control-button mc-play-button');
        this._forwardButton = iconButton('media-seek-forward-symbolic', 'mc-control-button mc-seek-button');
        this._nextButton = iconButton('media-skip-forward-symbolic', 'mc-control-button');

        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());
        this._backButton.connect('clicked', () => this._skip(-1));
        this._forwardButton.connect('clicked', () => this._skip(1));

        controls.add_child(this._prevButton);
        controls.add_child(this._backButton);
        controls.add_child(this._playButton);
        controls.add_child(this._forwardButton);
        controls.add_child(this._nextButton);
        this.add_child(controls);
    }

    /**
     * @param {number} direction -1 to rewind, 1 to skip ahead
     */
    _skip(direction) {
        if (!this._player)
            return;
        const step = this._settings.get_int('seek-step-seconds') * US_PER_SECOND;
        this._player.seek(direction * step);

        /* Players that do not emit Seeked would otherwise leave the slider
         * stale until the next poll — and there is no poll while paused. */
        this._refreshPositionSoon();
    }

    _refreshPositionSoon() {
        if (this._seekRefreshId)
            GLib.Source.remove(this._seekRefreshId);
        this._seekRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._seekRefreshId = 0;
            this._refreshPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyWidth() {
        this.style = `width: ${this._settings.get_int('card-width')}px;`;
    }

    setPlayer(player) {
        if (this._player === player) {
            this.sync();
            return;
        }

        this._disconnectPlayer();
        this._player = player;

        if (player) {
            this._playerSignals.push(player.connect('changed', () => this.sync()));
            this._playerSignals.push(player.connect('seeked', (_p, position) => {
                this._position = position;
                this._updateSlider();
            }));
        }

        this._currentArtUrl = null;
        this.sync();
        this._refreshPosition();
    }

    _disconnectPlayer() {
        if (this._player) {
            for (const id of this._playerSignals)
                this._player.disconnect(id);
        }
        this._playerSignals = [];
    }

    /** The card only polls Position while it is actually on screen. */
    setActive(active) {
        this._active = active;
        this._updateTimer();
        if (active)
            this._refreshPosition();
    }

    /* Polling exists to move the seek bar. No seek bar on screen, no polling —
     * every tick is a D-Bus round trip. */
    _updateTimer() {
        const wanted = this._active && this._seekBox.visible &&
            this._player?.isPlaying;

        if (wanted && !this._timeoutId) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                POSITION_POLL_SECONDS, () => {
                    this._refreshPosition();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!wanted && this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _refreshPosition() {
        const player = this._player;
        if (!player)
            return;
        player.getPosition().then(position => {
            /* The D-Bus round trip can outlive the card, a drag starting, or the
             * player it was issued for — a late answer from the previous track
             * would otherwise be painted onto this one's slider. */
            if (this._destroyed || this._dragging || this._player !== player)
                return;
            this._position = position;
            this._updateSlider();
        });
    }

    _updateSlider() {
        if (this._dragging)
            return;
        const fraction = this._length > 0
            ? Math.min(1, Math.max(0, this._position / this._length))
            : 0;
        this._slider.value = fraction;
        this._updateTimeLabels(this._position);
    }

    _updateTimeLabels(position, length = this._length) {
        this._positionLabel.text = formatTime(position);
        this._remainingLabel.text = `-${formatTime(Math.max(0, length - position))}`;
    }

    /** Drop any painted art and orphan whatever download is in flight. */
    _clearArt() {
        this._artGeneration++;
        this._currentArtUrl = null;
        this._artBin.style = null;
        this._artFallback.gicon = null;
        this._artFallback.icon_name = 'audio-x-generic-symbolic';
        this._artFallback.opacity = DIM_OPACITY;
        this._artFallback.visible = true;
    }

    /* A real app icon carries its own color and reads as artwork; only the
     * generic symbolic placeholder wants dimming. */
    _setFallbackIcon(player) {
        this._artFallback.gicon = player.appIcon;
        this._artFallback.opacity = player.hasAppIcon ? 255 : DIM_OPACITY;
    }

    _updateArt() {
        const player = this._player;
        const showArt = this._settings.get_boolean('card-show-art');
        this._artBin.visible = showArt;

        /* Forget the current art while hidden, so re-enabling the setting on the
         * same track resolves it again instead of short-circuiting below. */
        if (!showArt || !player) {
            this._clearArt();
            return;
        }

        const url = player.artUrl;
        if (url === this._currentArtUrl) {
            /* The app proxy resolves after the player proxy, so a track with no
             * artwork can still gain a real icon on a later sync. */
            if (this._artFallback.visible)
                this._setFallbackIcon(player);
            return;
        }

        /* Art resolution is async; a newer track must win even if its download
         * finishes first. */
        this._clearArt();
        this._currentArtUrl = url;
        const generation = this._artGeneration;
        this._setFallbackIcon(player);

        if (!url)
            return;

        this._artCache.resolve(url).then(path => {
            if (this._destroyed || generation !== this._artGeneration || !path)
                return;
            this._artBin.style = `background-image: ${cssUrl(path)};`;
            this._artFallback.visible = false;
        });
    }

    sync() {
        const player = this._player;

        if (!player) {
            this._titleLabel.text = _('Nothing playing');
            this._subtitleLabel.text = '';
            this._subtitleLabel.visible = false;
            this._seekBox.visible = false;
            this._appButton.visible = false;
            this._backButton.visible = false;
            this._forwardButton.visible = false;
            this._length = 0;
            this._updateArt();
            this._updateTimer();
            return;
        }

        const title = player.title || _('Unknown title');
        const artist = player.artist;
        const album = player.album;

        this._titleLabel.text = truncate(title, MAX_TITLE_CHARS);
        const subtitle = artist && album && artist !== album
            ? `${artist} — ${album}`
            : artist || album;
        this._subtitleLabel.text = subtitle;
        this._subtitleLabel.visible = !!subtitle;

        this._playButton.child.icon_name = player.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._appIcon.gicon = player.appIcon;
        this._appButton.visible = player.canRaise;

        this._length = player.length;
        const showSeek = this._settings.get_boolean('card-show-seek-bar') &&
            this._length > 0;
        this._seekBox.visible = showSeek;
        this._setSensitive(this._slider, player.canSeek);

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        const showSkip = this._settings.get_boolean('card-show-seek-buttons') &&
            player.canSeek;
        this._backButton.visible = showSkip;
        this._forwardButton.visible = showSkip;

        this._updateArt();
        this._updateSlider();
        this._updateTimer();
    }

    /* Setting `reactive` is enough: St maps it to the `:insensitive` pseudo
     * class, which the theme already styles. */
    _setSensitive(actor, sensitive) {
        actor.reactive = sensitive;
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._seekRefreshId) {
            GLib.Source.remove(this._seekRefreshId);
            this._seekRefreshId = 0;
        }
        this._disconnectPlayer();
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._player = null;
    }
});
