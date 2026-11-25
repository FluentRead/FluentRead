/** Freeze the exact files used by local translation, including content digests. */
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';

const repositories = [
    'Xenova/opus-mt-en-zh', 'Xenova/opus-mt-zh-en',
    'Xenova/opus-mt-ja-en', 'Xenova/opus-mt-en-jap',
    'tencent/Hy-MT3-1.8B-GGUF',
    'tencent/Hy-MT2-1.8B-GGUF',
];
const names = new Set([
    'config.json', 'generation_config.json', 'tokenizer.json',
    'tokenizer_config.json', 'special_tokens_map.json',
    'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
    'Hy-MT3-1.8B-Q4_K_M.gguf',
    'Hy-MT2-1.8B-Q4_K_M.gguf',
]);
async function request(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const response = await fetch(url, {signal: AbortSignal.timeout(45_000)});
            if (!response.ok) throw new Error(`${response.status}: ${url}`);
            return response;
        } catch (error) { last = error; }
    }
    throw last;
}
const manifest = {};
for (const repo of repositories) {
    const {sha: revision} = await (await request(`https://huggingface.co/api/models/${repo}`)).json();
    if (!revision) throw new Error(`Missing revision for ${repo}`);
    const tree = await (await request(`https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=true`)).json();
    const files = [];
    for (const file of tree.filter((file) => names.has(file.path))) {
        const sha256 = file.lfs?.oid || createHash('sha256').update(new Uint8Array(
            await (await request(`https://huggingface.co/${repo}/resolve/${revision}/${file.path}`)).arrayBuffer(),
        )).digest('hex');
        files.push({path: file.path, size: file.size, sha256});
    }
    if (files.length !== (repo.startsWith('tencent/') ? 1 : 7)) throw new Error(`Incomplete repository: ${repo}`);
    manifest[repo] = {revision, files};
    console.log(repo, revision, files.reduce((sum, file) => sum + file.size, 0));
}
await writeFile(new URL('../../src/core/config/localTranslationArtifacts.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
