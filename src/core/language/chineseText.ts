/**
 * @file src/core/language/chineseText.ts
 *
 * 文件职责：以保守字形与中文词语证据区分简体、繁体、简繁同形和未知的纯汉字正文，供统一语言识别器使用。
 * 主要内容：按原顺序构造可逐对审核的简繁冲突表与 Unicode 简繁专属字数据证据，排除简繁混排、罕见扩展字和粤语口语；组合中文操作词、状态词、请求句架及有界的人称情态、条件关联、时态、补语和示例引导句关系，补足短界面及自然中文正文的语境证据，同时保持字形和语言证据分离；导出 classifyChineseHan、hasSimplifiedChineseEvidence、hasTraditionalChineseEvidence 与供中文目标段落跳过使用的 hasOppositeChineseScriptForms，并保留日文、韩文排除中文语境所需的字形规则。
 * 模块边界：本文件属于 core 纯文本算法，只接受调用方已排除其他文字的汉字正文；不处理语言标签、不转换原文、不猜测地区或方言，不读取配置、页面、浏览器、网络或翻译服务。ChineseScript 仅作类型依赖，配置与纯标签消费者无需加载字符表和本模块。
 */

import type {ChineseScript} from './chinese';
import {simplifiedOnlyCharacters, traditionalOnlyCharacters, simplifiedChineseEvidenceCharacters} from './chineseVariants';

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
齿齒 龟龜 与與 两兩 猫貓 数數 确確 来來
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
// 「起来」等词语只作为中文语境证据；「出来る」「出来高」是常见日文，不能借「出来」确认中文。
const simplifiedChineseEvidencePattern = new RegExp(`[${simplifiedChineseOnlyCharacters}]|[起下]来`, 'u');
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

// 「保存」「設定」「更新」「複製」本身也可能是日文，不能直接当成中文证据。
// 使用中文的操作词及“请 + 动作”“已/正在 + 状态”等组合；这里只确认语言，简繁仍由字形冲突表决定。
// 不收录品牌、产品或模型名称，未知技术名称也不能凭本表获得中文归属。
const chineseInterfaceEvidencePattern = /确定|[上下]一步|登出|安[装裝]|启用|啟用|[上下][载載]|密[码碼]|[讯訊]息|[选選][单單]|(?:已(?:经|經)?|尚未|正在)(?:完成|保存|更新|[复複][制製]|安[装裝]|[连連]接|[启啟]用|[关關][闭閉])|[请請](?:稍候|重[试試]|[选選][择擇]|使用|[开開][启啟]|[设設](?:置|定)|安[装裝]|[启啟]用|[关關][闭閉])|您的/u;

// 语法标记必须与主语、谓语或另一关联词组合。变量区只接受至多 24 个连续汉字，
// 不跨完整句子寻找关系；固定上限使长文扫描有界，单个「我」「了」「先」不能确认中文。
const chinesePronounPredicatePattern = /(?:[我你他她您它](?:[们們])?|大家)(?:也|都|[还還]|就)?(?:可以|不能|不要|需要|希望|想要|打算|[应應][该該]|[想先再把])\p{Script=Han}{2,24}/u;
const chineseRequestDisposalPattern = /[请請](?:把|[将將]|先|再|不要)\p{Script=Han}{2,24}/u;
const chineseAspectPredicatePattern = /(?:已[经經]|[还還][没沒])\p{Script=Han}{2,24}/u;
const chineseConditionalPattern = /(?:如果|要是|只要)\p{Script=Han}{1,24}(?:[，,]\p{Script=Han}{0,8})?(?:就|才|可以)\p{Script=Han}{1,24}/u;
// 「被害」「被請求者」可属日文；被动式额外要求施事也有人称证据，并以「所」连接谓语。
const chinesePassiveAgentPattern = /(?:[我你他她您它](?:[们們])?|大家)被(?:[我你他她您它](?:[们們])?|大家)(?:的\p{Script=Han}{1,8})?所\p{Script=Han}{1,8}/u;
// 完成体须有人称和基本动作，不能因日文「作業完了」「使用完了」中的「了」便确认中文。
// 「出来/出來」亦见于日文「出来高」等词，泛化补语只接纳前有谓语的「起来/起來」。
const chineseCompletedActionPattern = /(?:[我你他她您它](?:[们們])?|大家)(?:都|也)?(?:看|吃|喝|走|睡|拿|放|收|做|交|借|忘|找|用|到|等|算|[听聽读讀买買卖賣])\p{Script=Han}{0,8}了/u;
const chineseDirectionalComplementPattern = /\p{Script=Han}{1,12}起[来來]/u;
// 「以下」「基本」「一個」也见于日文，只有完整的中文系词与量词关系提供证据；
// 宾语必须完整落在 1–24 个连续汉字内，不跨行、标点或外语拼出句架。
const chineseExampleIntroductionPattern = /(?:下面|以下)是一[个個]\p{Script=Han}{1,24}(?!\p{Script=Han})/u;

function hasChineseGrammarEvidence(value: string): boolean {
    return chinesePronounPredicatePattern.test(value)
        || chineseRequestDisposalPattern.test(value)
        || chineseAspectPredicatePattern.test(value)
        || chineseConditionalPattern.test(value)
        || chinesePassiveAgentPattern.test(value)
        || chineseCompletedActionPattern.test(value)
        || chineseDirectionalComplementPattern.test(value)
        || chineseExampleIntroductionPattern.test(value);
}

export function hasSimplifiedChineseEvidence(value: string): boolean {
    return simplifiedChineseOnlyPattern.test(value)
        || chineseInterfaceEvidencePattern.test(value) && simplifiedScriptPattern.test(value);
}

/**
 * 段落正文是否出现与指定书写体系相反的专属字形。只看字形证据、不要求词语或语法证据，
 * 供中文目标的全文段落跳过判断保留简繁转换：简体目标下出现繁体专属字形的段落仍可请求
 * 翻译，反之亦然。本函数不改变原文、不识别语言，也不访问配置、页面或网络。
 */
export function hasOppositeChineseScriptForms(value: string, script: ChineseScript): boolean {
    return script === 'Hans'
        ? traditionalScriptPattern.test(value)
        : simplifiedScriptPattern.test(value);
}

export function hasTraditionalChineseEvidence(value: string): boolean {
    return traditionalChineseEvidencePattern.test(value)
        || chineseInterfaceEvidencePattern.test(value) && traditionalScriptPattern.test(value);
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
    const hasPhraseEvidence = sharedChineseEvidencePattern.test(value) || chineseInterfaceEvidencePattern.test(value)
        || hasChineseGrammarEvidence(value);
    if (!hasHans && !hasHant) return hasPhraseEvidence ? 'shared' : undefined;
    if (hasHans && hasHant) return undefined;
    const hasChineseEvidence = hasPhraseEvidence
        || (hasHans ? simplifiedChineseEvidencePattern : traditionalChineseEvidencePattern).test(value);
    if (!hasChineseEvidence) return undefined;
    return hasHans ? 'Hans' : 'Hant';
}
