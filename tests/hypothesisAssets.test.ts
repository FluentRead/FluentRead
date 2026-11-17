import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {hypothesisAssets} from '../scripts/testing/hypothesis-assets';
describe('Pinned official Hypothesis assets', () => {
    it('packages only the page guest, local styles and notices, with a closed-document guard', () => {
        const assets = hypothesisAssets(process.cwd()); expect(assets).toHaveLength(6);
        expect(assets.map(asset => asset.relativeDest)).not.toContain('hypothesis/build/scripts/sidebar.bundle.js');
        const annotator = assets.find(asset => asset.relativeDest.endsWith('annotator.bundle.js'))!;
        const official = readFileSync(resolve('node_modules/hypothesis/build/scripts/annotator.bundle.js'), 'utf8');
        expect(('contents' in annotator ? annotator.contents : '')).toContain(official); expect(('contents' in annotator ? annotator.contents : '')).toContain('[data-fluentread-hypothesis="on"]');
        const bootAsset = assets.find(asset => asset.relativeDest.endsWith('/boot.js'))!;
        const boot = 'contents' in bootAsset ? bootAsset.contents : '';
        expect(boot).not.toContain('__ASSET_ROOT__'); expect(boot).toContain('new URL("../",document.currentScript.src).href'); expect(boot).not.toContain('__SIDEBAR_APP_URL__'); expect(boot).toContain('https://hypothes.is/app.html');
        for (const asset of assets) if ('absoluteSrc' in asset) expect(readFileSync(asset.absoluteSrc).length).toBeGreaterThan(0);
        expect(assets.at(-1)!.relativeDest).toContain('BSD-2-Clause-and-Annotator-MIT');
    });
});
