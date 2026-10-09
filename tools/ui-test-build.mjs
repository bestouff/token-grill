import {build} from 'esbuild';
import path from 'node:path';

// Exercise the real rendering decisions without needing a running compositor.
const actorModule = `
class Actor {
  constructor(properties = {}) { Object.assign(this, properties); this.children = []; this.mockType = this.constructor.name; }
  add_child(child) { this.children.push(child); }
  get_children() { return this.children; }
  set_accessible_name(name) { this.accessible_name = name; }
  set_position() {}
  set_size() {}
  connect() { return 1; }
  destroy() {}
}
${['BoxLayout', 'Widget', 'Icon', 'Label', 'DrawingArea', 'Button', 'Bin'].map(name => `class ${name} extends Actor {}`).join('\n')}
export default {BoxLayout, Widget, Icon, Label, DrawingArea, Button, Bin};
`;
const modules = {
    'gi://St': actorModule,
    'gi://Clutter': 'export default {ActorAlign: {CENTER: 1}, FixedLayout: class FixedLayout {}};',
    'gi://Gio': 'export default {icon_new_for_string: path => path};',
    'gi://GLib': 'export default {};',
    'gi://GObject': 'export default {registerClass: klass => klass};',
    'resource:///org/gnome/shell/ui/main.js': 'export function getStyleVariant() { return globalThis.__shellStyleVariant ?? "dark"; }',
    'resource:///org/gnome/shell/extensions/extension.js': 'export const gettext = text => text;',
    'resource:///org/gnome/shell/ui/panelMenu.js': 'export class Button {}',
    'resource:///org/gnome/shell/ui/popupMenu.js': 'export class PopupMenuSection {} export class PopupBaseMenuItem {}',
};
await build({
    stdin: {contents: 'export * from "./src/shell/accountChip.ts"; export * from "./src/shell/indicator.ts";', resolveDir: process.cwd()},
    bundle: true, format: 'esm', platform: 'node', outfile: path.join('build', 'tests', 'shell-ui.mjs'),
    plugins: [{name: 'shell-test-platform', setup(builder) {
        builder.onResolve({filter: /^(gi:\/\/|resource:\/\/)/}, args => ({path: args.path, namespace: 'mock'}));
        builder.onLoad({filter: /.*/, namespace: 'mock'}, args => {
            if (!(args.path in modules)) throw new Error(`Missing Shell test platform module: ${args.path}`);
            return {contents: modules[args.path], loader: 'js'};
        });
    }}],
});
