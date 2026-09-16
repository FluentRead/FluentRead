import {describe, expect, it, vi} from 'vitest';

interface Contributor {login: string; id: number; type?: string}
interface ReadmeContributorsScript {
    fetchContributors(repo: string, options?: {token?: string; fetchImpl?: unknown}): Promise<Contributor[]>;
    buildContributorAvatars(contributors: Contributor[], repo?: string): string;
    replaceContributorsSection(content: string, avatars: string, name: string): string;
}

// 仓库脚本是无类型声明的 ESM；按显式契约动态加载，避免测试隐式获得 any。
const modulePath = new URL('../scripts/update-readme-contributors.mjs', import.meta.url).href;
const {buildContributorAvatars, fetchContributors, replaceContributorsSection} =
    await import(modulePath) as ReadmeContributorsScript;

function page(users: Array<Record<string, unknown>>, ok = true, status = 200, text = '') {
    return {ok, status, json: async () => users, text: async () => text};
}

function users(count: number, offset = 0) {
    return Array.from({length: count}, (_, index) => ({login: `user${offset + index}`, id: offset + index, type: 'User'}));
}

describe('README 贡献者刷新工具', () => {
    it('分页读取直到不满一页，并只保留真实用户', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(page([...users(99), {login: 'bot', id: 900, type: 'Bot'}]))
            .mockResolvedValueOnce(page(users(2, 100)));

        const contributors = await fetchContributors('owner/repo', {token: 'test-token-placeholder', fetchImpl});

        expect(contributors).toHaveLength(101);
        expect(contributors.some(user => user.type === 'Bot')).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/contributors?per_page=100&page=1');
        expect(fetchImpl.mock.calls[1][0]).toBe('https://api.github.com/repos/owner/repo/contributors?per_page=100&page=2');
        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer test-token-placeholder',
        });
    });

    it('未配置令牌时不发送 Authorization，接口失败时带状态与响应体抛错', async () => {
        const anonymous = vi.fn().mockResolvedValue(page([]));
        await fetchContributors('owner/repo', {fetchImpl: anonymous});
        expect(anonymous.mock.calls[0][1].headers).not.toHaveProperty('Authorization');

        const failing = vi.fn().mockResolvedValue(page([], false, 403, 'rate limited'));
        await expect(fetchContributors('owner/repo', {fetchImpl: failing})).rejects.toThrow('GitHub API 403: rate limited');
    });

    it('头像块按 id 取头像、按 login 写替代文本，并整体链接到贡献者页面', () => {
        const avatars = buildContributorAvatars([{login: 'alice', id: 1}, {login: 'bob', id: 22}], 'owner/repo');

        expect(avatars.split('\n')[0]).toBe('<a href="https://github.com/owner/repo/graphs/contributors">');
        expect(avatars).toContain('<img src="https://avatars.githubusercontent.com/u/1?s=96&v=4" width="48" height="48" alt="alice">');
        expect(avatars).toContain('<img src="https://avatars.githubusercontent.com/u/22?s=96&v=4" width="48" height="48" alt="bob">');
        expect(avatars.endsWith('</a>')).toBe(true);
        expect(buildContributorAvatars([], 'owner/repo')).toContain('        <br>');
    });

    it('只替换标记之间的内容，缺少或顺序颠倒的标记不产生半截文档', () => {
        const content = [
            '# FluentRead',
            '<!-- contributors:start -->',
            '<a href="old">old block</a>',
            '<!-- contributors:end -->',
            '## License',
        ].join('\n');

        const updated = replaceContributorsSection(content, '<a href="new">new block</a>', 'README.md');

        expect(updated).toBe([
            '# FluentRead',
            '<!-- contributors:start -->',
            '<a href="new">new block</a>',
            '<!-- contributors:end -->',
            '## License',
        ].join('\n'));
        expect(() => replaceContributorsSection('# FluentRead', 'block', 'README.md'))
            .toThrow('Missing contributor markers in README.md');
        expect(() => replaceContributorsSection(
            '<!-- contributors:end -->\n<!-- contributors:start -->', 'block', 'misc/README_ZH.md',
        )).toThrow('Missing contributor markers in misc/README_ZH.md');
    });
});
