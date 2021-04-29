'use strict';

/* exported init enable disable */

const { GObject, Gio, Meta, Shell } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();

let settings = null;

let current_window = null;

let bus_watch_id = null;
let dbus_action_group = null;

let wayland_client = null;
let subprocess = null;

const APP_ID = 'com.github.amezin.ddterm';
const APP_DBUS_PATH = '/com/github/amezin/ddterm';
const WINDOW_PATH_PREFIX = `${APP_DBUS_PATH}/window/`;
const SUBPROCESS_ARGV = [Me.dir.get_child('com.github.amezin.ddterm').get_path(), '--undecorated'];
const IS_WAYLAND_COMPOSITOR = Meta.is_wayland_compositor();
const USE_WAYLAND_CLIENT = Meta.WaylandClient && IS_WAYLAND_COMPOSITOR;
const SIGINT = 2;

class ExtensionDBusInterface {
    constructor() {
        let [_, xml] = Me.dir.get_child('com.github.amezin.ddterm.Extension.xml').load_contents(null);
        this.dbus = Gio.DBusExportedObject.wrapJSObject(ByteArray.toString(xml), this);
    }

    BeginResize() {
        if (!current_window || !current_window.maximized_vertically)
            return;

        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);
    }

    Toggle() {
        toggle();
    }

    Activate() {
        activate();
    }
}

const DBUS_INTERFACE = new ExtensionDBusInterface().dbus;

class WaylandClientStub {
    constructor(subprocess_launcher) {
        this.subprocess_launcher = subprocess_launcher;
    }

    spawnv(_display, argv) {
        return this.subprocess_launcher.spawnv(argv);
    }

    hide_from_window_list(_win) {
    }

    show_in_window_list(_win) {
    }

    owns_window(_win) {
        return true;
    }
}

function init() {
}

function enable() {
    disconnect_settings();
    settings = imports.misc.extensionUtils.getSettings();

    Main.wm.addKeybinding(
        'ddterm-toggle-hotkey',
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        toggle
    );
    Main.wm.addKeybinding(
        'ddterm-activate-hotkey',
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        activate
    );

    stop_dbus_watch();
    bus_watch_id = Gio.bus_watch_name(
        Gio.BusType.SESSION,
        APP_ID,
        Gio.BusNameWatcherFlags.NONE,
        dbus_appeared,
        dbus_disappeared
    );

    disconnect_global_handlers();
    global.display.connect('window-created', handle_created);
    global.display.connect('notify::focus-window', focus_window_changed);
    global.display.connect('grab-op-end', handle_end_grab);

    settings.connect('changed::window-above', set_window_above);
    settings.connect('changed::window-stick', set_window_stick);
    settings.connect('changed::window-height', update_window_geometry);
    settings.connect('changed::window-width', update_window_geometry);
    settings.connect('changed::window-horizontal-alignment', update_window_geometry);
    settings.connect('changed::window-vertical-alignment', update_window_geometry);
    settings.connect('changed::window-skip-taskbar', set_skip_taskbar);

    DBUS_INTERFACE.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/ddterm');
}

function disable() {
    DBUS_INTERFACE.unexport();

    if (Main.sessionMode.allowExtensions) {
        // Stop the app only if the extension isn't being disabled because of
        // lock screen/switch to other mode where extensions aren't allowed.
        // Because when the session switches back to normal mode we want to
        // keep all open terminals.
        if (dbus_action_group)
            dbus_action_group.activate_action('quit', null);
        else if (subprocess)
            subprocess.send_signal(SIGINT);
    }

    stop_dbus_watch();
    dbus_action_group = null;

    disconnect_global_handlers();

    Main.wm.removeKeybinding('ddterm-toggle-hotkey');
    Main.wm.removeKeybinding('ddterm-activate-hotkey');

    disconnect_settings();
}

