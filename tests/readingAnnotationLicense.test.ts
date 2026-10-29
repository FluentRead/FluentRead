import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {describe,expect,it} from 'vitest';

describe('reading annotation license provenance',()=>{
    it('preserves the fixed upstream license and its readable normalized grant',()=>{
        const directory='public/third-party-notices/';
        const provenance=JSON.parse(readFileSync(`${directory}reading-annotation-PROVENANCE.json`,'utf8')).koroman;
        const original=gunzipSync(readFileSync(`${directory}${provenance.upstreamLicenseArchive}`));
        const sha256=createHash('sha256').update(original).digest('hex');
        const blob=createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex');
        expect(sha256).toBe('8e140c804d0226d197db528f1653ede195ab254935b4fa18bc81f1ea455614ca');
        expect(sha256).toBe(provenance.upstreamLicenseSha256);
        expect(blob).toBe(provenance.upstreamLicenseBlob);
        const normalized=original.toString('utf8').replace(/^<<<<<<< HEAD\nMIT License\n=======\n/,'').replace(/^>>>>>>> [^\n]+\n/m,'');
        expect(readFileSync(`${directory}reading-koroman-MIT.txt`,'utf8')).toBe(normalized);
        expect(readFileSync(`${directory}reading-annotation-NOTICE.md`,'utf8')).toContain(provenance.upstreamLicenseArchive);
    });
});
