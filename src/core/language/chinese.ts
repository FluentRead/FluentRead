/**
 * @file src/core/language/chinese.ts
 *
 * 文件职责：统一中文语言别名与书写体系，并以保守字形证据区分简体、繁体、简繁同形和未知的纯汉字文本。
 * 主要内容：中文语言码经 codes.ts 的通用标签解析确定简繁；用可审核的简繁冲突对与 Unicode 简繁专属字数据判断字形，要求中文词语或专用字证据，包含登入、頁面、儲存与瀏覽器等中文界面词语，排除简繁混排、罕见扩展字和粤语口语；导出中文专用字形证据，供日文、韩文判断排除中文文本。可核对的公开符号包括 normalizeChineseLanguageCode、getChineseScript、classifyChineseHan、hasSimplifiedChineseEvidence、hasTraditionalChineseEvidence。
 * 模块边界：本文件属于 core 纯算法，只分析汉字字形，不处理 Latin 标识符、外语正文或其他文字（由 identify.ts 统一完成），不转换原文、不猜测地区或方言，不访问配置、浏览器、网络或翻译服务。
 */

import {normalizeLanguageCode} from './codes';
import {simplifiedOnlyCharacters, traditionalOnlyCharacters, simplifiedChineseEvidenceCharacters} from './chineseVariants';

export type ChineseScript = 'Hans' | 'Hant';

/**
 * 把能确定书写体系的中文标签改写为 zh-Hans/zh-Hant，脚本子标签优先于地区，旧版裸 zh 沿用简体默认值；
 * 其他语言、冲突脚本或无法确定简繁的中文标签原样保留（仅去除首尾空白），供供应商映射表继续使用。
 */
export function normalizeChineseLanguageCode(value: string): string {
    const trimmed = value.trim();
    const normalized = normalizeLanguageCode(trimmed);
    return normalized === 'zh-Hans' || normalized === 'zh-Hant' ? normalized : trimmed;
}

export function getChineseScript(value: string): ChineseScript | undefined {
    const normalized = normalizeLanguageCode(value);
    if (normalized === 'zh-Hans') return 'Hans';
    if (normalized === 'zh-Hant') return 'Hant';
    return undefined;
}

// 用可逐对审核的常见字形构造冲突表，包含与日文共享的語、書、測等字。
// 不收录后/後、干/乾、台/臺、里/裡等简体一侧在繁体中仍有独立含义的对应，
// 也不把你、佛、玩等共享字视作简体证据；本表只用于检测，不承担简繁转换。
const scriptPairs = `
这這 们們 语語 译譯 设設 为為 说說 从從 对對 还還 样樣 书書 门門 车車 东東
发發 发髮 见見 长長 电電 现現 间間 题題 让讓 气氣 实實 图圖 网網 边邊 变變
进進 选選 级級 应應 标標 经經 简簡 汉漢 龙龍 马馬 鱼魚 鸟鳥 刘劉 吴吳 赵趙
陈陳 张張 听聽 读讀 写寫 学學 国國 体體 测測 试試 时時 钟鐘 话話 广廣 关關
欢歡 业業 专專 丛叢 丝絲 严嚴 个個 丰豐 临臨 丽麗 举舉 义義 乌烏 乐樂 乔喬
习習 乡鄉 买買 乱亂 争爭 亚亞 产產 亲親 亿億 仅僅 价價 众眾 优優 会會 伟偉
传傳 伤傷 伦倫 伪偽 党黨 兴興 养養 军軍 农農 决決 况況 冻凍 净淨 凉涼 减減
凤鳳 凭憑 击擊 创創 别別 则則 刚剛 删刪 剑劍 办辦 务務 动動 励勵 劳勞 势勢
区區 医醫 华華 单單 卫衛 厂廠 厅廳 历歷 压壓 厌厭 县縣 双雙 叠疊 叶葉 号號
启啟 员員 园園 围圍 圆圓 圣聖 场場 块塊 声聲 壳殼 处處 备備 复復 够夠 头頭
夺奪 奖獎 妇婦 妈媽 婴嬰 孙孫 宁寧 宝寶 宠寵 审審 宽寬 宾賓 寻尋 导導 将將
层層 岁歲 岛島 币幣 师師 帐帳 帘簾 带帶 帮幫 庆慶 库庫 庙廟 废廢 开開 异異
弃棄 弯彎 归歸 录錄 当當 忆憶 怀懷 态態 总總 恋戀 恶惡 惊驚 惧懼 惨慘 愿願
戏戲 户戶 执執 扫掃 扬揚 护護 报報 担擔 拟擬 拥擁 择擇 挡擋 挥揮 损損 换換
据據 摄攝 断斷 旧舊 显顯 晓曉 暂暫 术術 机機 杀殺 杂雜 权權 条條 构構 树樹
桥橋 检檢 楼樓 没沒 泪淚 泽澤 洁潔 浅淺 济濟 浓濃 润潤 湾灣 湿濕 满滿 灭滅
灯燈 灵靈 炉爐 点點 爱愛 独獨 狮獅 猪豬 献獻 画畫 盐鹽 监監 盖蓋 盘盤 离離
种種 积積 称稱 稳穩 穷窮 笔筆 签簽 类類 红紅 纸紙 练練 组組 细細 织織 终終
结結 给給 绝絕 统統 继繼 绩績 续續 绿綠 编編 缘緣 缩縮 联聯 胆膽 胜勝 脑腦
脚腳 脸臉 艺藝 节節 苍蒼 苏蘇 苹蘋 药藥 莲蓮 获獲 营營 蓝藍 补補 装裝 裤褲
观觀 规規 视視 览覽 觉覺 计計 认認 记記 讲講 许許 论論 访訪 证證 评評 识識
词詞 诚誠 详詳 该該 误誤 请請 诸諸 诺諾 谋謀 谓謂 谢謝 谨謹 谱譜 贝貝 财財
质質 贵貴 费費 资資 赛賽 赞贊 转轉 轮輪 轻輕 载載 较較 辅輔 辆輛 输輸 辞辭
辩辯 达達 迁遷 过過 运運 远遠 违違 连連 迟遲 适適 递遞 逻邏 遗遺 邻鄰 郑鄭
释釋 钱錢 铁鐵 银銀 链鏈 锁鎖 错錯 镜鏡 闪閃 闭閉 问問 闻聞 阅閱 队隊 阳陽
阴陰 阵陣 际際 陆陸 险險 随隨 隐隱 难難 雾霧 静靜 页頁 顺順 顾顧 预預 领領
频頻 额額 颜顏 风風 飞飛 饭飯 饮飲 馆館 骑騎 骗騙 鸡雞 鸣鳴 鸭鴨 麦麥 齐齊
齿齒 龟龜 与與 两兩 猫貓 数數
`.trim().split(/\s+/u);
const simplifiedScriptPattern = new RegExp(`[${scriptPairs.map((pair) => pair[0]).join('')}${simplifiedOnlyCharacters}]`, 'u');
// 「于」自身在繁体中也有合法用途，不能当作简体证据；「於」可单向证明繁体字形。
const traditionalAlternativeCharacters = '於';
const traditionalScriptPattern = new RegExp(`[${scriptPairs.map((pair) => pair[1]).join('')}${traditionalAlternativeCharacters}${traditionalOnlyCharacters}]`, 'u');

