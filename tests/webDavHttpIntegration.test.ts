import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {describe,expect,it} from 'vitest';
import {createWebDavApi} from '@/src/platform/webdav/api';
import {createWebDavSession,parseWebDavConnection} from '@/src/platform/webdav/connection';
import {encryptDriveConfig} from '@/src/platform/google-drive/encryption';

describe('WebDAV 真实 HTTP 协议夹具',()=>{
    it('使用真实 fetch 校验鉴权、目录、条件创建和覆盖，并拒绝跳转到其他地址',async()=>{
        let content:string|null=null;let version=0;let folder=false;
        const calls:Array<{method:string;url:string;match?:string;none?:string}>=[];
        const expected='Basic '+Buffer.from('fixture-user:fixture-http-password').toString('base64');
        const server=createServer(async(req,res)=>{
            calls.push({method:req.method!,url:req.url!,match:req.headers['if-match'] as string|undefined,none:req.headers['if-none-match'] as string|undefined});
            if(req.headers.authorization!==expected){res.writeHead(401).end('fixture-private-error');return;}
            if(req.url==='/redirect/'){res.writeHead(302,{Location:'/private-other/'}).end();return;}
            if(req.method==='PROPFIND'&&req.url==='/dav/'){res.writeHead(207,{'Content-Type':'application/xml'}).end('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');return;}
            if(req.method==='MKCOL'&&req.url==='/dav/FluentRead/'){const status=folder?405:201;folder=true;res.writeHead(status).end();return;}
            if(req.url!=='/dav/FluentRead/fluentread-config.encrypted.json'){res.writeHead(404).end();return;}
            if(req.method==='GET'){if(!content){res.writeHead(404).end();return;}res.writeHead(200,{ETag:`"v${version}"`}).end(content);return;}
            if(req.method==='PUT'){
                if((req.headers['if-none-match']==='*'&&content)||(req.headers['if-match']&&req.headers['if-match']!==`"v${version}"`)){res.writeHead(412).end();return;}
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
            const encrypted=await encryptDriveConfig({config:{fixture:'not a production key'}},'FluentReadEncryption');
            const first=await api.write(session,encrypted,null);
            expect(calls.find(c=>c.method==='PUT')?.none).toBe('*');expect(content).toBe(encrypted);
            await expect(api.write(session,encrypted,null)).rejects.toMatchObject({code:'conflict'});
            const changed=await encryptDriveConfig({config:{fixture:'second'}},'FluentReadEncryption');
            const second=await api.write(session,changed,first);expect(second.etag).toBe('"v2"');
            await expect(api.write(session,encrypted,first)).rejects.toMatchObject({code:'conflict'});expect(content).toBe(changed);
            await expect(api.test({...connection,password:'wrong-fixture'})).rejects.toMatchObject({code:'auth'});
            await expect(api.test({...connection,url:origin+'/redirect/'})).rejects.toMatchObject({code:'network'});
            expect(calls.some(c=>c.url==='/private-other/')).toBe(false);
            expect(content).not.toContain('fixture-http-password');
        }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    });
});
