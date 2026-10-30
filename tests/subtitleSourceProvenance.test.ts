import {describe, expect, it} from 'vitest';
import {parseYoutubeTimedTextDocument, provenanceMatchesCues, provenanceWeight} from '@/src/features/video-subtitle/content/subtitleSourceProvenance';
import {parseYoutubeTimedTextResponse, finalizeVideoSubtitleCues, cuesToSrt} from '@/src/features/video-subtitle/content/youtubeSubtitleData';
import {TimedTextTrackCache} from '@/src/features/video-subtitle/content/timedTextTrackCache';
const event = (text: string, tStartMs = 0, dDurationMs = 1000) => ({tStartMs, dDurationMs, segs: [{utf8: text}]});
const source = (events: unknown[]) => JSON.stringify({events});
const legacy = (text: string) => finalizeVideoSubtitleCues(parseYoutubeTimedTextResponse(text));

describe('bounded raw JSON3 provenance', () => {
    it('preserves subwords, entities and UTF-16 source ranges without claiming normalized offsets', () => {
        const raw = source([{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: 'Hel'}, {utf8: 'lo  '}, {utf8: '🌍'}, {utf8: '&am'}, {utf8: 'p;'}]}]);
        const document = parseYoutubeTimedTextDocument(raw), evidence = document.provenance!;
        expect(document.cues).toEqual(legacy(raw)); expect(cuesToSrt(document.cues)).toBe(cuesToSrt(legacy(raw)));
        expect(evidence.events[0].segments.map(item => [item.rawStart, item.rawEnd])).toEqual([[0, 3], [3, 7], [7, 9], [9, 12], [12, 14]]);
        expect(evidence.events[0].segments.map(item => item.text).join('')).toBe('Hello  🌍&amp;');
        expect(document.cues[0].text).toBe('Hello 🌍&');
        expect(evidence).toMatchObject({version: 1, offsetScope: 'raw-event-utf16-only', timingEvidence: 'unverified-source-metadata'});
        expect(Object.isFrozen(evidence.events[0].segments[0])).toBe(true);
        expect(Object.isFrozen(evidence.cues[0].snapshot)).toBe(true);
        expect(Object.keys(document.cues[0]).sort()).toEqual(['durationMs', 'startMs', 'text']);
    });
    it('retains bounded declared scalars only; synthetic offsets are not timing validation', () => {
        const raw = '{"events":[null,{},true,{"tStartMs":"0","dDurationMs":1000,"unknown":"private","segs":[null,{}, {"utf8":2}, {"utf8":"a", "tOffsetMs":0}, {"utf8":"b","tOffsetMs":"3"},{"utf8":"c","tOffsetMs":null},{"utf8":"d","tOffsetMs":false},{"utf8":"e","tOffsetMs":1e309},{"utf8":"f","tOffsetMs":{}},{"utf8":"g","tOffsetMs":"' + 'x'.repeat(129) + '"}]}]}';
        const document = parseYoutubeTimedTextDocument(raw), evidence = document.provenance!;
        expect(document.cues).toEqual(legacy(raw));
        expect(evidence.events[3].sourceFields).toEqual({tStartMs: '0', dDurationMs: 1000});
        expect(evidence.events[3].segments.map(item => item.sourceFields)).toEqual([{}, {}, {}, {tOffsetMs: 0}, {tOffsetMs: '3'}, {tOffsetMs: null}, {tOffsetMs: false}, {}, {}, {}]);
        expect(evidence.cues[0].contributors).toEqual([3]);
        expect(evidence.events[0].segments).toEqual([]);
    });
    it('keeps source event indices through sorting and marks inferred duration separately', () => {
        const raw = source([event('Later sentence.', 5000), {tStartMs: 0, segs: [{utf8: 'First sentence.'}]}]);
        const document = parseYoutubeTimedTextDocument(raw), evidence = document.provenance!;
        expect(document.cues).toEqual(legacy(raw)); expect(evidence.cues[0].contributors).toEqual([1]);
        expect(evidence.cues[0].transformations).toContain('duration-inferred');
        expect(evidence.events[1].sourceFields).toEqual({tStartMs: 0});
        expect(evidence.cues[1].transformations).not.toContain('duration-inferred');
    });
    it('keeps the text winner and superseded events without attributing a sibling duration to the winner', () => {
        const raw = source([event('Hello', 0, 4000), event('Hello world.', 0, 1000), event('Hello', 0, 500)]);
        const document = parseYoutubeTimedTextDocument(raw), evidence = document.provenance!;
        expect(document.cues).toEqual([{text: 'Hello world.', startMs: 0, durationMs: 4000}]);
        expect(evidence.cues[0]).toMatchObject({contributors: [0, 1, 2], textEvents: [1], supersededEvents: [0, 2], transformations: ['prefix-collapse']});
        expect(evidence.events[1].sourceFields.dDurationMs).toBe(1000);
    });
    it('preserves every word-stream contributor and remains compatible with repeated finalization', () => {
        const raw = source(['one', 'two', 'three', 'four.'].map((word, index) => event(word, index * 200, 200)));
        const document = parseYoutubeTimedTextDocument(raw), evidence = document.provenance!;
        expect(document.cues).toEqual(legacy(raw)); expect(document.cues).toHaveLength(1);
        expect(evidence.cues[0].contributors).toEqual([0, 1, 2, 3]);
        expect(evidence.cues[0].textEvents).toEqual([0, 1, 2, 3]);
        expect(evidence.cues[0].transformations).toEqual(['word-merge']);
        expect(provenanceMatchesCues(evidence, finalizeVideoSubtitleCues(document.cues))).toBe(true);
        expect(parseYoutubeTimedTextDocument(raw).provenance).toEqual(evidence);
    });
    it.each(['', 'not json', '<text start="0" dur="1">XML</text>', '{"events":[],"other":"<text start=\'0\' dur=\'1\'>XML</text>"}'])('does not fabricate JSON3 lineage for fallback input %s', raw => {
        const document = parseYoutubeTimedTextDocument(raw);
        expect(document.cues).toEqual(legacy(raw)); expect(document.provenance).toBeUndefined();
    });
    it.each(['characters', 'events', 'segments'])('drops only provenance at the %s budget, keeping legacy cues', budget => {
        let raw = source([event('kept.')]);
        if (budget === 'characters') raw = ' '.repeat(250_000) + raw;
        if (budget === 'events') raw = source([event('kept.'), ...Array.from({length: 2048}, () => ({}))]);
        if (budget === 'segments') raw = source([{...event('kept.'), segs: [{utf8: 'kept.'}, ...Array.from({length: 8192}, () => ({utf8: ''}))]}]);
        const document = parseYoutubeTimedTextDocument(raw);
        expect(document.cues).toEqual(legacy(raw)); expect(document.provenance).toBeUndefined();
    });
    it.each(['characters', 'events', 'segments'])('accepts the exact %s capture bound', budget => {
        let raw = source([event('kept.')]);
        if (budget === 'characters') raw = ' '.repeat(250_000 - raw.length) + raw;
        if (budget === 'events') raw = source([event('kept.'), ...Array.from({length: 2047}, () => ({}))]);
        if (budget === 'segments') raw = source([{...event('kept.'), segs: [{utf8: 'kept.'}, ...Array.from({length: 8191}, () => ({utf8: ''}))]}]);
        const document = parseYoutubeTimedTextDocument(raw);
        expect(document.provenance).toBeDefined(); expect(document.cues).toEqual(legacy(raw));
    });
    it('matches the legacy parser across deterministic mixed incremental inputs', () => {
        const words = ['one', 'one two', 'three.', '中', '&amp;', "l'", 'ami', '🌍'];
        for (let seed = 0; seed < 80; seed++) {
            const events = Array.from({length: 8}, (_, index) => ({tStartMs: (index * (seed % 3)) * 100,
                ...(index % 4 ? {dDurationMs: (seed + index) % 3 * 100} : {}),
                segs: [{utf8: words[(seed + index) % words.length], tOffsetMs: index}]}));
            const raw = source(events), document = parseYoutubeTimedTextDocument(raw);
            expect(document.cues).toEqual(legacy(raw)); expect(provenanceMatchesCues(document.provenance!, document.cues)).toBe(true);
            expect(document.provenance!.cues.every(item => item.contributors.length > 0 && new Set(item.contributors).size === item.contributors.length)).toBe(true);
        }
    });
    it.each(['latest', 'first'])('handles the maximum prefix chain with the %s event winning', winner => {
        const events = Array.from({length: 2048}, (_, index) => event(winner === 'first' && index === 0 ? 'hello world.' : 'hello'));
        const document = parseYoutubeTimedTextDocument(source(events)), lineage = document.provenance!.cues[0];
        expect(document.cues).toEqual(legacy(source(events)));
        expect(lineage.contributors).toEqual(Array.from({length: 2048}, (_, index) => index));
        expect(lineage.textEvents).toEqual([winner === 'first' ? 0 : 2047]);
        expect(lineage.supersededEvents).toHaveLength(2047);
        expect(lineage.transformations).toEqual(['prefix-collapse']);
        expect(Object.isFrozen(lineage.contributors)).toBe(true);
    });
    it('preserves historical superseded order when a previously winning subtree loses later', () => {
        const document = parseYoutubeTimedTextDocument(source([event('hello world.'), event('hello'), event('hello world.'), event('hello')]));
        expect(document.provenance!.cues[0]).toMatchObject({contributors: [0, 1, 2, 3], textEvents: [2], supersededEvents: [1, 0, 3]});
    });
    it.each(['reported', 'inferred'])('coalesces repeated unary word merges with %s duration without losing operations', mode => {
        const raw = source([event('a', 0, mode === 'reported' ? 1000 : 0), event('b', 100, 10000), event('c', 200, 1000),
            event('d', 20000, 200), event('e', 20200, 200), event('f.', 20400, 200)]);
        const document = parseYoutubeTimedTextDocument(raw);
        expect(document.cues).toEqual(legacy(raw));
        const first = document.provenance!.cues.find(item => item.snapshot.text === 'a')!;
        expect(first.contributors).toEqual([0]); expect(first.transformations).toEqual(mode === 'reported' ? ['word-merge'] : ['duration-inferred', 'word-merge']);
    });
    it('rejects every changed cue dimension and does not copy offsets into translations', () => {
        const document = parseYoutubeTimedTextDocument(source([event('original.')])), evidence = document.provenance!;
        expect(provenanceMatchesCues(evidence, [])).toBe(false);
        for (const change of [{text: 'translated'}, {startMs: 1}, {durationMs: 2}]) {
            const translated = [{...document.cues[0], ...change}];
            expect(provenanceMatchesCues(evidence, translated)).toBe(false);
            expect(Object.keys(translated[0]).sort()).toEqual(['durationMs', 'startMs', 'text']);
        }
        expect(provenanceMatchesCues(evidence, document.cues)).toBe(true);
    });
    it('atomically replaces same-cue revisions and drops stale sidecars on every cache read path', () => {
        const raw = (offset: number) => source([{...event('same.'), segs: [{utf8: 'same.', tOffsetMs: offset}]}]);
        const first = parseYoutubeTimedTextDocument(raw(0)), next = parseYoutubeTimedTextDocument(raw(1));
        expect(first.cues).toEqual(next.cues); expect(first.provenance!.sourceRevision).not.toBe(next.provenance!.sourceRevision);
        const cache = new TimedTextTrackCache(() => ''); cache.set('track', {url: 'u', ...first}); cache.set('track', {url: 'u', ...next});
        expect(cache.get('track')!.provenance).toBe(next.provenance);
        next.cues[0].text = 'translated';
        expect(cache.get('track')!.provenance).toBeUndefined();
        expect([...cache.values()][0].provenance).toBeUndefined(); expect([...cache.entries()][0][1].provenance).toBeUndefined();
        cache.set('other', {url: 'v', ...next}); expect(cache.get('other')!.provenance).toBeUndefined();
        cache.set('track', {url: 'u', cues: first.cues}); expect(cache.get('track')!.provenance).toBeUndefined();
    });
    it.each(['chars', 'cues'])('counts empty segments and source records in the %s cache budget', budget => {
        const document = parseYoutubeTimedTextDocument(source([{...event('a.'), segs: [{utf8: 'a.'}, ...Array.from({length: 40}, () => ({utf8: ''}))]}]));
        const weight = provenanceWeight(document.provenance!); expect(weight.records).toBe(42); expect(weight.chars).toBeGreaterThan(1000);
        const limits = {tracks: 8, chars: budget === 'chars' ? 500 : 1e6, cues: budget === 'cues' ? 20 : 1e6};
        const cache = new TimedTextTrackCache(() => '', limits);
        cache.set('old', {url: 'u', ...document}); cache.set('new', {url: 'v', cues: [{text: 'new.', startMs: 0, durationMs: 1}]});
        expect(cache.get('old')).toBeUndefined(); expect(cache.get('new')).toBeDefined();
    });
});
