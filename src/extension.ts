import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Runtime} from './runtime.js';

export default class TokenGrillExtension extends Extension {
    private _runtime: Runtime | null = null;

    override enable(): void {
        this._runtime = new Runtime(this);
        this._runtime.start();
    }

    override disable(): void {
        this._runtime!.stop();
        this._runtime = null;
    }
}