// 常用 CJK 统一汉字不再依赖几百字的白名单。罕见扩展、兼容字与迭代符号仍保持未知，
// 避免把「々」或未经检测的罕见字当成共享字；补充平面中有明确变体依据的字可以检查冲突。
const commonHanPattern = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;
const variantCharacters = new Set(`${simplifiedOnlyCharacters}${traditionalOnlyCharacters}`);
const hanPattern = /\p{Script=Han}/u;

// 中文专用简体字：人工短表与 Unicode 数据中“有中国来源、无日本来源”的简体字，日文和韩文正文不会使用。
const simplifiedChineseOnlyCharacters = `这们语译设为说从对还样书门车东发见长电现间题让气实图网边变进选级应标经简汉龙刘吴赵陈张听读广欢专严丽举买亲众伤伦${simplifiedChineseEvidenceCharacters}`;
const simplifiedChineseOnlyPattern = new RegExp(`[${simplifiedChineseOnlyCharacters}]`, 'u');
// 「起来」等词语只作为中文语境证据；「出来る」是常见日文，不能用于排除日文。
const simplifiedChineseEvidencePattern = new RegExp(`[${simplifiedChineseOnlyCharacters}]|[起出下]来`, 'u');
// 繁体中文常用字形，现代日文使用新字体（説、実、図、体），因此可排除日文；韩文汉字仍可能使用这些字形。
const traditionalChineseEvidencePattern = /[這們譯與說從對樣發氣點實圖邊變條應經體廣歡專嚴舉眾寫續]/u;
// 方言不是书写体系。含常见粤语口语标记时不能据繁体字形推断普通话。
const cantoneseMarkerPattern = /[嘅咗哋佢冇嚟喺啲嘢唔咁乜嗰咩噉]/u;
// 中文词语同样能确认语境，不能只在所有汉字均为中性字形时才使用：
// 如「清单允许清空，且不再连带拒掉无关偏好的保存」没有命中上方单字短表。
// 登录/登入、用户、邮箱、頁面、儲存及瀏覽器等中文词语也可确认短界面文本，
// 单独的「設定」「修復」与日文共享，不能提供这种证据；仍须检查字形冲突与混合正文。
// 「趨勢」与日文共用，只有简体「趋势」可作这里的中文证据；不能把任意纯 Han 或页面 lang 当作证据。
const sharedChineseEvidencePattern = /新增|不再|允[许許]|[你您]好|[谢謝]{2}|登[录錄入]|用[户戶]|[邮郵]箱|[关關]注|趋势|[条條]款|[隐隱]私|[浏瀏][览覽]器|[页頁]面|[储儲]存/u;

export function hasSimplifiedChineseEvidence(value: string): boolean {
    return simplifiedChineseOnlyPattern.test(value);
}

export function hasTraditionalChineseEvidence(value: string): boolean {
    return traditionalChineseEvidencePattern.test(value);
}

/**
 * 只分析汉字：返回明确的简体/繁体、简繁同形中文（shared）或未知。调用方必须事先排除外语正文、
 * 假名、谚文及其他文字；这里不会把「日本国立大学」这类只含共享汉字的文本当成中文。
 */
export function classifyChineseHan(value: string): ChineseScript | 'shared' | undefined {
    if (cantoneseMarkerPattern.test(value)) return undefined;
    if ([...value].some((character) => hanPattern.test(character)
        && !commonHanPattern.test(character) && !variantCharacters.has(character))) {
        return undefined;
    }
    const hasHans = simplifiedScriptPattern.test(value);
    const hasHant = traditionalScriptPattern.test(value);
    if (!hasHans && !hasHant) return sharedChineseEvidencePattern.test(value) ? 'shared' : undefined;
    if (hasHans && hasHant) return undefined;
    const hasChineseEvidence = sharedChineseEvidencePattern.test(value)
        || (hasHans ? simplifiedChineseEvidencePattern : traditionalChineseEvidencePattern).test(value);
    if (!hasChineseEvidence) return undefined;
    return hasHans ? 'Hans' : 'Hant';
}
