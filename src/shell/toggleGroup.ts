// An St version of libadwaita's AdwToggleGroup (GTK widgets cannot run inside
// GNOME Shell).  The look lives in stylesheet.css; PopupMenu's focus navigation
// already moves between segments with the arrow keys.
import Atk from 'gi://Atk';
import type Clutter from 'gi://Clutter';
import St from 'gi://St';

export interface ToggleItem {
    id: string;
    child: Clutter.Actor;
    accessibleName: string;
    checked: boolean;
    onActivate: () => void;
}

export interface ToggleSegment {
    id: string;
    button: St.Button;
}

// The flat variant is the secondary level, so only one level reads as the primary choice.
export function createToggleGroup(items: ToggleItem[], flat: boolean): {group: St.BoxLayout; segments: ToggleSegment[]} {
    const group = new St.BoxLayout({
        style_class: flat ? 'tokengrill-flat-toggle-group' : 'tokengrill-toggle-group',
        x_expand: true,
    });
    const segments = items.map(item => {
        const button = new St.Button({
            style_class: flat ? 'tokengrill-flat-toggle' : 'tokengrill-toggle',
            can_focus: true,
            x_expand: true,
            child: item.child,
            checked: item.checked,
            accessible_name: item.accessibleName,
            accessible_role: Atk.Role.RADIO_BUTTON,
        });
        button.connectObject('clicked', () => item.onActivate(), button);
        group.add_child(button);
        return {id: item.id, button};
    });
    return {group, segments};
}
