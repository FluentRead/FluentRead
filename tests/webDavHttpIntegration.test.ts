import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {describe,expect,it} from 'vitest';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavSession,parseWebDavConnection} from '@/src/platform/webdav/connection';
import {encryptDriveConfig} from '@/src/platform/google-drive/encryption';

describe('WebDAV 真实 HTTP 协议夹具',()=>{
    it.each(['', '备份/My backups'])('受限 NAS 共享目录支持路径 %j，目录响应省略尾斜杠；保存、恢复和删除不访问根目录', async backupPath => {
        const base = '/%E5%85%B1%E4%BA%AB%20folder/';
        const folders = new Set([base]);
        const calls: Array<{method: string; url: string}> = [];
        let content: string | null = null;
        let version = 0;
        let filename = '';
        const server = createServer(async (req, res) => {
            const path = req.url!;
            calls.push({method: req.method!, url: path});
            if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture-user:fixture-http-password').toString('base64')) {res.writeHead(401).end(); return;}
            if (!path.startsWith(base)) {res.writeHead(403).end(); return;}
            if (req.method === 'PROPFIND') {
                if (!folders.has(path)) {res.writeHead(404).end(); return;}
                // 返回原始中文和不带尾斜杠的目录 href，模拟 NAS 的表示差异。
                res.writeHead(207, {'Content-Type': 'application/xml'}).end(`<multistatus xmlns="DAV:"><response><href>${decodeURIComponent(path).replace(/\/$/u, '')}</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`); return;
            }
            if (req.method === 'MKCOL') {
                if (path === base) {res.writeHead(403).end(); return;}
                const parent = path.replace(/[^/]+\/$/u, '');
                if (!folders.has(parent)) {res.writeHead(409).end(); return;}
                const status = folders.has(path) ? 405 : 201;
                folders.add(path); res.writeHead(status).end(); return;
            }
            if (path !== filename) {res.writeHead(404).end(); return;}
            if (req.method === 'GET') {res.writeHead(content === null ? folders.has(path.slice(0, path.lastIndexOf('/') + 1)) ? 404 : 409 : 200, {ETag: `"v${version}"`}).end(content); return;}
            if (req.method === 'PUT') {
                if (req.headers['if-none-match'] === '*' && content !== null || req.headers['if-match'] && req.headers['if-match'] !== `"v${version}"`) {res.writeHead(412).end(); return;}
                const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
                content = Buffer.concat(chunks).toString(); version++; res.writeHead(201).end(); return;
            }
            if (req.method === 'DELETE') {
                if (req.headers['if-match'] !== `"v${version}"`) {res.writeHead(412).end(); return;}
                content = null; res.writeHead(204).end(); return;
            }
            res.writeHead(405).end();
        });
        await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
        try {
            const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const connection = parseWebDavConnection({url: origin + '/共享 folder', backupPath, username: 'fixture-user', password: 'fixture-http-password', allowInsecure: true, revision: null}, null);
            const session = createWebDavSession(connection, async () => connection);
            filename = new URL('fluentread-config.encrypted.json', connection.url + connection.backupPath).pathname;
            const api = createWebDavApi(fetch);
            await api.test(connection);
            expect(await api.read(session)).toBeNull();
            expect(calls.every(call => ['GET', 'PROPFIND'].includes(call.method))).toBe(true);
            const encrypted = await encryptDriveConfig({config: {fixture: 'NAS backup'}}, 'FluentReadEncryption');
            const first = await api.write(session, encrypted, null);
            expect((await api.read(session))?.content).toBe(encrypted);
            const changed = await encryptDriveConfig({config: {fixture: 'updated NAS backup'}}, 'FluentReadEncryption');
            const second = await api.write(session, changed, first);
            await expect(api.write(session, encrypted, first)).rejects.toMatchObject({code: 'conflict'});
            expect((await api.read(session))?.content).toBe(changed);
            await api.remove(session, second);
            expect(await api.read(session)).toBeNull();
            expect(calls.every(call => call.url.startsWith(base))).toBe(true);
            expect(calls.some(call => call.method === 'MKCOL' && call.url === base)).toBe(false);
            expect(calls.filter(call => call.method === 'MKCOL')).toHaveLength(backupPath ? 2 : 0);
            expect(calls.filter(call => ['GET', 'PUT', 'DELETE'].includes(call.method)).every(call => call.url === filename)).toBe(true);
        } finally {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}
    });
    it.each(['get','prop','head','none','unquoted'] as const)('真实 HTTP 完成首次和再次保存、冲突拒绝（ETag 来源: %s）',async(etagSource)=>{
        let content:string|null=null;let version=0;let folder=false;
        const etag=()=>etagSource==='unquoted'?`fixture-v${version}`:`"v${version}"`;
        const calls:Array<{method:string;url:string;match?:string;none?:string}>=[];
        const expected='Basic '+Buffer.from('fixture-user:fixture-http-password').toString('base64');
        const server=createServer(async(req,res)=>{
            calls.push({method:req.method!,url:req.url!,match:req.headers['if-match'] as string|undefined,none:req.headers['if-none-match'] as string|undefined});
            if(req.headers.authorization!==expected){res.writeHead(401).end('fixture-private-error');return;}
            if(req.url==='/redirect/'){res.writeHead(302,{Location:'/private-other/'}).end();return;}
            if(req.method==='PROPFIND'&&(req.url==='/dav/'||req.url==='/dav/FluentRead/')){
                if(req.url==='/dav/FluentRead/'&&!folder){res.writeHead(404).end();return;}
                res.writeHead(207,{'Content-Type':'application/xml'}).end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);return;
            }
            if(req.method==='MKCOL'&&req.url==='/dav/FluentRead/'){const status=folder?405:201;folder=true;res.writeHead(status).end();return;}
            if(req.url!=='/dav/FluentRead/fluentread-config.encrypted.json'){res.writeHead(404).end();return;}
            if(req.method==='PROPFIND') {res.writeHead(207,{'Content-Type':'application/xml'}).end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop>${etagSource==='prop'?`<d:getetag>&quot;v${version}&quot;</d:getetag>`:''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);return;}
            if(req.method==='HEAD'){res.writeHead(200,etagSource==='head'?{ETag:`"v${version}"`}:{}).end();return;}
            if(req.method==='GET'){if(!content){res.writeHead(folder?404:409).end();return;}if(req.headers['if-match']&&req.headers['if-match']!==etag()){res.writeHead(412).end();return;}res.writeHead(200,etagSource==='get'||etagSource==='unquoted'?{ETag:etag()}:{}).end(content);return;}
            if(req.method==='DELETE'){
                if(!content){res.writeHead(404).end();return;}
                if((etagSource==='unquoted'||req.headers['if-match']!=='*')&&req.headers['if-match']!==etag()){res.writeHead(412).end();return;}
                content=null;res.writeHead(204).end();return;
            }
            if(req.method==='PUT'){
                if((req.headers['if-none-match']==='*'&&content)||(req.headers['if-match']==='*'&&(!content||etagSource==='unquoted'))||(req.headers['if-match']&&req.headers['if-match']!=='*'&&req.headers['if-match']!==etag())){res.writeHead(412).end();return;}
                const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));content=Buffer.concat(chunks).toString();version++;res.writeHead(201).end();return;
            }
            res.writeHead(405).end();
        });
        await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
        try{
            const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const connection=parseWebDavConnection({url:origin+'/dav/',username:'fixture-user',password:'fixture-http-password',allowInsecure:true,revision:null},null);
            const session=createWebDavSession(connection,async()=>connection);const api=createWebDavApi(fetch);
            await api.test(connection);expect(calls.map(c=>c.method)).toEqual(['PROPFIND']);
            expect(await api.read(session)).toBeNull();
            expect(calls.map(c=>[c.method,c.url])).toEqual([['PROPFIND','/dav/'],['GET','/dav/FluentRead/fluentread-config.encrypted.json'],['PROPFIND','/dav/'],['PROPFIND','/dav/FluentRead/']]);
            expect(folder).toBe(false);expect(content).toBeNull();
            const encrypted=await encryptDriveConfig({config:{fixture:'not a production key'}},'FluentReadEncryption');
            const first=await api.write(session,encrypted,null);
            expect(calls.find(c=>c.method==='PUT')?.none).toBe('*');expect(content).toBe(encrypted);
            await expect(api.write(session,encrypted,null)).rejects.toMatchObject({code:'conflict'});
            const changed=await encryptDriveConfig({config:{fixture:'second'}},'FluentReadEncryption');
            const second=await api.write(session,changed,first);
            expect(second.etag).toBe(etagSource==='none'||etagSource==='unquoted'?undefined:'"v2"');
            if(etagSource==='none'||etagSource==='unquoted') expect(second.contentGuard).toBe(true);
            if(etagSource==='unquoted') {
                expect(second.unquotedEtag).toBe('fixture-v2');
                expect(calls.filter(c=>c.method==='PUT').at(-1)?.match).toBe('fixture-v1');
                const thirdContent=await encryptDriveConfig({config:{fixture:'third'}},'FluentReadEncryption');
                const third=await api.write(session,thirdContent,second);
                expect(third.unquotedEtag).toBe('fixture-v3');expect(content).toBe(thirdContent);
                expect(calls.filter(c=>c.method==='PUT').at(-1)?.match).toBe('fixture-v2');
                // 再次修改并上传后继续使用最新版本验证删除。
                Object.assign(second,third);
            }
            const savedContent=content;
            await expect(api.write(session,encrypted,first)).rejects.toMatchObject({code:'conflict'});expect(content).toBe(savedContent);
            await expect(api.test({...connection,password:'wrong-fixture'})).rejects.toMatchObject({code:'auth'});
            await expect(api.test({...connection,url:origin+'/redirect/'})).rejects.toMatchObject({code:'network'});
            expect(calls.some(c=>c.url==='/private-other/')).toBe(false);
            expect(content).not.toContain('fixture-http-password');
            await expect(api.remove(session,first)).rejects.toMatchObject({code:'conflict'});expect(content).toBe(savedContent);
            await api.remove(session,second);expect(content).toBeNull();expect(folder).toBe(true);expect(await api.read(session)).toBeNull();
            await api.remove(session,second);
            expect(calls.filter(c=>c.method==='DELETE').every(c=>c.url==='/dav/FluentRead/fluentread-config.encrypted.json')).toBe(true);
            await api.write(session,encrypted,null);expect(content).toBe(encrypted);
        }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    });
});
