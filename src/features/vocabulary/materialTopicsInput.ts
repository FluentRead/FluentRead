/**
 * @file src/features/vocabulary/materialTopicsInput.ts
 * 文件职责：在材料整理界面中无损往返主题文本。
 * 主要内容：用双引号保护含中英文逗号、引号或首尾空格的主题，并解析用户输入。
 * 模块边界：不修改材料、不读写配置；持久化时仍由材料仓库执行主题规范化与数量限制。
 */
/** 对原有主题进行可编辑的逗号分隔编码。 */
export function formatMaterialTopics(topics:readonly string[]):string {
    return topics.map(topic => !topic || /[,，"]/u.test(topic) || topic.trim()!==topic ? `"${topic.replace(/"/gu,'""')}"` : topic).join(', ');
}
/** 双引号内的逗号保留原意，两个连续引号表示一个引号。 */
export function parseMaterialTopics(value:string):string[] {
    const result:string[]=[];
    let index=0;
    while(index<value.length) {
        while(index<value.length && /\s/u.test(value[index]))index++;
        if(index>=value.length)break;
        let token='', quoted=false;
        if(value[index]==='"') {
            quoted=true;index++;
            let closed=false;
            while(index<value.length) {
                const char=value[index++];
                if(char!=='"'){token+=char;continue;}
                if(value[index]==='"'){token+='"';index++;continue;}
                closed=true;break;
            }
            if(!closed)throw Error('主题中的引号未闭合。');
            while(index<value.length&&/\s/u.test(value[index]))index++;
            if(index<value.length&&value[index]!==','&&value[index]!=='，')throw Error('主题之间请使用逗号分隔。');
        } else {
            while(index<value.length&&value[index]!==','&&value[index]!=='，')token+=value[index++];
            token=token.trim();
        }
        if(token||quoted)result.push(token);
        if(index<value.length)index++;
    }
    return result;
}
