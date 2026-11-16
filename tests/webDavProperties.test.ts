import {describe, expect, it} from 'vitest';
import {parseWebDavProperties} from '@/src/platform/webdav/properties';
import {canMutateCloudFile, strongCloudEtag} from '@/src/core/config/cloudSync';

const url='https://dav.fixture.invalid/base/';
const response=(prop='<d:resourcetype><d:collection/></d:resourcetype>',status='HTTP/1.1 200 OK')=>`<d:response><d:href>/base/</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
const wrap=(body:string)=>`<?xml version="1.0"?><d:multistatus xmlns:d = "DAV:">${body}</d:multistatus>`;
describe('WebDAV Depth:0 XML 属性识别',()=>{
    it('同源目录接受尾斜杠与 UTF-8 编码差异，文件仍须精确匹配路径', () => {
        for (const href of ['/base', 'https://DAV.fixture.invalid:443/base', '/b%61se/']) expect(parseWebDavProperties(wrap(response().replace('/base/', href)), url)).toEqual({collection: true});
        const unicode = 'https://dav.fixture.invalid:5006/共享/我的 备份/';
        for (const href of ['/共享/我的 备份', '/%e5%85%b1%e4%ba%ab/%e6%88%91%e7%9a%84%20%e5%a4%87%e4%bb%bd/', 'https://dav.fixture.invalid:5006/共享/我的%20备份/']) expect(parseWebDavProperties(wrap(response().replace('/base/', href)), unicode)).toEqual({collection: true});
        expect(parseWebDavProperties(wrap(response('<d:getetag>"one"</d:getetag>').replace('/base/', '/base')), url)).toBeUndefined();
        expect(parseWebDavProperties(wrap(response()), url.slice(0, -1))).toBeUndefined();
        expect(parseWebDavProperties(wrap(response('<d:getetag>"one"</d:getetag>').replace('/base/', '/b%61se/')), url)).toEqual({collection: false, etag: '"one"'});
    });
    it('不接受异源、其他端口、凭据、查询、相对路径、损坏编码或编码路径分隔符', () => {
        for (const href of ['https://other.invalid/base/', 'http://dav.fixture.invalid/base/', 'https://dav.fixture.invalid:5006/base/', 'https://user:secret@dav.fixture.invalid/base/', '/base/?x=1', '/base/#fragment', '//dav.fixture.invalid/base/', 'base/', '/base\\', '/base%2f', '/base/%ZZ', 'http://[', '/base//']) expect(parseWebDavProperties(wrap(response().replace('/base/', href)), url)).toBeUndefined();
        expect(parseWebDavProperties(wrap(response()), 'https://dav.fixture.invalid/base%2f')).toBeUndefined();
    });
    it.each(['', 'not a URL', '/base/', 'http://['])('无效目标 %j 返回未识别结果，不向调用链抛出 URL 异常', target => {
        expect(parseWebDavProperties(wrap(response()), target)).toBeUndefined();
    });
    it('默认、局部及重新绑定的命名空间按元素作用域解释，支持字符引用与 CDATA',()=>{
        const base=wrap(response('<d:getetag>&#34;one&#x22;</d:getetag>'));
        expect(parseWebDavProperties(base,url)).toEqual({collection:false,etag:'"one"'});
        expect(parseWebDavProperties(base.replace('HTTP/1.1 200 OK','<![CDATA[HTTP/1.1 200 OK]]>'),url)?.etag).toBe('"one"');
        expect(parseWebDavProperties(wrap(response()).replaceAll('d:','').replace('xmlns:d','xmlns'),url)?.collection).toBe(true);
        expect(parseWebDavProperties(wrap(response()).replace('<d:response>','<d:response xmlns:x="urn:extra"><x:extra xmlns:d="urn:other"><d:collection/></x:extra>'),url)?.collection).toBe(true);
        expect(parseWebDavProperties(wrap(response()).replace('<d:collection/>','<d:collection xmlns:d="urn:other"/>'),url)?.collection).toBe(false);
        expect(parseWebDavProperties('  '+wrap(response().replace('/base/',url)).replace('<?xml version="1.0"?>','')+'\n',url)?.collection).toBe(true);
    });
    it('只接受正确目标和单一成功属性；错误目录、重复资源、嵌套或歧义值不能授权覆盖',()=>{
        for (const body of ['',response()+response(),response().replace('/base/','/other/'),response().replace('<d:href>/base/</d:href>',''),response().replace('<d:href>/base/</d:href>','<d:href><d:x/></d:href>'),response().replace('</d:href>','</d:href><d:href>/base/</d:href>')]) expect(parseWebDavProperties(wrap(body),url)).toBeUndefined();
        for (const body of [response('', 'HTTP/1.1 404 Not Found'),response('').replace('<d:status>HTTP/1.1 200 OK</d:status>',''),response().replace('</d:prop>','</d:prop><d:prop/>')]) expect(parseWebDavProperties(wrap(body),url)).toEqual({collection:false});
        for (const prop of ['<d:getetag>W/"weak"</d:getetag>','<d:getetag>"a"</d:getetag><d:getetag>"b"</d:getetag>','<d:getetag><d:value>"a"</d:value></d:getetag>']) expect(parseWebDavProperties(wrap(response(prop)),url)?.etag).toBeUndefined();
        expect(parseWebDavProperties(wrap(response()+'<d:multistatus/>'),url)).toBeUndefined();
        expect(parseWebDavProperties(wrap(response('<d:resourcetype><d:collection/><d:collection/></d:resourcetype>')),url)?.collection).toBe(false);
    });
    it('拒绝损坏 XML、实体声明、异常根节点及过深过大的属性文档',()=>{
        for (const body of ['', '<x/>','<multistatus xmlns="urn:other"/>',wrap(response()).replace('</d:response>',''),'<d:multistatus/>','<!DOCTYPE d:multistatus [<!ENTITY x "private">]>'+wrap(response()),wrap(response()).replace('xmlns:d = "DAV:"','xmlns:d="DAV:" xmlns:d="urn:other"'),wrap(response()).replace('/base/','&unknown;'),wrap(response()).replace('/base/','&#x0;')]) expect(parseWebDavProperties(body,url)).toBeUndefined();
        expect(parseWebDavProperties('x'.repeat(128*1024+1),url)).toBeUndefined();
        expect(parseWebDavProperties(wrap('<d:x>'.repeat(64)+'</d:x>'.repeat(64)),url)).toBeUndefined();
        expect(parseWebDavProperties(wrap('<d:x/>'.repeat(4097)),url)).toBeUndefined();
    });
    it('强版本规则明确拒绝弱值、未加引号、换行和过长值',()=>{
        for (const value of [null,undefined,'','W/"a"','a','"a\nb"','"'+'x'.repeat(513)+'"']) expect(strongCloudEtag(value)).toBeUndefined();
        expect(strongCloudEtag('"a"')).toBe('"a"');
    });
    it('内容核验须由供应商显式声明并携带真实摘要，不能绕过只读能力',()=>{
        const file={id:url,version:'a'.repeat(64),modifiedTime:''};
        expect(canMutateCloudFile({...file,etag:'"one"'})).toBe(true);
        expect(canMutateCloudFile({...file,contentGuard:true})).toBe(true);
        expect(canMutateCloudFile({...file,contentGuard:true,readOnly:true})).toBe(false);
        expect(canMutateCloudFile({...file,contentGuard:true,version:'untrusted'})).toBe(false);
        expect(canMutateCloudFile(file)).toBe(false);
    });
});
