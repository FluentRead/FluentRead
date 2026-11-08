import {parseHTML} from 'linkedom';
import {afterAll, beforeAll} from 'vitest';

// Vue's native input binding checks the root against the DOM constructors.
// Leave the document and window owned by each component fixture.
const installed = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
    const {window} = parseHTML('');
    for (const name of ['Document', 'ShadowRoot'] as const) {
        if (typeof globalThis[name] === 'function') continue;
        installed.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, {configurable: true, writable: true, value: window[name]});
    }
});

afterAll(() => {
    for (const [name, descriptor] of installed) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    installed.clear();
});

export function getFixtureRootNode<Node extends {parent?: Node}>(this: Node): Node {
    let root = this;
    while (root.parent) root = root.parent;
    return root;
}
