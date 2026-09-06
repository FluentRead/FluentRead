import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {presentationMatchesSource, resolveImagePresentation, surfaceStyleToBitmap} from '@/src/features/image-translation/content/presentation';

type Style = Partial<CSSStyleDeclaration> & {backgroundImage?: string};

function fixture(options: {opacity?: string; visibility?: string; background?: string; candidateOpacity?: string; candidateDisplay?: string; candidateVisibility?: string; duplicate?: boolean; overlap?: boolean; geometryMismatch?: boolean; noParent?: boolean; noSource?: boolean} = {}) {
    const {document} = parseHTML('<html><body><div id="surface"><img src="https://pbs.twimg.com/media/source.png"><div id="paint"></div></div></body></html>');
    const image = document.querySelector('img') as HTMLImageElement;
    const paint = document.querySelector('#paint') as HTMLDivElement;
    const duplicate = options.duplicate ? document.createElement('div') : null;
    const overlap = options.overlap ? document.createElement('div') : null;
    if (duplicate) document.querySelector('#surface')!.append(duplicate);
    if (overlap) document.querySelector('#surface')!.append(overlap);
    const styles = new Map<Element, Style>();
    styles.set(image, {display: 'block', visibility: options.visibility ?? 'visible', opacity: options.opacity ?? '1', backgroundImage: 'none'});
    styles.set(paint, {display: options.candidateDisplay ?? 'block', visibility: options.candidateVisibility ?? 'visible', opacity: options.candidateOpacity ?? '1', backgroundImage: options.background ?? 'none', backgroundSize: 'cover', backgroundPosition: 'right bottom'});
    if (duplicate) styles.set(duplicate, {display: 'block', visibility: 'visible', opacity: '1', backgroundImage: options.background ?? 'none'});
    if (overlap) styles.set(overlap, {display: 'block', visibility: 'visible', opacity: '1', backgroundImage: 'url("https://example.test/other.png")'});
    const rect = {left: 20, top: 40, right: 420, bottom: 240, width: 400, height: 200} as DOMRect;
    image.getBoundingClientRect = () => rect;
    paint.getBoundingClientRect = () => options.geometryMismatch ? {...rect, width: 399} as DOMRect : rect;
    if (duplicate) duplicate.getBoundingClientRect = () => rect;
    if (overlap) overlap.getBoundingClientRect = () => rect;
    if (options.noSource) image.removeAttribute('src');
    if (options.noParent) image.remove();
    vi.stubGlobal('getComputedStyle', (element: Element) => styles.get(element) || {display: 'block', visibility: 'visible', opacity: '1', backgroundImage: 'none'});
    return {image, paint, duplicate, overlap, styles, document};
}

afterEach(() => vi.unstubAllGlobals());

describe('image presentation surface resolution', () => {
    it('uses a visible img by default', () => {
        const env = fixture();
        expect(resolveImagePresentation(env.image)).toEqual({element: env.image, kind: 'image'});
    });

    it('uses the unique matching background sibling for a hidden img', () => {
        const env = fixture({opacity: '0', background: 'url("https://pbs.twimg.com/media/source.png")'});
        expect(resolveImagePresentation(env.image)).toEqual({element: env.paint, kind: 'background'});
    });

    it('falls back when the image is hidden without a matching surface', () => {
        const env = fixture({opacity: '0'});
        expect(resolveImagePresentation(env.image)).toEqual({element: env.image, kind: 'image'});
        expect(resolveImagePresentation(fixture({opacity: ''}).image).kind).toBe('image');
    });

    it('falls back without a parent, source, or matching geometry', () => {
        expect(resolveImagePresentation(fixture({opacity: '0', noParent: true}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', noSource: true}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', geometryMismatch: true, background: 'url(https://pbs.twimg.com/media/source.png)'}).image).kind).toBe('image');
    });

    it('falls back when opacity zero is paired with display or visibility hiding', () => {
        expect(resolveImagePresentation(fixture({opacity: '0', visibility: 'hidden', background: 'url(https://pbs.twimg.com/media/source.png)'}).image).kind).toBe('image');
    });

    it('falls back for duplicate, hidden, multi-background, and overlapping surfaces', () => {
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png), url(other.png)'}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', duplicate: true}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', candidateOpacity: '0'}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', candidateOpacity: 'invalid'}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', candidateOpacity: ''}).image).kind).toBe('background');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', overlap: true}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', candidateDisplay: 'none'}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', candidateVisibility: 'collapse'}).image).kind).toBe('image');
    });

    it('accepts quoted and unquoted single URLs but rejects empty or unsupported background values', () => {
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)'}).image).kind).toBe('background');
        expect(resolveImagePresentation(fixture({opacity: '0', background: "url('https://pbs.twimg.com/media/source.png')"}).image).kind).toBe('background');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'url()'}).image).kind).toBe('image');
        expect(resolveImagePresentation(fixture({opacity: '0', background: 'linear-gradient(red, blue)'}).image).kind).toBe('image');
    });

    it('maps background sizing and position to bitmap properties', () => {
        expect(surfaceStyleToBitmap({backgroundSize: 'cover', backgroundPosition: 'right bottom'})).toEqual({objectFit: 'cover', objectPosition: 'right bottom'});
        expect(surfaceStyleToBitmap({backgroundSize: 'contain', backgroundPosition: 'center'})).toEqual({objectFit: 'contain', objectPosition: 'center'});
        expect(surfaceStyleToBitmap({backgroundSize: 'auto', backgroundPosition: ''})).toEqual({objectFit: 'none', objectPosition: '50% 50%'});
    });

    it('validates source ownership while ignoring the leased opacity', () => {
        const env = fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)'});
        const presentation = resolveImagePresentation(env.image);
        expect(presentationMatchesSource(env.image, presentation)).toBe(true);
        expect(presentationMatchesSource(env.image, {element: env.image, kind: 'image'})).toBe(true);
        env.styles.set(env.paint, {display: 'block', visibility: 'visible', opacity: '0', backgroundImage: 'url(https://example.test/changed.png)'});
        expect(presentationMatchesSource(env.image, presentation)).toBe(false);
        env.styles.set(env.paint, {display: 'block', visibility: 'visible', opacity: '0', backgroundImage: undefined});
        expect(presentationMatchesSource(env.image, presentation)).toBe(false);
        expect(presentationMatchesSource(env.image, {element: env.document.createElement('div'), kind: 'background'})).toBe(false);
        expect(presentationMatchesSource(env.image, {element: env.image, kind: 'background'})).toBe(false);
        expect(presentationMatchesSource(env.image, {element: env.paint, kind: 'background'})).toBe(false);
        const detached = fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)'});
        const detachedPresentation = resolveImagePresentation(detached.image);
        detached.image.remove();
        expect(presentationMatchesSource(detached.image, detachedPresentation)).toBe(false);

        const overlap = fixture({opacity: '0', background: 'url(https://pbs.twimg.com/media/source.png)', overlap: true});
        overlap.styles.set(overlap.overlap!, {display: 'block', visibility: 'visible', opacity: '1', backgroundImage: undefined});
        expect(resolveImagePresentation(overlap.image).kind).toBe('background');
    });

    it('uses defaults for missing surface style fields', () => {
        expect(surfaceStyleToBitmap({backgroundSize: undefined as never, backgroundPosition: undefined as never})).toEqual({objectFit: 'fill', objectPosition: '50% 50%'});
        expect(surfaceStyleToBitmap({backgroundSize: 'cover', backgroundPosition: '   '})).toEqual({objectFit: 'cover', objectPosition: '50% 50%'});
    });
});
