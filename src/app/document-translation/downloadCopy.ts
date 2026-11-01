/**
 * @file src/app/document-translation/downloadCopy.ts
 * 文件职责：提供文档下载窗口专属的七语言文案，并沿用共享界面语言归一化规则。
 * 主要内容：紧凑下载窗口的内容、排版和文件名标签，保存原文件与翻译结果的状态文案，以及下载失败的操作提示；技术异常不直接作为主提示，未知语言回退简体中文。
 * 模块边界：仅由独立文档页面加载，不注册或修改全局语言包，不进入网页翻译及 userscript 的共享资源。
 */
import {normalizeUiLanguage} from '@/src/core/i18n/language';

const messages = {
    "zh-CN": {
        "moreOptions": "更多选项",
        "pageCount": "至少 {count} 页",
        "title": "下载文件",
        "contentLabel": "下载内容",
        "layoutLabel": "PDF 排版",
        "fileLabel": "文件名",
        "previewLabel": "预览内容",
        "close": "关闭下载窗口",
        "failed": "未能生成文件。请重试，或先下载原文。",
        "protectedFailed": "此文件受保护，当前方式无法导出。可先下载原文。",
        "details": "技术详情",
        "contentHint": "保存原文，或按原格式下载包含校订的翻译结果。",
        "original": "下载原文",
        "originalHint": "保留原文件，不包含翻译或校订。",
        "originalDownloaded": "原文件已开始下载，请在浏览器下载列表中查看。",
        "translationRequired": "翻译后可下载双语或译文文件。"
    },
    "en-US": {
        "moreOptions": "More options",
        "pageCount": "At least {count} pages",
        "title": "Download file",
        "contentLabel": "Content",
        "layoutLabel": "PDF layout",
        "fileLabel": "File name",
        "previewLabel": "Preview content",
        "close": "Close download dialog",
        "failed": "Could not create the file. Try again or download the original.",
        "protectedFailed": "This file is protected and cannot be exported this way. You can download the original.",
        "details": "Technical details",
        "contentHint": "Save the original or download the translation with your edits in the original format.",
        "original": "Download original",
        "originalHint": "Keeps the original file without translation or edits.",
        "originalDownloaded": "Original download started. Check your browser's downloads.",
        "translationRequired": "Translate first to download a bilingual or translated file."
    },
    "ja-JP": {
        "moreOptions": "その他のオプション",
        "pageCount": "少なくとも {count} ページ",
        "title": "ファイルをダウンロード",
        "contentLabel": "内容",
        "layoutLabel": "PDF レイアウト",
        "fileLabel": "ファイル名",
        "previewLabel": "内容をプレビュー",
        "close": "ダウンロード画面を閉じる",
        "failed": "ファイルを作成できませんでした。再試行するか、原本をダウンロードしてください。",
        "protectedFailed": "このファイルは保護されているため、この方法では書き出せません。原本をダウンロードできます。",
        "details": "技術的な詳細",
        "contentHint": "原本を保存するか、修正を含む翻訳結果を元の形式でダウンロードできます。",
        "original": "原本をダウンロード",
        "originalHint": "翻訳や修正を含めず、元のファイルを保存します。",
        "originalDownloaded": "原本のダウンロードを開始しました。ブラウザーのダウンロード一覧をご確認ください。",
        "translationRequired": "翻訳後、対訳または訳文のファイルをダウンロードできます。"
    },
    "ko-KR": {
        "moreOptions": "추가 옵션",
        "pageCount": "최소 {count}페이지",
        "title": "파일 다운로드",
        "contentLabel": "다운로드 내용",
        "layoutLabel": "PDF 레이아웃",
        "fileLabel": "파일 이름",
        "previewLabel": "내용 미리 보기",
        "close": "다운로드 창 닫기",
        "failed": "파일을 생성하지 못했습니다. 다시 시도하거나 원본을 다운로드하세요.",
        "protectedFailed": "보호된 파일이라 이 방식으로 내보낼 수 없습니다. 원본을 다운로드할 수 있습니다.",
        "details": "기술 세부 정보",
        "contentHint": "원본을 저장하거나 수정 사항이 포함된 번역 결과를 원래 형식으로 다운로드하세요.",
        "original": "원본 다운로드",
        "originalHint": "번역이나 수정 없이 원본 파일을 보존합니다.",
        "originalDownloaded": "원본 파일 다운로드를 시작했습니다. 브라우저의 다운로드 목록을 확인하세요.",
        "translationRequired": "번역 후 이중 언어 또는 번역문 파일을 다운로드할 수 있습니다."
    },
    "fr-FR": {
        "moreOptions": "Plus d’options",
        "pageCount": "Au moins {count} pages",
        "title": "Télécharger le fichier",
        "contentLabel": "Contenu",
        "layoutLabel": "Mise en page PDF",
        "fileLabel": "Nom du fichier",
        "previewLabel": "Aperçu du contenu",
        "close": "Fermer le téléchargement",
        "failed": "Impossible de créer le fichier. Réessayez ou téléchargez l’original.",
        "protectedFailed": "Ce fichier est protégé et ne peut pas être exporté ainsi. Vous pouvez télécharger l’original.",
        "details": "Détails techniques",
        "contentHint": "Enregistrez l’original ou téléchargez la traduction avec vos corrections dans le format d’origine.",
        "original": "Télécharger l’original",
        "originalHint": "Conserve le fichier d’origine sans traduction ni corrections.",
        "originalDownloaded": "Téléchargement de l’original lancé. Consultez les téléchargements de votre navigateur.",
        "translationRequired": "Traduisez d’abord pour télécharger un fichier bilingue ou traduit."
    },
    "es-ES": {
        "moreOptions": "Más opciones",
        "pageCount": "Al menos {count} páginas",
        "title": "Descargar archivo",
        "contentLabel": "Contenido",
        "layoutLabel": "Diseño del PDF",
        "fileLabel": "Nombre del archivo",
        "previewLabel": "Vista previa",
        "close": "Cerrar descarga",
        "failed": "No se pudo crear el archivo. Inténtalo de nuevo o descarga el original.",
        "protectedFailed": "Este archivo está protegido y no se puede exportar así. Puedes descargar el original.",
        "details": "Detalles técnicos",
        "contentHint": "Guarda el original o descarga la traducción con tus correcciones en el formato original.",
        "original": "Descargar original",
        "originalHint": "Conserva el archivo original sin traducción ni correcciones.",
        "originalDownloaded": "Se ha iniciado la descarga del original. Revisa las descargas de tu navegador.",
        "translationRequired": "Traduce primero para descargar un archivo bilingüe o traducido."
    },
    "ru-RU": {
        "moreOptions": "Другие параметры",
        "pageCount": "Не менее {count} стр.",
        "title": "Скачать файл",
        "contentLabel": "Содержимое",
        "layoutLabel": "Макет PDF",
        "fileLabel": "Имя файла",
        "previewLabel": "Предпросмотр",
        "close": "Закрыть окно загрузки",
        "failed": "Не удалось создать файл. Повторите попытку или скачайте оригинал.",
        "protectedFailed": "Этот файл защищён и не может быть экспортирован этим способом. Можно скачать оригинал.",
        "details": "Технические сведения",
        "contentHint": "Сохраните оригинал или скачайте перевод с вашими правками в исходном формате.",
        "original": "Скачать оригинал",
        "originalHint": "Сохраняет исходный файл без перевода и правок.",
        "originalDownloaded": "Загрузка исходного файла началась. Проверьте список загрузок браузера.",
        "translationRequired": "Сначала переведите документ, чтобы скачать двуязычный файл или перевод."
    }
};

export function getDocumentDownloadCopy(language: unknown): typeof messages['zh-CN'] {
    return messages[normalizeUiLanguage(language)];
}

/** 下载失败先给出可执行的本地化提示；原始异常由调用方保留在可展开的技术详情中。 */
export function getDocumentDownloadErrorCopy(language: unknown, error: string): string {
    const copy = getDocumentDownloadCopy(language);
    return /\bencrypted\b/iu.test(error) ? copy.protectedFailed : copy.failed;
}
