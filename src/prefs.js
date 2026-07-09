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

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'user-home-symbolic',
        });

        const placement = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('Where the indicator sits in the top panel.'),
        });

        placement.add(this._comboRow(settings, 'panel-position', _('Position'),
            POSITIONS, positionLabels()));

        placement.add(this._switchRow(settings, 'controls-on-left',
            _('Controls before text'),
            _('Show the playback buttons to the left of the track title.')));
        placement.add(this._switchRow(settings, 'hide-when-inactive',
            _('Hide when nothing is playing'),
            _('Remove the indicator from the panel when no player is running.')));
        page.add(placement);

        const buttons = new Adw.PreferencesGroup({
            title: _('Buttons'),
            description: _('Which playback controls appear in the panel.'),
        });
        buttons.add(this._switchRow(settings, 'show-previous', _('Previous')));
        buttons.add(this._switchRow(settings, 'show-play-pause', _('Play / Pause')));
        buttons.add(this._switchRow(settings, 'show-next', _('Next')));
        buttons.add(this._switchRow(settings, 'show-seek-backward',
            _('Skip backward'),
            _('Only shown for players that support seeking.')));
        buttons.add(this._switchRow(settings, 'show-seek-forward',
            _('Skip forward'),
            _('Only shown for players that support seeking.')));
        page.add(buttons);

        const text = new Adw.PreferencesGroup({title: _('Track information')});
        text.add(this._switchRow(settings, 'show-player-icon', _('Player icon')));
        text.add(this._switchRow(settings, 'show-title', _('Title')));
        text.add(this._switchRow(settings, 'show-artist', _('Artist')));
        text.add(this._spinRow(settings, 'panel-text-width',
            _('Text width'),
            _('In pixels. The track text always occupies this width.'), 60, 600, 10));
        text.add(this._switchRow(settings, 'scroll-text',
            _('Scroll long text'),
            _('Loop text that does not fit instead of cutting it off.')));

        const loop = this._switchRow(settings, 'scroll-loop',
            _('Scroll continuously'),
            _('Off: the text scrolls once each time the track changes.'));
        settings.bind('scroll-text', loop, 'sensitive', Gio.SettingsBindFlags.GET);
        text.add(loop);

        const direction = this._comboRow(settings, 'scroll-direction',
            _('Scrolling direction'), DIRECTIONS, directionLabels());
        settings.bind('scroll-text', direction, 'sensitive', Gio.SettingsBindFlags.GET);
        text.add(direction);

        const speed = this._spinRow(settings, 'scroll-speed',
            _('Scrolling speed'), _('In pixels per second.'), 10, 120, 5);
        settings.bind('scroll-text', speed, 'sensitive', Gio.SettingsBindFlags.GET);
        text.add(speed);
        page.add(text);

        return page;
    }

    _cardPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Card'),
            icon_name: 'audio-x-generic-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Now playing card'),
            description: _('Shown when you click the indicator.'),
        });
        group.add(this._switchRow(settings, 'card-show-art', _('Album art')));
        group.add(this._switchRow(settings, 'card-show-seek-bar',
            _('Seek bar'),
            _('Only shown for players that report a track length.')));
        group.add(this._spinRow(settings, 'card-width',
            _('Card width'), _('In pixels.'), 280, 560, 10));
        page.add(group);

        const skip = new Adw.PreferencesGroup({
            title: _('Skip buttons'),
            description: _('Jump backward and forward within the current track.'),
        });
        skip.add(this._switchRow(settings, 'card-show-seek-buttons',
            _('Show skip buttons'),
            _('Only shown for players that support seeking.')));
        skip.add(this._spinRow(settings, 'seek-step-seconds',
            _('Skip amount'),
            _('In seconds. Also used by the panel skip buttons.'), 2, 20, 1));
        page.add(skip);

        return page;
    }
}
