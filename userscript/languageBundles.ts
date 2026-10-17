/**
 * @file userscript/languageBundles.ts
 * 文件职责：在构建期保留 userscript 可呈现的界面文案，维持已发布语言资源的固定内容。
 * 主要内容：剔除没有扩展 popup 和本地模型后端的信息高亮文案、没有原生右键菜单发送者的操作失败通知，以及没有视频字幕运行时的完整句学习及原生全屏提示文案、Safari 原生免费池授权提示、扩展 Popup 专用缩写和新增文档页的配置读取、进度、续译与旧校订文案；已发布远程词典中的旧文档键保留原内容。脚本内联动态模块与样式，五种固定远程词典不新增扩展分块加载失败、AI 翻译超时或 DeepLX 直连文案，注册时由脚本补齐；局部划选同样在注册时更新文案，远端词典保留此前的点选提示；中英内嵌词典保留可用页面的新文案。
 * 集成兼容：扩展专用诊断、新移动端字幕贴底标签与新PDF弹窗不进入脚本词典；五种远程资源中的旧导出说明保留已发布文本，尚无脚本后台支持的材料旧文案与模板也从内嵌英文按目录排除，保留实际可用功能文案并避免固定提交引用不存在的新摘要。
 * 模块边界：只投影静态字典，不改变扩展词典、资源提交号或运行时语言装载协议。
 */
import {UI_LANGUAGE_BUNDLES as extensionBundles} from '../src/core/i18n/bundles';
import {zhCNMessages as extensionChinese} from '../src/core/i18n/messages/zh-CN';
import {learningMaterialLegacyText, learningMaterialPatterns} from '../src/core/i18n/messages/learningMaterials';
import type {UiLanguageBundle} from '../src/core/i18n/types';

const materialPatternSources = new Set(learningMaterialPatterns.map(({pattern}) => pattern));
const publishedSectionMessages: Readonly<Record<string, Record<string, string>>> = {
    "ja-JP": {
        "sectionTranslation.picker.preview": "マウスを動かしてプレビュー、クリックで選択",
        "popup.sectionTranslationTitle": "部分翻訳：マウスでプレビュー、クリックで選択、確定して翻訳",
        "sectionTranslation.picker.instruction": "クリックして翻訳したい範囲を選択"
    },
    "ko-KR": {
        "sectionTranslation.picker.preview": "마우스를 움직여 미리 보고 클릭하여 선택하세요",
        "popup.sectionTranslationTitle": "부분 번역: 마우스로 미리 보고 클릭하여 선택한 뒤 확인하면 번역합니다",
        "sectionTranslation.picker.instruction": "클릭하여 번역할 영역을 선택하세요"
    },
    "fr-FR": {
        "sectionTranslation.picker.preview": "Déplacez la souris pour prévisualiser, cliquez pour sélectionner",
        "popup.sectionTranslationTitle": "Traduction partielle : survolez pour prévisualiser, cliquez pour sélectionner, puis confirmez pour traduire",
        "sectionTranslation.picker.instruction": "Cliquez pour sélectionner la zone de la page à traduire"
    },
    "ru-RU": {
        "sectionTranslation.picker.preview": "Наведите курсор для предпросмотра, нажмите для выбора",
        "popup.sectionTranslationTitle": "Перевод фрагмента: наведите курсор для предпросмотра, нажмите для выбора и подтвердите перевод",
        "sectionTranslation.picker.instruction": "Нажмите, чтобы выбрать фрагмент страницы для перевода"
    },
    "es-ES": {
        "sectionTranslation.picker.preview": "Mueve el ratón para previsualizar; haz clic para seleccionar",
        "popup.sectionTranslationTitle": "Traducción parcial: pasa el ratón para previsualizar, haz clic para seleccionar y confirma para traducir",
        "sectionTranslation.picker.instruction": "Haz clic para seleccionar la zona de la página que quieres traducir"
    }
};

// 五种远端资源仍由原固定提交提供；新的 DeepLX 路由说明随脚本注册时覆盖。
const publishedDeepLXEndpointHelp: Readonly<Record<string, string>> = {
    'ja-JP': '翻訳 API の完全な URL（通常は /translate で終わる）を入力します。パスは自動追加されません。空欄では既定の公開 API を使用します。',
    'ko-KR': '전체 번역 API 주소를 입력하세요(보통 /translate로 끝남). 경로는 자동으로 추가되지 않습니다. 비워 두면 기본 공개 API를 사용합니다.',
    'fr-FR': 'Saisissez l’adresse complète de traduction (se terminant généralement par /translate). Le chemin n’est pas ajouté automatiquement. Laissez vide pour utiliser le service public par défaut.',
    'ru-RU': 'Введите полный адрес API перевода (обычно заканчивается на /translate). Путь не добавляется автоматически. Пустое поле означает публичный API по умолчанию.',
    'es-ES': 'Introduce la dirección completa de traducción (normalmente termina en /translate). La ruta no se añade automáticamente. Déjala vacía para usar el servicio público predeterminado.',
};

