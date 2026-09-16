import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// 用 GitHub 头像刷新 README 中的贡献者列表；第三方头像服务在 GitHub 渲染时容易超时。
const root = fileURLToPath(new URL('../', import.meta.url));
export const REPO = 'FluentRead/FluentRead';
export const README_FILES = ['README.md', 'misc/README_ZH.md'];
const START = '<!-- contributors:start -->';
const END = '<!-- contributors:end -->';

/** 分页读取贡献者；只保留真实用户，机器人不进入头像墙。 */
export async function fetchContributors(repo = REPO, {token, fetchImpl = fetch} = {}) {
    const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'fluentread-readme-contributors'};
    if (token) headers.Authorization = `Bearer ${token}`;
    const contributors = [];
    for (let page = 1; ; page++) {
        const response = await fetchImpl(`https://api.github.com/repos/${repo}/contributors?per_page=100&page=${page}`, {headers});
        if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
        const batch = await response.json();
        contributors.push(...batch.filter(user => user.type === 'User'));
        if (batch.length < 100) break;
    }
    return contributors;
}

// 与陪读蛙相同：整块链接到贡献者页面，头像放在单格表格中。
export function buildContributorAvatars(contributors, repo = REPO) {
    const images = contributors.map(({login, id}) =>
        `<img src="https://avatars.githubusercontent.com/u/${id}?s=96&v=4" width="48" height="48" alt="${login}">`,
    ).join('');
    return [
        `<a href="https://github.com/${repo}/graphs/contributors">`,
        '  <table>',
        '    <tr>',
        '      <th>',
        '        <br>',
        `        ${images}<br>`,
        '        <br>',
        '      </th>',
        '    </tr>',
        '  </table>',
        '</a>',
    ].join('\n');
}

/** 只替换标记之间的内容；缺少标记时不写入，避免把文档改成半截结构。 */
export function replaceContributorsSection(content, avatars, name) {
    const from = content.indexOf(START);
    const to = content.indexOf(END);
    if (from < 0 || to < from) throw new Error(`Missing contributor markers in ${name}`);
    return `${content.slice(0, from + START.length)}\n${avatars}\n${content.slice(to)}`;
}

export async function updateReadmeContributors({repo = REPO, token = process.env.GITHUB_TOKEN, fetchImpl} = {}) {
    const contributors = await fetchContributors(repo, {token, fetchImpl});
    const avatars = buildContributorAvatars(contributors, repo);
    for (const name of README_FILES) {
        const file = resolve(root, name);
        const content = await readFile(file, 'utf8');
        await writeFile(file, replaceContributorsSection(content, avatars, name));
    }
    return contributors.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(`Updated ${await updateReadmeContributors()} contributors in ${README_FILES.join(', ')}`);
}
