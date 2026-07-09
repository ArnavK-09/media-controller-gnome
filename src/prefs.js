/* prefs.js */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/* Index order must match the enum nicks in the GSettings schema. */
const POSITIONS = ['far-left', 'left', 'center', 'right', 'far-right'];
const POSITION_LABELS = [
    _('Far left'),
    _('Left'),
    _('Center'),
    _('Right'),
    _('Far right'),
];

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

        const positionRow = new Adw.ComboRow({
            title: _('Position'),
            model: Gtk.StringList.new(POSITION_LABELS),
        });
        positionRow.selected = Math.max(0,
            POSITIONS.indexOf(settings.get_string('panel-position')));
        positionRow.connect('notify::selected', row =>
            settings.set_string('panel-position', POSITIONS[row.selected]));
        /* Keep the row honest if the value changes elsewhere (e.g. dconf). */
        settings.connect('changed::panel-position', () => {
            const index = POSITIONS.indexOf(settings.get_string('panel-position'));
            if (index >= 0 && index !== positionRow.selected)
                positionRow.selected = index;
        });
        placement.add(positionRow);

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
        page.add(buttons);

        const text = new Adw.PreferencesGroup({title: _('Track information')});
        text.add(this._switchRow(settings, 'show-player-icon', _('Player icon')));
        text.add(this._switchRow(settings, 'show-title', _('Title')));
        text.add(this._switchRow(settings, 'show-artist', _('Artist')));
        text.add(this._spinRow(settings, 'max-text-length',
            _('Maximum text length'),
            _('Longer text is shortened with an ellipsis.'), 6, 80, 1));
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

        return page;
    }
}
