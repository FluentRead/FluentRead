import fs from 'node:fs';
import {resolve} from 'node:path';
import {defineConfig, type Plugin} from 'vite';
import {francRuntimeBuildPlugin} from '../scripts/testing/franc-runtime-build';

const root = resolve(__dirname, '..');

function includeVendorLicenses(): Plugin {
    return {
        name: 'include-userscript-vendor-licenses',
        generateBundle(_options, bundle) {
            const chunk = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry);
            if (!chunk || chunk.type !== 'chunk') throw new Error('Userscript vendor bundle is missing');
            const packageRoots = new Set<string>();
            for (const id of chunk.moduleIds) {
                if (id.startsWith('\0')) continue;
                const match = /^(.*\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?)(@[^/]+\/[^/]+|[^/]+)/u.exec(id);
                if (match) packageRoots.add(`${match[1]}${match[2]}`);
            }
            const notices = [...packageRoots].sort().map((packageRoot) => {
                const manifest = JSON.parse(fs.readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
                    name: string;
                    version: string;
                    license?: string;
                    repository?: string | {url?: string};
                };
                if (!manifest.license) throw new Error(`Missing userscript vendor license: ${manifest.name}`);
                const licenseFile = fs.readdirSync(packageRoot).find((name) => /^LICEN[CS]E(?:[.-].*)?$/iu.test(name));
                const repository = typeof manifest.repository === 'string'
                    ? manifest.repository : manifest.repository?.url;
                const licensePath = manifest.name === 'franc-min'
                    ? resolve(root, 'public/third-party-notices/franc-min-MIT.txt')
                    : licenseFile ? resolve(packageRoot, licenseFile) : undefined;
                const licenseText = licensePath
                    ? fs.readFileSync(licensePath, 'utf8').trim().replace(/[ \t]+$/gmu, '')
                    : `License source: ${repository || `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`}`;
                if (licenseText.includes('*/')) throw new Error(`Unsafe userscript vendor license comment: ${manifest.name}`);
                return `/*\n${manifest.name} ${manifest.version} — ${manifest.license}\n${licenseText}\n*/`;
            });
            if (notices.length === 0) throw new Error('Userscript vendor bundle contains no third-party licenses');
            chunk.code = `${notices.join('\n')}\n${chunk.code}`;
        },
    };
}

export default defineConfig({
    root,
    publicDir: false,
    plugins: [francRuntimeBuildPlugin(), includeVendorLicenses()],
    build: {
        outDir: resolve(root, '.output/userscript-vendor'),
        emptyOutDir: true,
        target: 'es2018',
        minify: 'esbuild',
        sourcemap: false,
        lib: {
            entry: resolve(root, 'userscript/vendorEntry.ts'),
            name: 'FluentReadUserscriptVendor',
            formats: ['iife'],
            fileName: () => 'fluentread-vendor.v1.js',
        },
        rollupOptions: {output: {inlineDynamicImports: true}},
    },
});