// 文档阅读器仅存在于扩展中；固定远程词典继续使用发布时的三个导出说明。
const publishedPdfExportMessages: Readonly<Record<string, Record<string, string>>> = {
    "ja-JP": {
        "document.pdfReading.exportHint": "元のレイアウト・数式・図を保持します。長い訳文の全文は PDF の注釈に保存されます。訳文ページは画像です。",
        "document.pdfReading.layoutExportHint": "各ページが同じ原文ページに対応し、順番を保持します。",
        "document.pdfReading.exportPageCount": "{count} ページ · 元のレイアウト"
    },
    "ko-KR": {
        "document.pdfReading.exportHint": "원본 배치, 수식, 그림을 유지합니다. 긴 번역 전문은 PDF 주석에 저장되며 번역 페이지는 이미지입니다.",
        "document.pdfReading.layoutExportHint": "각 페이지가 같은 원문 페이지에 대응하며 순서를 유지합니다.",
        "document.pdfReading.exportPageCount": "{count}페이지 · 원본 레이아웃"
    },
    "fr-FR": {
        "document.pdfReading.exportHint": "Conserve la mise en page, les formules et les figures. Les commentaires PDF contiennent les passages longs en entier ; les pages traduites sont des images.",
        "document.pdfReading.layoutExportHint": "Chaque page correspond à la même page originale, dans le même ordre.",
        "document.pdfReading.exportPageCount": "{count} pages · Mise en page originale"
    },
    "es-ES": {
        "document.pdfReading.exportHint": "Conserva el diseño, las fórmulas y las figuras. Los comentarios PDF incluyen los pasajes largos completos; las páginas traducidas son imágenes.",
        "document.pdfReading.layoutExportHint": "Cada página corresponde a la misma página original y mantiene el orden.",
        "document.pdfReading.exportPageCount": "{count} páginas · Diseño original"
    },
    "ru-RU": {
        "document.pdfReading.exportHint": "Сохраняет макет, формулы и рисунки. Полный текст длинных фрагментов хранится в комментариях PDF; переведённые страницы являются изображениями.",
        "document.pdfReading.layoutExportHint": "Каждая страница соответствует той же исходной странице с сохранением порядка.",
        "document.pdfReading.exportPageCount": "{count} страниц · Исходный макет"
    }
};

export function userscriptMessages<T extends Record<string, string>>(messages: T): T {
    return Object.fromEntries(Object.entries(messages).filter(([key]) => !key.startsWith('informationHighlight.')
        && !key.startsWith('contextMenu.notice.') && !key.startsWith('video.learning.')
        && key !== 'video.nativeFullscreenHint'
        && !key.startsWith('diagnostics.')
        && !['waitingTranslation', 'crossPageContext', 'fullPassage', 'closePassage'].some(name => key === `document.pdfReading.${name}`)
        && !key.startsWith('safari.freePool.')
        && !key.startsWith('popup.compact.') && !key.startsWith('document.config.')
        && !key.startsWith('document.translationRecovery.')
        && !key.startsWith('document.retainedRevisions.') && !key.startsWith('document.translationProgress.'))) as T;
}
export const zhCNMessages = userscriptMessages(extensionChinese);
export const UI_LANGUAGE_BUNDLES = Object.fromEntries(Object.entries(extensionBundles).map(([language, bundle]): [string, UiLanguageBundle] => {
    const messages: Record<string, string> = userscriptMessages(bundle.messages);
    // 材料目录和移动端字幕标签仅供扩展使用；英文内嵌/远程资源按同一能力边界裁剪，不改既有词条或顺序。
    const materialSources = new Set(Object.keys(learningMaterialLegacyText[language as keyof typeof learningMaterialLegacyText]));
    const legacyText = Object.fromEntries(Object.entries(bundle.legacyText).filter(([source]) => !materialSources.has(source) && source !== '移动端 / X 自动贴底'));
    const legacyPatterns = {
        early: bundle.legacyPatterns.early.filter(([source]) => !materialPatternSources.has(source)),
        late: bundle.legacyPatterns.late.filter(([source]) => !materialPatternSources.has(source)),
    };
    if (language !== 'en-US') {
        // 划选文案在注册时覆盖，继续引用已发布的同一份远程词典。
        Object.assign(messages, publishedSectionMessages[language], publishedPdfExportMessages[language]);
        messages['settings.services.deeplx.endpointHelp'] = publishedDeepLXEndpointHelp[language]!;
        delete messages['settings.services.deeplx.defaultRoute'];
        delete messages['sectionTranslation.picker.dragging'];
        delete messages['sectionTranslation.scope.selected'];
        delete messages['learning.panelLoadError'];
        delete messages['learning.reloadPage'];
        // 新超时文案随脚本注册补齐，保持已发布远端资源的内容摘要与固定提交号。
        delete messages['settings.requestLimits.aiTimeout'];
        delete messages['settings.requestLimits.aiTimeoutHelp'];
        delete messages['settings.requestLimits.seconds'];
    }
    return [language, {...bundle, messages, legacyText, legacyPatterns}];
})) as typeof extensionBundles;
