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
        this._dragging = false;
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
            icon_size: 24,
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
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);
        textBox.add_child(this._subtitleLabel);
        header.add_child(textBox);

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
        header.add_child(this._appButton);

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

        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            return Clutter.EVENT_PROPAGATE;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            if (this._player && this._length > 0)
                this._player.setPosition(Math.round(this._slider.value * this._length));
            return Clutter.EVENT_PROPAGATE;
        });
        /* Keep the timestamps under the thumb while the user scrubs. */
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._length > 0)
                this._updateTimeLabels(this._slider.value * this._length);
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
        this._playButton = iconButton('media-playback-start-symbolic', 'mc-control-button mc-play-button');
        this._nextButton = iconButton('media-skip-forward-symbolic', 'mc-control-button');

        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());

        controls.add_child(this._prevButton);
        controls.add_child(this._playButton);
        controls.add_child(this._nextButton);
        this.add_child(controls);
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

    _updateTimer() {
        const wanted = this._active && this._player?.isPlaying && this._length > 0;

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
        if (!this._player)
            return;
        this._player.getPosition().then(position => {
            /* The D-Bus round trip can outlive the card or a drag starting. */
            if (this._destroyed || this._dragging)
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

    _updateTimeLabels(position) {
        this._positionLabel.text = formatTime(position);
        this._remainingLabel.text = `-${formatTime(Math.max(0, this._length - position))}`;
    }

    /** Drop any painted art and orphan whatever download is in flight. */
    _clearArt() {
        this._artGeneration++;
        this._currentArtUrl = null;
        this._artBin.style = null;
        this._artFallback.icon_name = 'audio-x-generic-symbolic';
        this._artFallback.visible = true;
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
        if (url === this._currentArtUrl)
            return;

        /* Art resolution is async; a newer track must win even if its download
         * finishes first. */
        this._clearArt();
        this._currentArtUrl = url;
        const generation = this._artGeneration;
        this._artFallback.gicon = player.appIcon;

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
            this._length = 0;
            this._updateArt();
            this._updateTimer();
            return;
        }

        const title = player.title || _('Unknown title');
        const artist = player.artist;
        const album = player.album;

        this._titleLabel.text = title;
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
        this._disconnectPlayer();
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._player = null;
    }
});
