// SPDX-License-Identifier: GPL-2.0-or-later
/* prefs.js */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/* Index order must match the enum nicks in the GSettings schema. */
const POSITIONS = ['far-left', 'left', 'center', 'right', 'far-right'];
const DIRECTIONS = ['left-to-right', 'right-to-left'];

/* Must be a function, not a top-level constant: gettext resolves the calling
 * extension from the stack, and at module scope no extension is registered yet. */
function positionLabels() {
    return [
        _('Far left'),
        _('Left'),
        _('Center'),
        _('Right'),
        _('Far right'),
    ];
}

function directionLabels() {
    return [
        _('Left to right'),
        _('Right to left'),
    ];
}

export default class MediaControllerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 720);

        window.add(this._panelPage(settings));
        window.add(this._cardPage(settings));
    }

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /* Adw.ComboRow has no GSettings binding for enums, so the nick list and the
     * row's index are kept in step by hand, in both directions. */
    _comboRow(settings, key, title, nicks, labels) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
        row.selected = Math.max(0, nicks.indexOf(settings.get_string(key)));
        row.connect('notify::selected', () =>
            settings.set_string(key, nicks[row.selected]));
        /* Keep the row honest if the value changes elsewhere (e.g. dconf). */
        settings.connect(`changed::${key}`, () => {
            const index = nicks.indexOf(settings.get_string(key));
            if (index >= 0 && index !== row.selected)
                row.selected = index;
        });
        return row;
    }

    _spinRow(settings, key, title, subtitle, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 5,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /* Grey a row out while the feature it configures is switched off. */
    _bindSensitive(settings, key, row) {
        settings.bind(key, row, 'sensitive', Gio.SettingsBindFlags.GET);
        return row;
    }

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'user-home-symbolic',
        });

        const placement = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('Where the indicator appears in the top panel.'),
        });
        placement.add(this._comboRow(settings, 'panel-position', _('Position'),
            POSITIONS, positionLabels()));
        placement.add(this._switchRow(settings, 'controls-on-left',
            _('Show controls before track information'),
            _('Place the playback buttons to the left of the player icon and text.')));
        placement.add(this._switchRow(settings, 'hide-when-inactive',
            _('Hide when nothing is playing'),
            _('Remove the indicator from the panel while no media player is running.')));
        page.add(placement);

        /* Listed in the order they appear on screen. */
        const buttons = new Adw.PreferencesGroup({
            title: _('Playback controls'),
            description: _('Which buttons appear in the panel.'),
        });
        buttons.add(this._switchRow(settings, 'show-previous', _('Previous track')));
        buttons.add(this._switchRow(settings, 'show-seek-backward',
            _('Skip backward'),
            _('Requires a player that supports seeking.')));
        buttons.add(this._switchRow(settings, 'show-play-pause', _('Play and pause')));
        buttons.add(this._switchRow(settings, 'show-seek-forward',
            _('Skip forward'),
            _('Requires a player that supports seeking.')));
        buttons.add(this._switchRow(settings, 'show-next', _('Next track')));
        page.add(buttons);

        const text = new Adw.PreferencesGroup({
            title: _('Track information'),
            description: _('What the indicator shows about the current track.'),
        });
        text.add(this._switchRow(settings, 'show-player-icon', _('Player icon')));
        text.add(this._switchRow(settings, 'show-title', _('Track title')));
        text.add(this._switchRow(settings, 'show-artist', _('Artist')));
        text.add(this._spinRow(settings, 'panel-text-width',
            _('Text width'),
            _('Width reserved for the track text, in pixels. The indicator keeps this width whatever is playing.'),
            60, 600, 10));
        page.add(text);

        const scrolling = new Adw.PreferencesGroup({
            title: _('Scrolling text'),
            description: _('What happens when the track text is wider than the reserved width.'),
        });
        scrolling.add(this._switchRow(settings, 'scroll-text',
            _('Scroll the text'),
            _('When off, text that does not fit is shortened with an ellipsis.')));
        scrolling.add(this._bindSensitive(settings, 'scroll-text',
            this._switchRow(settings, 'scroll-loop',
                _('Repeat'),
                _('Scroll continuously. When off, the text scrolls once for each new track.'))));
        scrolling.add(this._bindSensitive(settings, 'scroll-text',
            this._comboRow(settings, 'scroll-direction', _('Direction'),
                DIRECTIONS, directionLabels())));
        scrolling.add(this._bindSensitive(settings, 'scroll-text',
            this._spinRow(settings, 'scroll-speed',
                _('Speed'), _('Pixels per second.'), 10, 120, 5)));
        page.add(scrolling);

        return page;
    }

    _cardPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Card'),
            icon_name: 'audio-x-generic-symbolic',
        });

        const appearance = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('The card is shown when you click the panel indicator.'),
        });
        appearance.add(this._switchRow(settings, 'card-show-art',
            _('Album art'),
            _('Falls back to the player icon when the track has no artwork.')));
        appearance.add(this._spinRow(settings, 'card-width',
            _('Card width'), _('Measured in pixels.'), 280, 560, 10));
        page.add(appearance);

        const playback = new Adw.PreferencesGroup({
            title: _('Playback'),
            description: _('Controls for moving within the current track.'),
        });
        playback.add(this._switchRow(settings, 'card-show-seek-bar',
            _('Seek bar'),
            _('Requires a player that reports the track length.')));
        playback.add(this._switchRow(settings, 'card-show-seek-buttons',
            _('Skip buttons'),
            _('Requires a player that supports seeking.')));
        playback.add(this._spinRow(settings, 'seek-step-seconds',
            _('Skip amount'),
            _('How far the skip buttons jump, in seconds. Shared with the panel skip buttons.'),
            2, 20, 1));
        page.add(playback);

        return page;
    }
}
