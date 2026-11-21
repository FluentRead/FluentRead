import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {getSelectionActiveElement, isSelectionTextControl, isTextControlSelectionCurrent,
    readNativeSelection, readTextControlSelection} from '@/src/features/selection-translation/core/selectionSource';

function fixture(tag = 'textarea', type = 'text') {
    const {document} = parseHTML('<html><body></body></html>');
    const element = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
    if (tag === 'input') element.setAttribute('type', type);
    element.value = 'Before selected words after';
    Object.assign(element, {selectionStart: 7, selectionEnd: 21, selectionDirection: 'forward'});
    document.body.append(element);
    return {document, element};
}

describe('native control selection sources', () => {
    it.each(['textarea', 'input:text', 'input:search', 'input:url', 'input:tel'])('reads exactly the selected substring from %s', kind => {
        const [tag, type] = kind.split(':');
        const x = fixture(tag, type);
        const before = x.element.outerHTML;
        expect(isSelectionTextControl(x.element)).toBe(true);
        const source = readTextControlSelection(x.element)!;
        expect(source).toMatchObject({text: 'selected words', start: 7, end: 21, isForward: true});
        expect(x.element.value).toBe('Before selected words after');
        expect(x.element.outerHTML).toBe(before);
        expect(isTextControlSelectionCurrent(source, x.document)).toBe(true);
        x.element.selectionDirection = 'backward';
        expect(readTextControlSelection(x.element)?.isForward).toBe(false);
    });

    it.each(['password', 'email', 'number', 'checkbox', 'file'])('does not read values from unsupported input type %s', type => {
        const x = fixture('input', type);
        const value = vi.spyOn(x.element, 'value', 'get');
        expect(readTextControlSelection(x.element)).toBeNull();
        expect(value).not.toHaveBeenCalled();
    });

    it.each(['disabled', 'collapsed', 'null start', 'null end', 'blank', 'extension UI'])('does not capture %s controls', reason => {
        const x = fixture();
        if (reason === 'disabled') x.element.disabled = true;
        if (reason === 'collapsed') x.element.selectionEnd = x.element.selectionStart;
        if (reason === 'null start') x.element.selectionStart = null;
        if (reason === 'null end') x.element.selectionEnd = null;
        if (reason === 'blank') x.element.value = ' '.repeat(30);
        if (reason === 'extension UI') x.element.setAttribute('data-fluent-read-ui', '');
        expect(readTextControlSelection(x.element)).toBeNull();
    });

    it('revalidates value, connection, document, and input type independently of focus or native highlight', () => {
        const x = fixture();
        const source = readTextControlSelection(x.element)!;
        x.element.selectionStart = x.element.selectionEnd = 0;
        expect(isTextControlSelectionCurrent(source, x.document)).toBe(true);
        x.element.value += '!';
        expect(isTextControlSelectionCurrent(source, x.document)).toBe(false);
        x.element.value = source.value;
        expect(isTextControlSelectionCurrent(source, parseHTML('<html></html>').document)).toBe(false);
        x.element.disabled = true;
        expect(isTextControlSelectionCurrent(source, x.document)).toBe(false);
        x.element.disabled = false; x.element.remove();
        expect(isTextControlSelectionCurrent(source, x.document)).toBe(false);
    });

    it('follows nested active shadow roots and stops a malformed active-element cycle', () => {
        const x = fixture();
        const inner = {shadowRoot: {activeElement: x.element}};
        const outer = {shadowRoot: {activeElement: inner}};
        const document = {activeElement: outer} as unknown as Document;
        expect(getSelectionActiveElement(document)).toBe(x.element);
        inner.shadowRoot.activeElement = outer as any;
        expect(getSelectionActiveElement(document)).toBe(outer);
        expect(getSelectionActiveElement({activeElement: null} as Document)).toBeNull();
        expect(isSelectionTextControl(null)).toBe(false);
        expect(isSelectionTextControl(x.document.body)).toBe(false);
    });

    it('keeps active editor proxy textareas usable without relying on visible native geometry', () => {
        const x = fixture();
        x.element.setAttribute('aria-hidden', 'true');x.element.setAttribute('style', 'width:0;height:0;opacity:0');
        expect(readTextControlSelection(x.element)?.text).toBe('selected words');
        const shadow = x.document.createElement('custom-editor').attachShadow({mode: 'open'});
        shadow.append(x.element);shadow.host.setAttribute('data-fluent-read-ui', '');
        x.document.body.append(shadow.host);
        expect(readTextControlSelection(x.element)).toBeNull();
    });

    it('bounds a cyclic composed ancestor chain without reading the control value', () => {
        const x = fixture();
        const value = vi.spyOn(x.element, 'value', 'get');
        Object.defineProperty(x.element, 'parentElement', {value: x.element});
        expect(readTextControlSelection(x.element)).toBeNull();
        expect(value).not.toHaveBeenCalled();
    });
});

describe('native selections in composed DOM', () => {
    const selected = () => ({isCollapsed: false, rangeCount: 1, toString: () => 'Selected editor text'}) as Selection;
    it('prefers the selection root from the interaction path and falls back when roots are unavailable or stale', () => {
        const selection = selected();
        const view = {getSelection: vi.fn(() => null)};
        const document = {activeElement: null} as Document;
        const root = {nodeType: 11, getSelection: vi.fn(() => selection)};
        const target = {getRootNode: () => root};
        expect(readNativeSelection(view, document, [target as unknown as EventTarget, root as unknown as EventTarget])).toBe(selection);
        expect(root.getSelection).toHaveBeenCalledOnce();expect(view.getSelection).not.toHaveBeenCalled();
        root.getSelection.mockImplementation(() => {throw Error('detached root');});
        expect(readNativeSelection(view, document, [target as unknown as EventTarget])).toBeNull();
        expect(readNativeSelection(view, document, [{} as EventTarget])).toBeNull();
        const rootWithoutApi = {nodeType: 11};
        expect(readNativeSelection(view, document, [rootWithoutApi as unknown as EventTarget])).toBeNull();
    });

    it.each(['null', 'collapsed', 'empty range', 'blank text'])('falls back from a root with %s selection', reason => {
        const fallback = selected(), rootSelection = selected();
        if (reason === 'collapsed') Object.assign(rootSelection, {isCollapsed: true});
        if (reason === 'empty range') Object.assign(rootSelection, {rangeCount: 0});
        if (reason === 'blank text') rootSelection.toString = () => ' ';
        const root = {nodeType: 11, getSelection: () => reason === 'null' ? null : rootSelection};
        const document = {activeElement: {getRootNode: () => root}} as unknown as Document;
        expect(readNativeSelection({getSelection: () => fallback}, document)).toBe(fallback);
    });
});