function spawn_app() {
    if (subprocess)
        return;

    const subprocess_launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE);

    const context = global.create_app_launch_context(0, -1);
    subprocess_launcher.set_environ(context.get_environment());

    let argv = SUBPROCESS_ARGV;

    if (settings.get_boolean('force-x11-gdk-backend')) {
        const prev_gdk_backend = subprocess_launcher.getenv('GDK_BACKEND');

        if (prev_gdk_backend === null)
            argv = argv.concat(['--unset-gdk-backend']);
        else
            argv = argv.concat(['--reset-gdk-backend', prev_gdk_backend]);

        subprocess_launcher.setenv('GDK_BACKEND', 'x11', true);
    }

    if (USE_WAYLAND_CLIENT && subprocess_launcher.getenv('GDK_BACKEND') !== 'x11')
        wayland_client = Meta.WaylandClient.new(subprocess_launcher);
    else
        wayland_client = new WaylandClientStub(subprocess_launcher);

    subprocess = wayland_client.spawnv(global.display, argv);
    subprocess.wait_async(null, subprocess_terminated);
}

function subprocess_terminated(source) {
    if (subprocess === source) {
        subprocess = null;
        wayland_client = null;
    }
}

function toggle() {
    if (dbus_action_group)
        dbus_action_group.activate_action('toggle', null);
    else
        spawn_app();
}

function activate() {
    if (current_window)
        Main.activateWindow(current_window);
    else
        toggle();
}

function dbus_appeared(connection, name) {
    dbus_action_group = Gio.DBusActionGroup.get(connection, name, APP_DBUS_PATH);
}

function dbus_disappeared() {
    dbus_action_group = null;
}

function handle_created(display, win) {
    const handler_ids = [
        win.connect('notify::gtk-application-id', track_window),
        win.connect('notify::gtk-window-object-path', track_window),
    ];

    const disconnect = () => {
        handler_ids.forEach(handler => win.disconnect(handler));
    };

    handler_ids.push(win.connect('unmanaging', disconnect));
    handler_ids.push(win.connect('unmanaged', disconnect));

    track_window(win);
}

function focus_window_changed() {
    if (!current_window || current_window.is_hidden())
        return;

    if (!settings || !settings.get_boolean('hide-when-focus-lost'))
        return;

    const win = global.display.focus_window;
    if (win !== null) {
        if (current_window === win || current_window.is_ancestor_of_transient(win))
            return;
    }

    if (dbus_action_group)
        dbus_action_group.activate_action('hide', null);
}

function is_dropdown_terminal_window(win) {
    if (!wayland_client) {
        // On X11, shell can be restarted, and the app will keep running.
        // Accept windows from previously launched app instances.
        if (IS_WAYLAND_COMPOSITOR)
            return false;
    } else if (!wayland_client.owns_window(win)) {
        return false;
    }

    return (
        win.gtk_application_id === APP_ID &&
        win.gtk_window_object_path &&
        win.gtk_window_object_path.startsWith(WINDOW_PATH_PREFIX)
    );
}

function set_window_above() {
    if (current_window === null)
        return;

    if (settings.get_boolean('window-above'))
        current_window.make_above();
    else
        current_window.unmake_above();
}

function set_window_stick() {
    if (current_window === null)
        return;

    if (settings.get_boolean('window-stick'))
        current_window.stick();
    else
        current_window.unstick();
}

function set_skip_taskbar() {
    if (!current_window || !wayland_client)
        return;

    if (settings.get_boolean('window-skip-taskbar'))
        wayland_client.hide_from_window_list(current_window);
    else
        wayland_client.show_in_window_list(current_window);
}

function track_window(win) {
    if (!is_dropdown_terminal_window(win)) {
        untrack_window(win);
        return;
    }

    if (win === current_window)
        return;

    current_window = win;

    win.connect('unmanaging', untrack_window);
    win.connect('unmanaged', untrack_window);

    win.connect('notify::maximized-vertically', unmaximize_window_vertically);
    win.connect('notify::maximized-horizontally', unmaximize_window_horizontally);

    const workarea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.currentMonitor.index);
    const target_rect = target_rect_for_workarea(workarea);

    move_resize_window(win, target_rect);

    // https://github.com/amezin/gnome-shell-extension-ddterm/issues/28
    win.connect('shown', update_window_geometry);
    win.connect('position-changed', update_window_geometry);

    Main.activateWindow(win);

    set_window_above();
    set_window_stick();
    set_skip_taskbar();
}

function workarea_for_window(win) {
    // Can't use window.monitor here - it's out of sync
    const monitor = global.display.get_monitor_index_for_rect(win.get_frame_rect());
    if (monitor < 0)
        return null;

    return Main.layoutManager.getWorkAreaForMonitor(monitor);
}

