/**
 * @file src/features/image-translation/services/imageDetectionSnapshot.ts
 * 文件职责：限制私有检测证据的译图救援为可确认单帧的已解码栅格数据，避免同URI动画换帧后借用旧概率。
 * 主要内容：仅接纳具有相符签名的JPEG/BMP，或有界解析完整PNG块后未发现动画控制的PNG；base64仅按块头随机读小片，不额外解压或复制整幅RGBA。未知格式、SVG、动画及无完整结构证明均沿用原图回退。
 * 模块边界：调用方已成功解码图片，本模块只检查单帧资格，不替代图片解码、CRC校验、尺寸限制或检测来源绑定，不处理网络URL。
 */
export function isSingleFrameImageData(image:string):boolean {
    const match=/^data:image\/(png|jpe?g|bmp);base64,/iu.exec(image);
    if(!match)return false;
    const encoded=image.slice(match[0].length);
    if(!encoded.length||encoded.length%4!==0||encoded.includes('#'))return false;
    const length=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
    const read=(offset:number,count:number):Uint8Array|undefined=>{
        if(offset<0||offset+count>length)return;
        const first=Math.floor(offset/3),last=Math.ceil((offset+count)/3);
        const bytes=atob(encoded.slice(first*4,last*4)),start=offset-first*3;
        return Uint8Array.from({length:count},(_,index)=>bytes.charCodeAt(start+index));
    };
    try {
        const kind=match[1].toLowerCase();
        if(kind!=='png'){
            const head=read(0,3);if(!head)return false;
            return kind==='bmp'?head[0]===66&&head[1]===77:head[0]===255&&head[1]===216&&head[2]===255;
        }
        const signature=read(0,8);
        if(!signature||![137,80,78,71,13,10,26,10].every((byte,index)=>byte===signature[index]))return false;
        let offset=8,first=true,hasData=false;
        for(let count=0;count<1024;count++){
            const header=read(offset,8);if(!header)return false;
            const size=header[0]*16_777_216+header[1]*65_536+header[2]*256+header[3];
            if(size>0x7fffffff||offset+size+12>length)return false;
            const type=String.fromCharCode(header[4],header[5],header[6],header[7]);
            if(first){if(type!=='IHDR'||size!==13)return false;first=false;}
            else if(type==='IHDR')return false;
            if(type==='acTL'||type==='fcTL'||type==='fdAT')return false;
            if(type==='IDAT')hasData=true;
            offset+=size+12;
            if(type==='IEND')return hasData&&size===0&&offset===length;
        }
        return false;
    }catch{return false;}
}
