// @ts-nocheck
import Clutter from 'gi://Clutter';

export function makeShellInteractive(actor, accessibleName = null) {
    actor.reactive = true;
    actor.can_focus = true;
    actor.track_hover = true;
    // Let Clutter resolve the cursor for this actor directly.  This remains
    // reliable when St.Button consumes crossing events internally.
    actor.set_cursor_type(Clutter.CursorType.POINTER);
    if (accessibleName) actor.set_accessible_name(accessibleName);
    // St.Button consumes pointer crossing events in some Shell themes. Its
    // tracked hover property is reliable across GNOME 48–50.
    const hover = actor.connect('notify::hover', () => {
        const active = Boolean(actor.hover && actor.reactive);
        if (active) actor.add_style_class_name('tokengrill-hover');
        else actor.remove_style_class_name('tokengrill-hover');
    });
    const reactive = actor.connect('notify::reactive', () => {
        actor.set_cursor_type(actor.reactive ? Clutter.CursorType.POINTER : Clutter.CursorType.DEFAULT);
    });
    actor._tokengrillInteraction = {hover, reactive};
    return actor;
}

export function resetShellCursor() {
    global.stage.set_cursor_type(Clutter.CursorType.DEFAULT);
}

export function clearShellInteraction(actor) {
    const ids = actor._tokengrillInteraction;
    if (ids) for (const id of Object.values(ids)) actor.disconnect(id);
    actor.set_cursor_type(Clutter.CursorType.DEFAULT);
    resetShellCursor();
}