function target_rect_for_workarea(workarea) {
    const width = Math.round(workarea.width * settings.get_double('window-width')),
        height = Math.round(workarea.height * settings.get_double('window-height')),
        horizontal_alignment = settings.get_string('window-horizontal-alignment'),
        vertical_alignment = settings.get_string('window-vertical-alignment');
    let x, y;
    switch (horizontal_alignment) {
    case 'left':
        x = workarea.x;
        break;
    case 'right':
        x = workarea.width + workarea.x - width;
        break;
    case 'center':
        x = workarea.x + Math.round((workarea.width - width) / 2);
        break;
    }
    switch (vertical_alignment) {
    case 'top':
        y = workarea.y;
        break;
    case 'bottom':
        y = workarea.height + workarea.y - height;
        break;
    case 'center':
        y = workarea.y + Math.round((workarea.height - height) / 2);
        break;
    }
    return new Meta.Rectangle({ x, y, width, height });
}

function unmaximize_window_vertically(win) {
    if (!win || win !== current_window)
        return;

    if (!win.maximized_vertically)
        return;

    const workarea = workarea_for_window(current_window);
    const target_rect = target_rect_for_workarea(workarea);

    if (target_rect.height < workarea.height)
        win.unmaximize(Meta.MaximizeFlags.VERTICAL);
}

function unmaximize_window_horizontally(win) {
    if (!win || win !== current_window)
        return;

    if (!win.maximized_horizontally)
        return;

    const workarea = workarea_for_window(current_window);
    const target_rect = target_rect_for_workarea(workarea);

    if (target_rect.width < workarea.width)
        win.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
}

function move_resize_window(win, target_rect) {
    win.move_resize_frame(false, target_rect.x, target_rect.y, target_rect.width, target_rect.height);
}

function update_height_setting(win) {
    if (!win || win !== current_window)
        return;

    if (win.maximized_vertically)
        return;

    const workarea = workarea_for_window(win);
    const current_height = win.get_frame_rect().height / workarea.height;
    settings.set_double('window-height', Math.min(1.0, current_height));
}

function update_window_geometry() {
    if (!current_window)
        return;

    const workarea = workarea_for_window(current_window);
    if (!workarea)
        return;

    const target_rect = target_rect_for_workarea(workarea);
    if (target_rect.equal(current_window.get_frame_rect()))
        return;

    if (current_window.maximized_vertically && target_rect.height < workarea.height) {
        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);
    }

    if (current_window.maximized_horizontally && target_rect.width < workarea.width) {
        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
    }

    move_resize_window(current_window, target_rect);
}

function handle_end_grab(display, p0, p1) {
    // On Mutter <=3.38 p0 is display too. On 40 p0 is the window.
    const win = p0 instanceof Meta.Window ? p0 : p1;

    if (win === current_window)
        update_height_setting(win);
}

function untrack_window(win) {
    // Sometimes, frame rect is updated after grab-op-end.
    update_height_setting(win);

    if (win === current_window)
        current_window = null;

    if (win) {
        GObject.signal_handlers_disconnect_by_func(win, untrack_window);
        GObject.signal_handlers_disconnect_by_func(win, update_height_setting);
        GObject.signal_handlers_disconnect_by_func(win, unmaximize_window_vertically);
        GObject.signal_handlers_disconnect_by_func(win, unmaximize_window_horizontally);
        GObject.signal_handlers_disconnect_by_func(win, update_window_geometry);
    }
}

function stop_dbus_watch() {
    if (bus_watch_id) {
        Gio.bus_unwatch_name(bus_watch_id);
        bus_watch_id = null;
    }
}

function disconnect_global_handlers() {
    GObject.signal_handlers_disconnect_by_func(global.display, handle_created);
    GObject.signal_handlers_disconnect_by_func(global.display, focus_window_changed);
    GObject.signal_handlers_disconnect_by_func(global.display, handle_end_grab);
}

function disconnect_settings() {
    if (settings) {
        GObject.signal_handlers_disconnect_by_func(settings, set_window_above);
        GObject.signal_handlers_disconnect_by_func(settings, set_window_stick);
        GObject.signal_handlers_disconnect_by_func(settings, update_window_geometry);
        GObject.signal_handlers_disconnect_by_func(settings, set_skip_taskbar);
    }
}
